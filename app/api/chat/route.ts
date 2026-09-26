import {convertToModelMessages, createUIMessageStreamResponse, isStepCount, streamText, toUIMessageStream, type UIMessage} from 'ai'
import {INSTRUCTIONS, checkStackTool, contextTools, initialContext} from '@/lib/agent.ts'
import {MODEL} from '@/lib/model.ts'
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

  let setup
  try {
    setup = await Promise.all([contextTools(), initialContext()])
  } catch (e) {
    console.error('context setup failed', e)
    return Response.json({error: 'Could not reach the Sanity Context endpoints. Try again shortly.'}, {status: 503})
  }
  const [{tools, close}, context] = setup
  const result = streamText({
    model: MODEL,
    instructions: `${INSTRUCTIONS}\n\n${context}`,
    messages: await convertToModelMessages(messages.slice(-MAX_MESSAGES)),
    tools: {...tools, check_stack: checkStackTool},
    stopWhen: isStepCount(8),
    maxOutputTokens: 1500,
    onEnd: close,
  })
  return createUIMessageStreamResponse({stream: toUIMessageStream({stream: result.stream})})
}
