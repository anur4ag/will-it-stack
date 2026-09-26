// Run the agent once from the terminal and print every tool call. Usage: node --env-file=.env.local scripts/ask.ts "question"
import {generateText, isStepCount} from 'ai'
import {INSTRUCTIONS, checkStackTool, contextTools, initialContext} from '../lib/agent.ts'
import {MODEL} from '../lib/model.ts'

const question = process.argv[2] ?? 'Can I use a Sense HAT and an Enviro pHAT together on a Pi 5?'
const {tools, close} = await contextTools()
const t0 = Date.now()
try {
  const r = await generateText({
    model: process.env.MODEL ?? MODEL,
    instructions: `${INSTRUCTIONS}\n\n${await initialContext()}`,
    prompt: question,
    tools: {...tools, check_stack: checkStackTool},
    stopWhen: isStepCount(8),
    maxOutputTokens: 1500,
  })
  for (const s of r.steps) for (const c of s.toolCalls) console.log(`→ ${c.toolName} ${JSON.stringify(c.input).slice(0, 300)}`)
  console.log(`\n${r.text}\n\n[${((Date.now() - t0) / 1000).toFixed(1)}s, ${r.steps.length} steps, ${r.totalUsage.inputTokens} in / ${r.totalUsage.outputTokens} out]`)
} finally {
  await close()
}
