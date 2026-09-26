// Deterministic stack checker: given boards (as stored in Sanity) and a Pi SoC, find what collides.
// The agent never decides compatibility itself; it calls this and explains the result.

export type Soc = 'bcm2835' | 'bcm2711' | 'rp1'
export type PinUse = {physical: number; role: string; signal?: string | null}
export type I2cDevice = {address: string; alternates?: string[] | null; device?: string | null; label?: string | null}
export type Board = {
  slug: string
  name: string
  formFactor?: string | null
  headerPins?: number | null
  idEeprom?: string | null
  pins?: PinUse[] | null
  i2cDevices?: I2cDevice[] | null
}
export type HeaderPin = {physical: number; label: string; bcm?: number | null; functions?: Partial<Record<Soc, string[]>> | null}

export type Issue = {
  kind: 'pin' | 'i2c' | 'eeprom' | 'function'
  severity: 'conflict' | 'fixable' | 'warning'
  boards: string[]
  pin?: number
  address?: string
  detail: string
  fix?: string
}
export type StackReport = {
  verdict: 'stacks' | 'stacks-with-changes' | 'conflicts' | 'incomplete'
  soc: Soc
  boards: string[]
  pins: {physical: number; users: {board: string; role: string; signal?: string | null}[]; state: 'shared' | 'exclusive' | 'conflict'}[]
  i2c: {address: string; board: string; device?: string | null; state: 'ok' | 'conflict' | 'fixable'}[]
  issues: Issue[]
  notes: string[]
}

// Roles that are buses by design: several boards may sit on them at once.
const SHARED = new Set(['i2c', 'spi', '1-wire', 'power-5v', 'power-3v3', 'ground'])
// Hardware function a pin needs (on this SoC) for a role. Chip selects are left out: any GPIO can be one.
const NEEDS: Record<string, RegExp> = {i2c: /I2C/, spi: /SPI/, i2s: /PCM|I2S/, uart: /UART/, pwm: /PWM/}
const HAS_EEPROM = new Set(['yes', 'setup', 'detect'])

