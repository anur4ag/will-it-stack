// Imports pinout.xyz board overlays + Raspberry Pi docs into the Sanity dataset.
// Usage: PINOUT_DIR=… RPIDOCS_DIR=… npm run import   (needs SANITY_DEV_TOKEN in .env.local)
import {readFileSync, readdirSync, realpathSync} from 'node:fs'
import {basename, join} from 'node:path'
import {execSync} from 'node:child_process'
import {parse} from 'yaml'
import {createClient} from 'next-sanity'

const PINOUT = process.env.PINOUT_DIR!
const RPIDOCS = process.env.RPIDOCS_DIR!
const head = (dir: string) => execSync('git rev-parse HEAD', {cwd: dir}).toString().trim()
const pinoutCommit = head(PINOUT)
const docsCommit = head(RPIDOCS)
const CC = 'CC BY-SA 4.0'

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
const hex = (a: unknown) => {
  // YAML reads unquoted 0x68 as the integer 104.
  const n = typeof a === 'number' ? a : parseInt(String(a), 16)
  return '0x' + n.toString(16).padStart(2, '0')
}

// ---- pins -----------------------------------------------------------------
const tmpl = parse(readFileSync(join(PINOUT, 'src/en/template/pinout.yaml'), 'utf8')).pins as Record<string, any>
const fns = parse(readFileSync(join(PINOUT, 'common/pin-functions.yaml'), 'utf8')).functions as Record<string, Record<string, string[]>>
const pinNote = (n: number) => {
  try {
    return readFileSync(realpathSync(join(PINOUT, `src/en/pin/pin-${n}.md`)), 'utf8').trim()
  } catch {
    return undefined
  }
}
const kindOf = (t: string) => (t === '+5v' ? '5v' : t === '+3v3' ? '3v3' : t === 'GND' ? 'ground' : 'gpio')
const pins = Object.entries(tmpl).map(([n, p]) => {
  const physical = Number(n)
  const bcm = p.scheme?.bcm as number | undefined
  const kind = kindOf(p.type)
  const label = kind === 'gpio' ? `GPIO ${bcm}${p.name ? ` (${p.name})` : ''}` : p.name
  return {
    _id: `pin-${physical}`,
    _type: 'pin',
    physical,
    label,
    kind,
    ...(bcm !== undefined && {
      bcm,
      functions: Object.fromEntries(['bcm2835', 'bcm2711', 'rp1'].map((soc) => [soc, (fns[soc]?.[String(bcm)] ?? []).filter(Boolean)])),
    }),
    notes: pinNote(physical),
    source: {url: `https://pinout.xyz/pinout/pin${physical}`, repo: 'pinout-xyz/Pinout.xyz', path: 'src/en/template/pinout.yaml', commit: pinoutCommit, license: CC},
  }
})

