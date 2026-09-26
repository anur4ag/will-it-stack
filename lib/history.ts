import type {ModelMessage} from 'ai'

const MAX_QUESTION = 600 // characters in any user message
const MAX_ANSWER = 4000 // characters kept from any earlier assistant answer
const MAX_MESSAGES = 8

// The history comes from the browser, so treat all of it as untrusted: keep only text, bound every
// message, and drop earlier tool calls/results (the agent re-runs its tools for each question).
export function acceptHistory(body: unknown): ModelMessage[] | string {
  const messages = (body as {messages?: unknown})?.messages
  if (!Array.isArray(messages) || !messages.length) return 'Send {messages: [...]}.'
  const out: ModelMessage[] = []
  for (const m of messages.slice(-MAX_MESSAGES)) {
    const role = (m as {role?: unknown})?.role
    const parts = (m as {parts?: unknown})?.parts
    if ((role !== 'user' && role !== 'assistant') || !Array.isArray(parts)) return 'Malformed message.'
    const text = parts.map((p) => (p?.type === 'text' && typeof p.text === 'string' ? p.text : '')).join('').trim()
    if (role === 'user' && (!text || text.length > MAX_QUESTION)) return `Ask one question of up to ${MAX_QUESTION} characters.`
    if (text) out.push({role, content: role === 'assistant' ? text.slice(0, MAX_ANSWER) : text})
  }
  if (out.at(-1)?.role !== 'user') return 'The last message must be your question.'
  return out
}
