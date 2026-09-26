import {test} from 'node:test'
import assert from 'node:assert/strict'
import {checkStack, type Board} from './stack.ts'

const i2cPins = [
  {physical: 3, role: 'i2c'},
  {physical: 5, role: 'i2c'},
  {physical: 1, role: 'power-3v3'},
  {physical: 6, role: 'ground'},
]
const b = (slug: string, extra: Partial<Board>): Board => ({slug, name: slug, formFactor: 'pHAT', pins: i2cPins, i2cDevices: [], ...extra})

test('boards sharing only buses stack', () => {
  const r = checkStack([b('a', {pins: i2cPins, i2cDevices: [{address: '0x76'}]}), b('c', {pins: i2cPins, i2cDevices: [{address: '0x29'}]})], 'bcm2711')
  assert.equal(r.verdict, 'stacks')
  assert.equal(r.pins.find((p) => p.physical === 3)?.state, 'shared')
})

test('two I2S DACs conflict on the same pins', () => {
  const dac = (s: string) => b(s, {pins: [12, 35, 40].map((physical) => ({physical, role: 'i2s'}))})
  const r = checkStack([dac('x'), dac('y')], 'rp1')
  assert.equal(r.verdict, 'conflicts')
  assert.deepEqual(r.issues.filter((i) => i.kind === 'pin').map((i) => i.pin), [12, 35, 40])
})

test('SPI bus is shared but chip selects are not', () => {
  const spi = (s: string, cs: number) => b(s, {pins: [19, 21, 23].map((physical) => ({physical, role: 'spi'})).concat({physical: cs, role: 'spi-cs'})})
  assert.equal(checkStack([spi('x', 24), spi('y', 26)], 'bcm2711').verdict, 'stacks')
  assert.equal(checkStack([spi('x', 24), spi('y', 24)], 'bcm2711').issues[0].pin, 24)
})

test('I2C address clash is fixable only when an alternate is free', () => {
  const fixable = checkStack([b('x', {i2cDevices: [{address: '0x68'}]}), b('y', {i2cDevices: [{address: '0x68', alternates: ['0x68', '0x69']}]})], 'bcm2711')
  assert.equal(fixable.verdict, 'stacks-with-changes')
  assert.match(fixable.issues[0].fix ?? '', /0x69/)
  const stuck = checkStack([b('x', {i2cDevices: [{address: '0x68'}, {address: '0x69'}]}), b('y', {i2cDevices: [{address: '0x68', alternates: ['0x69']}]})], 'bcm2711')
  assert.equal(stuck.verdict, 'conflicts')
})

test('a GPIO used as plain output by one board and I2C by another conflicts', () => {
  const r = checkStack([b('x', {pins: [{physical: 3, role: 'gpio-out'}]}), b('y', {pins: i2cPins})], 'bcm2711')
  assert.equal(r.issues[0].kind, 'pin')
})

test('two ID EEPROM boards warn, and the SoC function table is consulted', () => {
  const r = checkStack([b('x', {idEeprom: 'yes'}), b('y', {idEeprom: 'setup', pins: [{physical: 7, role: 'pwm'}]})], 'rp1', [{physical: 7, label: 'GPIO 4', functions: {rp1: ['GPCLK0', 'SPI4 SIO0']}}])
  assert.ok(r.issues.some((i) => i.kind === 'eeprom' && i.severity === 'warning'))
  assert.ok(r.issues.some((i) => i.kind === 'function' && i.pin === 7))
  assert.equal(r.verdict, 'stacks')
})

test('every extra device at a shared address must move, or it stays a conflict', () => {
  // Three boards at 0x68; only one can move. Two devices would still share 0x68.
  const r = checkStack([b('x', {i2cDevices: [{address: '0x68'}]}), b('y', {i2cDevices: [{address: '0x68'}]}), b('z', {i2cDevices: [{address: '0x68', alternates: ['0x69']}]})], 'bcm2711')
  assert.equal(r.verdict, 'conflicts')
  assert.equal(r.issues[0].severity, 'conflict')
  // Two movable, one fixed: fixable, with both moves spelled out and no address reused.
  const ok = checkStack([b('x', {i2cDevices: [{address: '0x68'}]}), b('y', {i2cDevices: [{address: '0x68', alternates: ['0x69', '0x6a']}]}), b('z', {i2cDevices: [{address: '0x68', alternates: ['0x69']}]})], 'bcm2711')
  assert.equal(ok.verdict, 'stacks-with-changes')
  assert.match(ok.issues[0].fix ?? '', /0x69/)
  assert.match(ok.issues[0].fix ?? '', /0x6a/)
})

test('missing or empty boards never come back as compatible', () => {
  assert.equal(checkStack([], 'rp1').verdict, 'incomplete')
  assert.equal(checkStack([b('x', {pins: i2cPins})], 'rp1', [], ['not-a-real-board']).verdict, 'incomplete')
  assert.equal(checkStack([b('x', {pins: i2cPins}), b('y', {pins: []})], 'rp1').verdict, 'incomplete')
})
