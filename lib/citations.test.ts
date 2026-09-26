import {test} from 'node:test'
import assert from 'node:assert/strict'
import {kbCitations, kbPathsRead, kbPathsReadFromResults} from './citations.ts'

const read = (state: string, output: unknown) => ({type: 'dynamic-tool', toolName: 'knowledge_base_read', state, input: {knowledgeBase: 'kb', paths: ['buses/i2c']}, output})

test('only successful Knowledge Base reads count as read', () => {
  assert.deepEqual([...kbPathsRead([read('output-available', {content: [{type: 'text', text: '…'}]})])], ['buses/i2c'])
  assert.equal(kbPathsRead([read('output-error', undefined)]).size, 0)
  assert.equal(kbPathsRead([read('input-available', undefined)]).size, 0)
  assert.equal(kbPathsRead([read('output-available', {isError: true, content: []})]).size, 0)
  assert.equal(kbPathsReadFromResults([{toolName: 'knowledge_base_read', input: {paths: ['a']}, output: {isError: true}}]).size, 0)
})

test('citations are parsed per path', () => {
  assert.deepEqual(kbCitations('x [kb: buses/i2c, gpio_pinout/pin_functions] y [kb: power]'), ['buses/i2c', 'gpio_pinout/pin_functions', 'power'])
})
