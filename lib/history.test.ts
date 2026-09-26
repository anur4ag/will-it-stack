import {test} from 'node:test'
import assert from 'node:assert/strict'
import {acceptHistory} from './history.ts'

const user = (text: string) => ({role: 'user', parts: [{type: 'text', text}]})
const bot = (text: string) => ({role: 'assistant', parts: [{type: 'text', text}, {type: 'dynamic-tool', toolName: 'groq_query', output: 'x'.repeat(100_000)}]})

test('rejects malformed bodies before any model call', () => {
  for (const body of [null, {}, {messages: []}, {messages: 'hi'}, {messages: [{role: 'system', parts: []}]}]) assert.equal(typeof acceptHistory(body), 'string')
})

test('bounds every user message, not just the last one', () => {
  assert.equal(typeof acceptHistory({messages: [user('x'.repeat(200_000)), bot('ok'), user('short')]}), 'string')
})

test('keeps only text, trims earlier answers and drops old tool output', () => {
  const h = acceptHistory({messages: [user('a'), bot('b'.repeat(10_000)), user('c')]})
  assert.ok(Array.isArray(h))
  assert.equal(h.length, 3)
  assert.equal((h[1].content as string).length, 4000)
  assert.equal(typeof acceptHistory({messages: [user('a'), bot('b')]}), 'string') // must end with a question
})