// `missing` lists boards that were asked about but aren't in the data: the result can't confirm those.
export function checkStack(boards: Board[], soc: Soc, header: HeaderPin[] = [], missing: string[] = []): StackReport {
  const issues: Issue[] = []
  const notes: string[] = []
  const byPin = new Map<number, {board: string; role: string; signal?: string | null}[]>()
  for (const b of boards) for (const p of b.pins ?? []) byPin.set(p.physical, [...(byPin.get(p.physical) ?? []), {board: b.name, role: p.role, signal: p.signal}])

  const pins = [...byPin.entries()]
    .sort(([a], [b]) => a - b)
    .map(([physical, users]) => {
      const owners = new Set(users.map((u) => u.board))
      const roles = new Set(users.map((u) => u.role))
      const shared = roles.size === 1 && SHARED.has(users[0].role)
      const state: 'shared' | 'exclusive' | 'conflict' = owners.size < 2 ? 'exclusive' : shared ? 'shared' : 'conflict'
      if (state === 'conflict') {
        const eeprom = physical === 27 || physical === 28
        issues.push({
          kind: eeprom ? 'eeprom' : 'pin',
          severity: 'conflict',
          boards: [...owners],
          pin: physical,
          detail: users.map((u) => `${u.board} uses it as ${u.role}${u.signal ? ` (${u.signal})` : ''}`).join('; '),
        })
      }
      return {physical, users, state}
    })

  // I2C: devices on the shared bus collide only when two boards answer at the same address.
  const i2c: StackReport['i2c'] = []
  const byAddr = new Map<string, {board: Board; dev: I2cDevice}[]>()
  for (const board of boards) for (const dev of board.i2cDevices ?? []) byAddr.set(dev.address, [...(byAddr.get(dev.address) ?? []), {board, dev}])
  const taken = new Set(byAddr.keys())
  const free = (d: {dev: I2cDevice}) => (d.dev.alternates ?? []).filter((a) => !taken.has(a))
  const label = (d: {board: Board; dev: I2cDevice}) => `${d.board.name}'s ${d.dev.device ?? d.dev.label ?? 'device'}`
  for (const [address, devs] of [...byAddr.entries()].sort()) {
    let state: 'ok' | 'conflict' | 'fixable' = 'ok'
    if (new Set(devs.map((d) => d.board.slug)).size > 1) {
      // Every board but one has to move its device off this address. The least movable one stays.
      // ponytail: greedy assignment; a bipartite matching could find moves greedy misses when alternates overlap across addresses.
      const [stay, ...others] = [...devs].sort((a, b) => free(a).length - free(b).length)
      const moves: string[] = []
      const stuck: string[] = []
      for (const d of others.filter((d) => d.board.slug !== stay.board.slug)) {
        const to = free(d)[0]
        if (to) {
          taken.add(to)
          moves.push(`move ${label(d)} to ${to}`)
        } else stuck.push(label(d))
      }
      state = stuck.length ? 'conflict' : 'fixable'
      issues.push({
        kind: 'i2c',
        severity: state,
        boards: devs.map((d) => d.board.name),
        address,
        detail: devs.map(label).join(' vs ') + ` at ${address}`,
        ...(stuck.length
          ? {fix: `${stuck.join(' and ')} ${stuck.length > 1 ? 'have' : 'has'} no free alternate address, so ${address} stays contested${moves.length ? ` even if you ${moves.join(' and ')}` : ''}. An I2C multiplexer is the usual way out.`}
          : {fix: `${moves.join(' and ')} (listed as alternate addresses); ${label(stay)} keeps ${address}.`.replace(/^m/, 'M')}),
      })
    }
    for (const d of devs) i2c.push({address, board: d.board.name, device: d.dev.device, state})
  }

  // HAT ID EEPROM: only one board's EEPROM can be read at boot, even if the pin table doesn't list 27/28.
  const eepromBoards = boards.filter((b) => HAS_EEPROM.has(b.idEeprom ?? ''))
  if (eepromBoards.length > 1 && !issues.some((i) => i.kind === 'eeprom')) {
    issues.push({kind: 'eeprom', severity: 'warning', boards: eepromBoards.map((b) => b.name), detail: 'More than one board carries a HAT ID EEPROM on the ID_SD/ID_SC pins (27/28); only one can be probed at boot.'})
  }

  // Can this SoC actually do what each board asks of each pin?
  const headerByPin = new Map(header.map((h) => [h.physical, h]))
  for (const b of boards) {
    for (const p of b.pins ?? []) {
      const need = NEEDS[p.role]
      const fns = headerByPin.get(p.physical)?.functions?.[soc]
      if (need && fns && !fns.some((f) => need.test(f))) {
        issues.push({kind: 'function', severity: 'warning', boards: [b.name], pin: p.physical, detail: `${b.name} uses pin ${p.physical} as ${p.role}, which is not a hardware ${p.role} pin on ${soc} (${fns.join(', ')}). The board may drive it in software, or its pinout.xyz record may be wrong.`})
      }
    }
  }

  const fullSize = boards.filter((b) => (b.formFactor === 'HAT' || b.formFactor === 'pHAT') && (b.headerPins ?? 40) >= 40)
  if (fullSize.length > 1) notes.push(`${fullSize.map((b) => b.name).join(fullSize.length === 2 ? ' and ' : ', ')} use the full 40-pin header, so physically stacking them needs a stacking header, extender or splitter.`)
  const noPins = boards.filter((b) => !(b.pins ?? []).length)
  if (noPins.length) notes.push(`No pin data recorded for ${noPins.map((b) => b.name).join(', ')}.`)
  if (missing.length) notes.push(`Not in the data: ${missing.join(', ')}.`)

  // A conflict among the boards we do know is still worth reporting; otherwise never confirm a partial stack.
  const hard = issues.some((i) => i.severity === 'conflict')
  const incomplete = !boards.length || missing.length > 0 || noPins.length > 0
  const fixable = issues.some((i) => i.severity === 'fixable')
  const verdict = hard ? 'conflicts' : incomplete ? 'incomplete' : fixable ? 'stacks-with-changes' : 'stacks'
  return {verdict, soc, boards: boards.map((b) => b.name), pins, i2c, issues, notes}
}
