import {test} from 'node:test'
import assert from 'node:assert/strict'
import {tool} from 'ai'
import {MockLanguageModelV4} from 'ai/test'
import {z} from 'zod'
import {agentStream} from './agent.ts'
import {UNVERIFIED, guardAnswer} from './guard.ts'

test('guardAnswer: a verdict needs a successful check behind it', () => {
  assert.equal(guardAnswer('**Stacks**: these boards are compatible.', []).status, 'unverified')
  assert.equal(guardAnswer('They are compatible, go ahead.', []).text, UNVERIFIED)
  assert.equal(guardAnswer('I only help with Raspberry Pi add-on boards.', []).status, 'ok')
  assert.equal(guardAnswer('**Conflicts** on pin 12.', ['conflicts']).status, 'ok')
  const fixed = guardAnswer('**Stacks** — fine.', ['stacks-with-changes'])
  assert.equal(fixed.status, 'corrected')
  assert.match(fixed.text, /^\*\*Stacks with changes\*\*/)
})

// A scripted model: each doStream call plays the next step.
const usage = {inputTokens: {total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0}, outputTokens: {total: 1, text: 1, reasoning: 0}}
const say = (text: string) => [{type: 'text-start', id: 't'}, {type: 'text-delta', id: 't', delta: text}, {type: 'text-end', id: 't'}]
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
const checkStub = (verdict: string, calls: {n: number}) =>
  tool({inputSchema: z.object({boards: z.array(z.string())}), execute: async () => (calls.n++, {report: {verdict}})})

async function collectText(stream: ReadableStream) {
  let out = ''
  for await (const p of stream as AsyncIterable<{type: string; text?: string}>) if (p.type === 'text-delta') out += p.text
  return out
}

test('a model that skips check_stack cannot surface a compatibility verdict', async () => {
  const calls = {n: 0}
  const run = agentStream({
    model: scripted([[...say('**Stacks** — these boards are compatible.'), finish('stop')]]),
    instructions: 'test',
    messages: [{role: 'user', content: 'Can these boards stack?'}],
    tools: {check_stack: checkStub('conflicts', calls)},
  })
  const [streamed, text, status] = await Promise.all([collectText(run.stream), run.text, run.guardStatus])
  assert.equal(calls.n, 0)
  assert.equal(text, UNVERIFIED)
  assert.equal(streamed, UNVERIFIED) // what the browser receives, not just the promise
  assert.equal(status, 'unverified')
})

test("a verdict that contradicts check_stack is corrected to the checker's", async () => {
  const calls = {n: 0}
  const run = agentStream({
    model: scripted([
      [{type: 'tool-call', toolCallId: 'c1', toolName: 'check_stack', input: JSON.stringify({boards: ['a', 'b']})}, finish('tool-calls')],
      [...say('**Stacks** — no problems here.'), finish('stop')],
    ]),
    instructions: 'test',
    messages: [{role: 'user', content: 'a and b?'}],
    tools: {check_stack: checkStub('conflicts', calls)},
  })
  const text = await run.text
  assert.equal(calls.n, 1)
  assert.match(text, /^\*\*Conflicts\*\*/)
  assert.equal(await run.guardStatus, 'corrected')
})
