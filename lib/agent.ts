import {createMCPClient} from '@ai-sdk/mcp'
import {isStepCount, streamText, tool, type ModelMessage} from 'ai'
import {z} from 'zod'
import {MODEL} from './model.ts'
import {runCheck} from './sanity.ts'

const ORG = 'or89icyo8'
const endpoint = (name: string) => `https://api.sanity.io/v1/context/organizations/${ORG}/mcp/${name}`
const auth = () => ({Authorization: `Bearer ${process.env.SANITY_CONTEXT_TOKEN}`})

// Two Context MCP endpoints: GROQ mode over the structured records, Knowledge Base mode over the prose.
// Each is narrowed to the one tool the agent needs; initial context is inlined into the prompt instead.
export async function contextTools() {
  const [data, kb] = await Promise.all([
    createMCPClient({transport: {type: 'http', url: `${endpoint('will-it-stack-data')}?tools=groq_query`, headers: auth()}}),
    createMCPClient({transport: {type: 'http', url: `${endpoint('will-it-stack-kb')}?tools=knowledge_base_read`, headers: auth()}}),
  ])
  return {tools: {...(await data.tools()), ...(await kb.tools())}, close: async () => void (await Promise.all([data.close(), kb.close()]))}
}

// ponytail: per-instance cache; fine because the outline only changes when the Knowledge Base is rebuilt.
let initial: {at: number; text: string} | undefined
export async function initialContext() {
  if (initial && Date.now() - initial.at < 10 * 60_000) return initial.text
  const [data, kb] = await Promise.all(
    ['will-it-stack-data', 'will-it-stack-kb'].map(async (n) => {
      const r = await fetch(`${endpoint(n)}/initial-context`, {headers: auth()})
      if (!r.ok) throw new Error(`initial-context ${n}: ${r.status}`)
      return r.text()
    }),
  )
  initial = {at: Date.now(), text: `<dataset-context>\n${data}\n</dataset-context>\n\n<knowledge-base-context>\n${kb}\n</knowledge-base-context>`}
  return initial.text
}

export const checkStackTool = tool({
  description:
    'Deterministically check whether a set of add-on boards can share one GPIO header on a given Pi model. Returns every pin, I2C address and HAT EEPROM collision, with fixes where the data lists one. Call this before saying anything about compatibility; its verdict is final.',
  inputSchema: z.object({
    boards: z.array(z.string()).min(1).max(6).describe('Board slugs (slug.current), found with groq_query'),
    pi: z.string().describe('Pi model slug: raspberry-pi-5, raspberry-pi-500, raspberry-pi-4-model-b, raspberry-pi-400, raspberry-pi-3-model-b, raspberry-pi-zero-2-w').default('raspberry-pi-5'),
  }),
  execute: async ({boards, pi}) => runCheck(boards, pi),
  // The UI gets the full result (every pin, for the header diagram); the model only needs what matters.
  toModelOutput: ({output: r}) => {
    const bcm = new Map(r.header.map((h) => [h.physical, h.bcm]))
    const value = {
        pi: r.pi.name,
        verdict: r.report.verdict,
        note: r.note ?? null,
        unknownBoards: r.unknownBoards,
        boards: r.boards.map((b) => ({slug: b.slug, name: b.name, formFactor: b.formFactor, dtoverlay: b.dtoverlay ?? null})),
        issues: r.report.issues.map((i) => ({...i, bcm: i.pin ? bcm.get(i.pin) : undefined})),
        sharedPins: r.report.pins.filter((p) => p.state === 'shared').map((p) => ({physical: p.physical, bcm: bcm.get(p.physical) ?? null, role: p.users[0].role})),
        i2c: r.report.i2c,
        notes: r.report.notes,
    }
    return {type: 'json', value: JSON.parse(JSON.stringify(value))} // drops undefined, keeps it JSON
  },
})

export const INSTRUCTIONS = `You are Will It Stack, an assistant that plans which Raspberry Pi add-on boards (HATs, pHATs, bonnets, shims) can share one 40-pin GPIO header.

How to work:
1. Identify the boards. Use groq_query against the board records to find them by name, maker or category and get their slug. If the person describes a goal instead of boards ("weather station with a display"), find a few candidates per role and prefer small combinations. Only ever propose boards that exist in the data.
2. Call check_stack with the slugs and the Pi model. If no model is given, use the Raspberry Pi 5 and say so. Never state or imply compatibility without a check_stack result, and never contradict its verdict.
3. Read the Knowledge Base entries that cover those boards, the buses they use and the Pi model, in one knowledge_base_read call. Pick the paths from the outline; once you know the boards, make this call in the same step as check_stack rather than after it. Use the entries for fixes and caveats: address jumpers, dtoverlay lines, Pi 5 or current Raspberry Pi OS differences, power limits.
4. If a combination conflicts, try to find an alternative board with groq_query and check it before suggesting it.

Answer format (Markdown, short):
- First line: the verdict in bold, taken from check_stack (Stacks / Stacks with changes / Conflicts).
- Each problem with physical pin and BCM GPIO number, which boards collide, and the fix if one exists.
- Caveats from the Knowledge Base, each with its source in brackets, e.g. [kb: path/of/entry] or [board: slug]. Only cite a kb path you actually read with knowledge_base_read in this conversation; if you did not read the Knowledge Base, do not cite it.
- One line on what the data cannot tell you (for example, physical clearance or boards missing from pinout.xyz).
Do not speculate past the sources: if neither check_stack nor the Knowledge Base gives a fix or workaround, say that the data lists none, rather than claiming none exists.

Stay on Raspberry Pi hardware. If asked about anything else, say what you can help with instead.`


// One agent run, shared by the API route, scripts/record.ts and scripts/eval.ts so they can't drift apart.
export async function runAgent(messages: ModelMessage[]) {
  const [{tools, close}, context] = await Promise.all([contextTools(), initialContext()])
  return streamText({
    model: MODEL,
    instructions: `${INSTRUCTIONS}\n\n${context}`,
    messages,
    tools: {...tools, check_stack: checkStackTool},
    stopWhen: isStepCount(8),
    maxOutputTokens: 1500,
    maxRetries: 4, // rides out a brief 429 from the free-tier rate limit
    onEnd: close,
  })
}
