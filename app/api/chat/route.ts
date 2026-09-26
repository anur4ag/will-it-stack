import {createUIMessageStreamResponse, toUIMessageStream} from 'ai'
import {runAgent} from '@/lib/agent.ts'
import {acceptHistory} from '@/lib/history.ts'
import {allow} from '@/lib/ratelimit.ts'

export const maxDuration = 60

export async function POST(req: Request) {
  const history = acceptHistory(await req.json().catch(() => null))
  if (typeof history === 'string') return Response.json({error: history}, {status: 400})

  const gate = allow(req.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? 'unknown')
  if (!gate.ok) return Response.json({error: gate.reason}, {status: 429})

  let result
  try {
    result = await runAgent(history)
  } catch (e) {
    console.error('agent setup failed', e)
    return Response.json({error: 'Could not reach the Sanity Context endpoints. Try again shortly.'}, {status: 503})
  }
  return createUIMessageStreamResponse({stream: toUIMessageStream({stream: result.stream})})
}
