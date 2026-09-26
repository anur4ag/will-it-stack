// Which Knowledge Base entries count as read: only knowledge_base_read calls that returned a successful
// result. A call that errored, is still running, or came back with an MCP error does not count.
type Part = {type: string; toolName?: string; state?: string; input?: unknown; output?: unknown}

const paths = (input: unknown) => ((input as {paths?: unknown})?.paths as string[] | undefined)?.filter((p) => typeof p === 'string') ?? []
const ok = (output: unknown) => output != null && (output as {isError?: boolean}).isError !== true

export const kbPathsRead = (parts: Part[]) =>
  new Set(parts.flatMap((p) => (p.type === 'dynamic-tool' && p.toolName === 'knowledge_base_read' && p.state === 'output-available' && ok(p.output) ? paths(p.input) : [])))

// Same rule for AI SDK step results (scripts/eval.ts).
export const kbPathsReadFromResults = (results: {toolName: string; input: unknown; output: unknown}[]) =>
  new Set(results.flatMap((r) => (r.toolName === 'knowledge_base_read' && ok(r.output) ? paths(r.input) : [])))

export const kbCitations = (text: string) => [...text.matchAll(/\[kb:\s*([^\]]+)\]/gi)].flatMap((m) => m[1].split(/[,;]\s*/).map((p) => p.trim()))