// ---- boards and pinout.xyz interface pages --------------------------------
const physicalOfBcm = new Map(pins.filter((p) => p.bcm !== undefined).map((p) => [p.bcm, p.physical]))
const warnings: string[] = []
const toPhysical = (key: string, file: string) => {
  // Most overlays key pins by physical number; a few use "bcm17".
  const n = /^\d+$/.test(key) ? Number(key) : physicalOfBcm.get(Number(key.match(/^bcm(\d+)$/i)?.[1]))
  if (!n) warnings.push(`${file}: ignored non-pin key "${key}" (upstream YAML indentation?)`)
  return n
}
const SPI_BUS = new Set([19, 21, 23, 35, 38, 40]) // MOSI/MISO/SCLK of SPI0 and SPI1
// Some overlays omit `mode` but name the signal ("I2S", "TXD / Transmit"). Infer the bus from the name,
// but only on that bus's own hardware pins, so bit-banged or switchable pins stay plain GPIO.
const BY_NAME: [RegExp, string, number[] | null][] = [
  [/\bi2s\b|\bpcm\b/i, 'i2s', [12, 35, 38, 40]],
  [/1-?wire/i, '1-wire', null],
  [/\b(txd?|rxd?)\b|uart/i, 'uart', [8, 10]],
  [/mosi|miso|sclk|\bdin\b/i, 'spi', [19, 21, 23, 35, 38, 40]],
  [/\bcs\b|\bce[01]\b/i, 'spi-cs', [24, 26]],
  [/\bsda\b|\bscl\b|i2c/i, 'i2c', [3, 5]],
]
const roleOf = (physical: number, mode: string | undefined, name?: string): string => {
  if (!mode && name) {
    const hit = BY_NAME.find(([re, , pins]) => re.test(name) && (!pins || pins.includes(physical)))
    if (hit) return hit[1]
  }
  switch (mode) {
    case 'i2c':
      return physical === 27 || physical === 28 ? 'eeprom' : 'i2c'
    case 'spi':
      return SPI_BUS.has(physical) ? 'spi' : 'spi-cs'
    case 'chipselect':
      return 'spi-cs'
    case 'i2s':
    case 'pcm':
      return 'i2s'
    case 'uart':
    case 'pwm':
    case '1-wire':
      return mode
    case 'input':
      return 'gpio-in'
    case 'output':
    case 'eeprom_wp':
      return 'gpio-out'
    default:
      return 'gpio'
  }
}
// Known upstream data errors, fixed here and listed in the README.
const FIXES: Record<string, (d: Record<string, any>) => void> = {
  // `mode: spi` for pin 23 is indented one level too shallow, so YAML attaches it to the pin map.
  'pi-supply-iot-lora-gateway-hat.md': (d) => {
    d.pin['23'] = {mode: d.pin.mode}
    delete d.pin.mode
  },
}
const eepromOf = (e: unknown) => (e === true ? 'yes' : e === false ? 'no' : typeof e === 'string' ? e : 'unknown')

