import {readUIMessageStream, toUIMessageStream, type UIMessage} from 'ai'
import type {runAgent} from './agent.ts'

type Run = (question: string) => Awaited<ReturnType<typeof runAgent>> | ReturnType<typeof runAgent>
export type Recording = {question: string; recordedAt: string; attempts: number; guardStatus: string; message: UIMessage}

/**
 * Records one example: retries (up to `max` attempts) until the guard passes the answer as-is.
 * Each attempt starts from nothing, so the saved message, status and time all belong to the last attempt.
 * Throws, rather than saving anything, if that last attempt produced no usable answer.
 */
export async function recordExample(question: string, run: Run, {max = 3, beforeAttempt = async () => {}} = {}): Promise<Recording> {
  for (let attempts = 1; ; attempts++) {
    await beforeAttempt()
    let message: UIMessage | undefined
    let guardStatus = 'error'
    try {
      const result = await run(question)
      for await (const m of readUIMessageStream({stream: toUIMessageStream({stream: result.stream})})) message = m
      guardStatus = await result.guardStatus
    } catch (e) {
      console.error(e)
    }
    console.log(`attempt ${attempts}: ${question} → guard ${guardStatus}`)
    if (guardStatus === 'ok' || attempts === max) {
      if (guardStatus === 'error' || !message) throw new Error(`No usable recording for "${question}" after ${attempts} attempts`)
      return {question, recordedAt: new Date().toISOString(), attempts, guardStatus, message}
    }
  }
}
