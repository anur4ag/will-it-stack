// Run the agent once from the terminal and print every tool call. Usage: node --env-file=.env.local scripts/ask.ts "question"
import {runAgent} from '../lib/agent.ts'

const question = process.argv[2] ?? 'Can I use a Sense HAT and an Enviro pHAT together on a Pi 5?'
const t0 = Date.now()
const result = await runAgent([{role: 'user', content: question}])
for (const s of await result.steps) for (const c of s.toolCalls) console.log(`→ ${c.toolName} ${JSON.stringify(c.input).slice(0, 300)}`)
const usage = await result.totalUsage
console.log(`\n${await result.text}\n\n[${((Date.now() - t0) / 1000).toFixed(1)}s, ${(await result.steps).length} steps, ${usage.inputTokens} in / ${usage.outputTokens} out]`)
