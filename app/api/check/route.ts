import {runCheck} from '@/lib/sanity.ts'

// The deterministic checker on its own: no model, no rate limit needed.
export async function GET(req: Request) {
  const url = new URL(req.url)
  const boards = (url.searchParams.get('boards') ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 6)
  if (!boards.length) return Response.json({error: 'Pass ?boards=slug-a,slug-b&pi=raspberry-pi-5'}, {status: 400})
  return Response.json(await runCheck(boards, url.searchParams.get('pi') ?? 'raspberry-pi-5'))
}
