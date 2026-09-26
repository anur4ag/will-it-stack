import {convertToModelMessages, createUIMessageStreamResponse, toUIMessageStream, type UIMessage} from 'ai'
import {runAgent} from '@/lib/agent.ts'
import {allow} from '@/lib/ratelimit.ts'

export const maxDuration = 60

const MAX_CHARS = 600
const MAX_MESSAGES = 8

export async function POST(req: Request) {
  const {messages}: {messages: UIMessage[]} = await req.json()
  const last = messages.at(-1)
  const text = last?.parts.map((p) => (p.type === 'text' ? p.text : '')).join('') ?? ''
  if (last?.role !== 'user' || !text.trim() || text.length > MAX_CHARS) return Response.json({error: `Ask one question of up to ${MAX_CHARS} characters.`}, {status: 400})

  const gate = allow(req.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? 'unknown')
  if (!gate.ok) return Response.json({error: gate.reason}, {status: 429})

  let result
  try {
    result = await runAgent(await convertToModelMessages(messages.slice(-MAX_MESSAGES)))
  } catch (e) {
    console.error('agent setup failed', e)
    return Response.json({error: 'Could not reach the Sanity Context endpoints. Try again shortly.'}, {status: 503})
  }
  return createUIMessageStreamResponse({stream: toUIMessageStream({stream: result.stream})})
}
