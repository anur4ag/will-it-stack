import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readUIMessageStream, toUIMessageStream, tool} from 'ai'
import {MockLanguageModelV4} from 'ai/test'
import {z} from 'zod'
import {agentStream} from './agent.ts'
import {UNVERIFIED, guardAnswer, type CheckedStack} from './guard.ts'
import type {StackReport} from './stack.ts'

const checked = (verdict: StackReport['verdict'], boards = ['A', 'B']): CheckedStack => ({
  report: {verdict, soc: 'rp1', boards, pins: [], i2c: [], issues: verdict === 'conflicts' ? [{kind: 'pin', severity: 'conflict', boards, pin: 12, detail: 'A uses it as pwm; B uses it as i2s'}] : [], notes: []},
  pi: {name: 'Raspberry Pi 5'},
  header: [{physical: 12, label: 'GPIO 18', bcm: 18}],
})

test('guardAnswer fails closed without a check, whatever the wording', () => {
  for (const t of ['**Yes**, these two HATs work together as-is. Connect both to the same header.', 'Sure, go ahead.', '**Stacks**', 'I only help with Pi boards.']) {
    assert.deepEqual(guardAnswer(t, null), {text: UNVERIFIED, status: 'unverified'})
  }
})

test('guardAnswer keeps a matching answer and names what was checked', () => {
  const g = guardAnswer('**Conflicts**\n\nPin 12 clashes.', checked('conflicts'))
  assert.equal(g.status, 'ok')
  assert.match(g.text, /^\*\*Conflicts\*\*\n\nPin 12 clashes\./)
  assert.match(g.text, /Checked with the stack checker: A \+ B on Raspberry Pi 5 → Conflicts/)
})

test('guardAnswer replaces the whole answer when the verdict disagrees or is missing', () => {
  for (const t of ['**Stacks**\n\nThere are no conflicts. Connect both boards as-is.', 'They are fine together, connect both boards as-is.']) {
    const g = guardAnswer(t, checked('conflicts'))
    assert.equal(g.status, 'replaced')
    assert.match(g.text, /^\*\*Conflicts\*\* for A \+ B on Raspberry Pi 5/)
    assert.match(g.text, /Physical pin 12 \(GPIO 18\)/)
    assert.doesNotMatch(g.text, /no conflicts|as-is/i) // none of the model's contradictory prose survives
  }
})

// A scripted model: each doStream call plays the next step.
const usage = {inputTokens: {total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0}, outputTokens: {total: 1, text: 1, reasoning: 0}}
const say = (text: string) => [{type: 'text-start', id: 't'}, {type: 'text-delta', id: 't', delta: text}, {type: 'text-end', id: 't'}]
const call = (id: string, boards: string[]) => ({type: 'tool-call', toolCallId: id, toolName: 'check_stack', input: JSON.stringify({boards})})
const finish = (unified: string) => ({type: 'finish', finishReason: {unified, raw: unified}, usage})
function scripted(steps: unknown[][]) {
  let i = 0
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream({
        start(c) {
          for (const part of [{type: 'stream-start', warnings: []}, ...steps[Math.min(i++, steps.length - 1)]]) c.enqueue(part as never)
          c.close()
        },
      }),
    }),
  })
}
// Stub check: 'stacks' for one board, 'conflicts' for two, throws for three or more.
const calls = {n: 0}
const checkStub = tool({
  inputSchema: z.object({boards: z.array(z.string())}),
  execute: async ({boards}) => {
    calls.n++
    if (boards.length > 2) throw new Error('check failed')
    return checked(boards.length === 1 ? 'stacks' : 'conflicts', boards)
  },
})
const run = (steps: unknown[][]) => agentStream({model: scripted(steps), instructions: 'test', messages: [{role: 'user', content: 'q'}], tools: {check_stack: checkStub}})

// What the browser would render: the UI message stream decoded back into message text.
async function uiText(stream: ReadableStream) {
  let last = ''
  for await (const m of readUIMessageStream({stream: toUIMessageStream({stream: stream as never})})) last = m.parts.map((p) => (p.type === 'text' ? p.text : '')).join('')
  return last
}

test('no check at all: the visible answer is Not verified, in the text and in the UI stream', async () => {
  const r = run([[...say('**Yes**, these two HATs work together as-is. Connect both to the same header.'), finish('stop')]])
  const [ui, text, status] = await Promise.all([uiText(r.stream), r.text, r.guardStatus])
  assert.equal(text, UNVERIFIED)
  assert.equal(ui, UNVERIFIED)
  assert.equal(status, 'unverified')
})

test('a later failed check voids an earlier successful one', async () => {
  const r = run([
    [call('c1', ['A']), finish('tool-calls')],
    [call('c2', ['A', 'B', 'C']), finish('tool-calls')],
    [...say('**Stacks**\n\nA, B and C are compatible.'), finish('stop')],
  ])
  assert.equal(await r.text, UNVERIFIED)
  assert.equal(await r.guardStatus, 'unverified')
})

test('a contradicting answer is replaced by one built from the check, prose and all', async () => {
  const r = run([
    [call('c1', ['A', 'B']), finish('tool-calls')],
    [...say('**Stacks**\n\nThere are no conflicts. Connect both boards as-is.'), finish('stop')],
  ])
  const [ui, text] = await Promise.all([uiText(r.stream), r.text])
  assert.equal(ui, text)
  assert.match(text, /^\*\*Conflicts\*\* for A \+ B/)
  assert.doesNotMatch(text, /no conflicts|as-is/i)
  assert.equal(await r.guardStatus, 'replaced')
})

test('a matching answer is kept and bound to the checked boards', async () => {
  const r = run([
    [call('c1', ['A', 'B']), finish('tool-calls')],
    [...say('**Conflicts**\n\nPin 12 is used by both.'), finish('stop')],
  ])
  const text = await r.text
  assert.match(text, /^\*\*Conflicts\*\*\n\nPin 12 is used by both\./)
  assert.match(text, /Checked with the stack checker: A \+ B on Raspberry Pi 5 → Conflicts/)
  assert.equal(await r.guardStatus, 'ok')
})
