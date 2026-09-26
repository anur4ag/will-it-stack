import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readUIMessageStream, toUIMessageStream, tool} from 'ai'
import {MockLanguageModelV4} from 'ai/test'
import {z} from 'zod'
import {agentStream} from './agent.ts'
import {UNVERIFIED, guardAnswer, type CheckedStack} from './guard.ts'
import {recordExample} from './record.ts'
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
  const g = guardAnswer('**Conflicts**\n\nA and B clash on pin 12.', checked('conflicts'))
  assert.equal(g.status, 'ok')
  assert.match(g.text, /^\*\*Conflicts\*\*\n\nA and B clash on pin 12\./)
  assert.match(g.text, /Checked with the stack checker: A \+ B on Raspberry Pi 5 → Conflicts/)
})

test('guardAnswer replaces an answer that is cut off or talks about other boards', () => {
  assert.equal(guardAnswer('**Conflicts**\n\nA and B clash on pin', checked('conflicts'), {truncated: true}).status, 'replaced')
  const other = guardAnswer('**Conflicts**\n\nA and C clash.', checked('conflicts', ['A', 'B']))
  assert.equal(other.status, 'replaced')
  assert.doesNotMatch(other.text, /A and C/)
})

test('guardAnswer drops a "Checked with" line the model wrote itself (imitating the history)', () => {
  const g = guardAnswer('**Conflicts**\n\nA and B clash on pin 12.\n\n_Checked with the stack checker: A + C on Raspberry Pi 5 → Stacks._', checked('conflicts'))
  assert.equal(g.status, 'ok')
  assert.equal(g.text.match(/Checked with the stack checker/g)?.length, 1)
  assert.doesNotMatch(g.text, /A \+ C|→ Stacks/)
  // Boards named only in an imitated line don't count as named.
  assert.equal(guardAnswer('**Conflicts**\n\nThey clash.\n\n_Checked with the stack checker: A + B → Conflicts._', checked('conflicts')).status, 'replaced')
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

// Two check_stack calls in one step: [A] fails, [A, B] succeeds. Only the latest call ([A, B]) counts,
// whichever finishes first.
for (const failFirst of [true, false]) {
  test(`an earlier parallel call failing doesn't void the latest one (${failFirst ? 'error first' : 'result first'})`, async () => {
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
    const parallelStub = tool({
      inputSchema: z.object({boards: z.array(z.string())}),
      execute: async ({boards}) => {
        if (boards.length === 1) {
          await wait(failFirst ? 1 : 25)
          throw new Error('check failed')
        }
        await wait(failFirst ? 25 : 1)
        return checked('conflicts', boards)
      },
    })
    const r = agentStream({
      model: scripted([[call('a', ['A']), call('ab', ['A', 'B']), finish('tool-calls')], [...say('**Conflicts**\n\nA and B share pin 12.'), finish('stop')]]),
      instructions: 't',
      messages: [{role: 'user', content: 'q'}],
      tools: {check_stack: parallelStub},
    })
    assert.equal(await r.guardStatus, 'ok')
    assert.match(await r.text, /Checked with the stack checker: A \+ B/)
  })
}

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

test('once tools are in use, the agent is made to keep going until a check succeeds', async () => {
  const seen: unknown[] = []
  const model = scripted([
    [{type: 'tool-call', toolCallId: 'l1', toolName: 'lookup', input: '{}'}, finish('tool-calls')],
    [call('c1', ['A', 'B']), finish('tool-calls')],
    [...say('**Conflicts**\n\nA and B share pin 12.'), finish('stop')],
  ])
  const orig = model.doStream.bind(model)
  model.doStream = async (o: {toolChoice?: unknown}) => (seen.push(o.toolChoice), orig(o as never))
  const lookup = tool({inputSchema: z.object({}), execute: async () => 'boards found'})
  const r = agentStream({model, instructions: 't', messages: [{role: 'user', content: 'q'}], tools: {lookup, check_stack: checkStub}})
  assert.equal(await r.guardStatus, 'ok')
  assert.deepEqual(seen, [{type: 'auto'}, {type: 'required'}, {type: 'auto'}]) // free at first (off-topic), required until checked
})

// The recorder: attempt n plays attempts[n-1]; 'fail' is a provider error before any output.
const replacedRun = [[call('c1', ['A', 'B']), finish('tool-calls')], [...say('**Stacks**\n\nA and B. FIRST_ATTEMPT'), finish('stop')]]
const okRun = [[call('c2', ['A', 'B']), finish('tool-calls')], [...say('**Conflicts**\n\nA and B share pin 12. SECOND_ATTEMPT'), finish('stop')]]
function attemptsOf(plays: (unknown[][] | 'fail')[]) {
  let n = 0
  return () => {
    const play = plays[n++]
    const model = play === 'fail' ? new MockLanguageModelV4({doStream: async () => { throw new Error('provider failed before output') }}) : scripted(play)
    return agentStream({model, instructions: 't', messages: [{role: 'user', content: 'q'}], tools: {check_stack: checkStub}})
  }
}
const quiet = {beforeAttempt: async () => {}}
const silence = <T>(p: Promise<T>) => {
  const [log, err] = [console.log, console.error]
  console.log = console.error = () => {}
  return p.finally(() => ([console.log, console.error] = [log, err]))
}

test('recorder: a replaced first attempt then two provider failures saves nothing', async () => {
  await assert.rejects(silence(recordExample('q', attemptsOf([replacedRun, 'fail', 'fail']), quiet)), /No usable recording/)
})

test('recorder: the saved message, status and attempt count come from the same attempt', async () => {
  const r = await silence(recordExample('q', attemptsOf([replacedRun, okRun]), quiet))
  assert.equal(r.attempts, 2)
  assert.equal(r.guardStatus, 'ok')
  const parts = JSON.stringify(r.message.parts)
  assert.match(parts, /SECOND_ATTEMPT/)
  assert.doesNotMatch(parts, /FIRST_ATTEMPT|"c1"/)
})

test('a matching answer is kept and bound to the checked boards', async () => {
  const r = run([
    [call('c1', ['A', 'B']), finish('tool-calls')],
    [...say('**Conflicts**\n\nA and B both use pin 12.'), finish('stop')],
  ])
  const text = await r.text
  assert.match(text, /^\*\*Conflicts\*\*\n\nA and B both use pin 12\./)
  assert.match(text, /Checked with the stack checker: A \+ B on Raspberry Pi 5 → Conflicts/)
  assert.equal(await r.guardStatus, 'ok')
})