const boards: any[] = []
const guides: any[] = []
for (const file of readdirSync(join(PINOUT, 'src/en/overlay')).filter((f) => f.endsWith('.md')).sort()) {
  const raw = readFileSync(join(PINOUT, 'src/en/overlay', file), 'utf8').replace(/\r\n/g, '\n')
  const m = raw.match(/^\s*<!--\s*---\s*\n([\s\S]*?)\n-->\s*([\s\S]*)$/)
  if (!m) throw new Error(`unparsed overlay ${file}`)
  const d = parse(m[1].replace(/-+\s*$/, '')) as Record<string, any>
  FIXES[file]?.(d)
  const body = m[2].trim()
  const slug = basename(file, '.md')
  const src = {url: `https://pinout.xyz/pinout/${slug.replace(/-/g, '_')}`, repo: 'pinout-xyz/Pinout.xyz', path: `src/en/overlay/${file}`, commit: pinoutCommit, license: CC}
  if (d.class !== 'board') {
    guides.push({_id: `guide-pinout-${slug}`, _type: 'guide', title: d.title ?? d.name, slug: {_type: 'slug', current: `pinout-${slug}`}, publisher: 'pinout.xyz', topics: String(d.type ?? '').split(',').map((t) => t.trim()).filter(Boolean), body: [d.description, body].filter(Boolean).join('\n\n'), source: src})
    continue
  }
  const use = (physical: number, role: string, signal?: string, activeLow?: boolean) => ({
    _key: `p${physical}`,
    _type: 'pinUse',
    pin: {_type: 'reference', _ref: `pin-${physical}`},
    physical,
    role,
    ...(signal && {signal}),
    ...(activeLow && {activeLow}),
  })
  const used = new Map<number, any>()
  for (const [n, v] of Object.entries(d.pin ?? {})) {
    const physical = toPhysical(n, file)
    if (!physical) continue
    const p = (v ?? {}) as Record<string, any>
    used.set(physical, use(physical, roleOf(physical, p.mode, p.name), p.name, p.active === 'low'))
  }
  for (const n of Object.keys(d.power ?? {})) {
    const physical = toPhysical(n, file)
    if (physical && !used.has(physical)) used.set(physical, use(physical, physical === 2 || physical === 4 ? 'power-5v' : 'power-3v3'))
  }
  for (const n of Object.keys(d.ground ?? {})) {
    const physical = toPhysical(n, file)
    if (physical && !used.has(physical)) used.set(physical, use(physical, 'ground'))
  }
  const i2cDevices = Object.entries(d.i2c ?? {}).map(([a, v]) => {
    const dev = (v ?? {}) as Record<string, any>
    const address = hex(a)
    return {
      _key: `a${address}`,
      _type: 'i2cDevice',
      address,
      ...(dev.alternate && {alternates: [].concat(dev.alternate).map(hex)}),
      ...(dev.device && {device: String(dev.device)}),
      ...(dev.name && {label: String(dev.name)}),
    }
  })
  const link = (u: unknown) => (typeof u === 'string' && /^https?:\/\//.test(u) ? u : undefined)
  boards.push({
    _id: `board-${slug}`,
    _type: 'board',
    name: d.name,
    slug: {_type: 'slug', current: slug},
    manufacturer: d.manufacturer ?? undefined,
    formFactor: d.formfactor ?? undefined,
    categories: String(d.type ?? '').split(',').map((t) => t.trim()).filter(Boolean),
    summary: d.description,
    headerPins: d.pincount ?? undefined,
    idEeprom: eepromOf(d.eeprom),
    pins: [...used.values()].sort((a, b) => a.physical - b.physical),
    i2cDevices,
    dtoverlay: d.dtoverlay ? String(d.dtoverlay) : undefined,
    install: d.install ? (typeof d.install === 'string' ? d.install : JSON.stringify(d.install)) : undefined,
    links: {url: link(d.url), github: link(d.github), schematic: link(d.schematic), buy: link(d.buy)},
    body,
    source: src,
  })
}

// ---- Raspberry Pi documentation pages -------------------------------------
const DOCS = 'https://www.raspberrypi.com/documentation'
const rpiPages: [path: string, url: string, topics: string[]][] = [
  ['computers/raspberry-pi/gpio-on-raspberry-pi.adoc', `${DOCS}/computers/raspberry-pi.html#gpio`, ['gpio']],
  ['computers/raspberry-pi/gpio-pad-controls.adoc', `${DOCS}/computers/raspberry-pi.html#gpio-pads`, ['gpio', 'electrical']],
  ['computers/raspberry-pi/spi-bus-on-raspberry-pi.adoc', `${DOCS}/computers/raspberry-pi.html#spi-overview`, ['spi']],
  ['computers/raspberry-pi/power-supplies.adoc', `${DOCS}/computers/raspberry-pi.html#power-supply`, ['power']],
  ['computers/raspberry-pi/rtc.adoc', `${DOCS}/computers/raspberry-pi.html#real-time-clock-rtc`, ['rtc', 'pi5']],
  ['computers/raspberry-pi/display-parallel-interface.adoc', `${DOCS}/computers/raspberry-pi.html#parallel-display-interface-dpi`, ['display', 'dpi']],
  ['computers/os/using-gpio.adoc', `${DOCS}/computers/os.html#use-gpio-from-python`, ['gpio', 'python']],
  ['computers/os/using-python.adoc', `${DOCS}/computers/os.html#use-python-on-a-raspberry-pi`, ['python', 'software']],
  ['computers/config_txt/gpio.adoc', `${DOCS}/computers/config_txt.html#gpio-control`, ['config.txt', 'gpio']],
  ['computers/configuration/interfaces.adoc', `${DOCS}/computers/configuration.html#hardware-communication`, ['i2c', 'spi', 'uart', 'config.txt']],
  ['computers/io-controllers/rp1.adoc', `${DOCS}/computers/io-controllers.html#rp1`, ['pi5', 'rp1', 'gpio']],
]
const ACCESSORY: Record<string, string> = {audio: 'Raspberry Pi audio boards', 'sense-hat': 'Sense HAT', 'build-hat': 'Build HAT', 'tv-hat': 'TV HAT', 'ai-hat-plus': 'AI HAT+', 'm2-hat-plus': 'M.2 HAT+'}
for (const dir of ['audio', 'sense-hat', 'build-hat', 'tv-hat', 'ai-hat-plus', 'm2-hat-plus']) {
  // .NET walkthroughs and drawings say nothing about pins or compatibility.
  for (const f of readdirSync(join(RPIDOCS, 'documentation/asciidoc/accessories', dir)).filter((f) => f.endsWith('.adoc') && !/^(net-|mech)/.test(f)).sort()) {
    rpiPages.push([`accessories/${dir}/${f}`, `${DOCS}/accessories/${dir}.html`, ['accessory', dir]])
  }
}
for (const [path, url, topics] of rpiPages) {
  let body = readFileSync(join(RPIDOCS, 'documentation/asciidoc', path), 'utf8').trim()
  if (path.endsWith('interfaces.adoc')) body = body.slice(body.indexOf('== Hardware communication')) // skip SSH/VNC
  const heading = body.match(/^=+\s+(.+)$/m)?.[1] ?? basename(path, '.adoc')
  const accessory = ACCESSORY[path.split('/')[1]]
  const title = path.startsWith('accessories/') ? `${accessory}: ${heading}` : heading
  const slug = 'rpi-' + slugify(path.replace(/\.adoc$/, '').replace(/^(computers|accessories)\//, ''))
  guides.push({_id: `guide-${slug}`, _type: 'guide', title, slug: {_type: 'slug', current: slug}, publisher: 'Raspberry Pi Ltd', topics, body, source: {url, repo: 'raspberrypi/documentation', path: `documentation/asciidoc/${path}`, commit: docsCommit, license: CC}})
}

// ---- Pi models ------------------------------------------------------------
const models = [
  ['Raspberry Pi Zero 2 W', 'bcm2835'],
  ['Raspberry Pi 3 Model B+', 'bcm2835'],
  ['Raspberry Pi 4 Model B', 'bcm2711'],
  ['Raspberry Pi 400', 'bcm2711'],
  ['Raspberry Pi 5', 'rp1'],
  ['Raspberry Pi 500', 'rp1'],
].map(([name, soc]) => ({_id: `pi-${slugify(name)}`, _type: 'piModel', name, slug: {_type: 'slug', current: slugify(name)}, soc, headerPins: 40}))

// ---- write ----------------------------------------------------------------
const docs = [...pins, ...boards, ...guides, ...models].map((d) => JSON.parse(JSON.stringify(d))) // drop undefined
warnings.forEach((w) => console.warn('warn:', w))
console.log(`pins ${pins.length} boards ${boards.length} guides ${guides.length} models ${models.length} (pinout ${pinoutCommit.slice(0, 7)}, docs ${docsCommit.slice(0, 7)})`)
if (process.argv.includes('--dry')) process.exit(0)

const client = createClient({projectId: '31brl2ka', dataset: 'production', apiVersion: '2025-02-19', token: process.env.SANITY_DEV_TOKEN, useCdn: false})
for (let i = 0; i < docs.length; i += 50) {
  const tx = client.transaction()
  docs.slice(i, i + 50).forEach((d) => tx.createOrReplace(d))
  await tx.commit({visibility: 'async'})
  console.log(`committed ${Math.min(i + 50, docs.length)}/${docs.length}`)
}
// Remove imported documents that the sources no longer produce.
const stale: string[] = await client.fetch('*[_type in ["pin", "board", "guide", "piModel"] && !(_id in $ids) && !(_id in path("drafts.**"))]._id', {ids: docs.map((d) => d._id)})
if (stale.length) {
  await stale.reduce((tx, id) => tx.delete(id), client.transaction()).commit()
  console.log(`deleted ${stale.length} stale: ${stale.join(', ')}`)
}
