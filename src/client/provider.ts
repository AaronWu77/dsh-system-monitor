/** Shared resource stream; hidden documents release HTTP demand and reconnect only when visible. */
import { z } from 'zod'
import type { ResourceProvider } from '@deepseek-ai/dsh-client-resources/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { streamFrameSchema, type Snapshot, type StreamFrame } from '../shared/model.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface ResourceProtocolMap {
    /** Current Host metrics and bounded, in-memory history. */
    'system-monitor': Snapshot
  }
}
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** A stream could not supply a current Host snapshot. */
    'system-monitor/unavailable': { reason: string }
  }
}

/** Exact shared address; page navigation identities are deliberately separate. */
export const MONITOR_ADDRESS = 'dsh-resource://system-monitor/host'
const configSchema = z.object({ reconnectMs: z.number().int().min(1000).max(30000), intervalMs: z.number().int().min(500).max(10000), streamTimeoutMs: z.number().int().min(3000).max(60000) })
// A malformed peer cannot grow an unterminated NDJSON frame without a bound.
const MAX_FRAME_CHARACTERS = 4 * 1024 * 1024

/** Instance-local browser adapters; tests do not replace global fetch or document. */
export interface MonitorEnvironment {
  fetch(input: string, init: RequestInit): Promise<Response>
  hidden(): boolean
  observeVisibility(listener: () => void): () => void
}

function failure(reason: string): RemoteResult<Snapshot> {
  return { ok: false, error: { name: 'RemoteError', isDSHRemoteError: true, code: 'system-monitor/unavailable', message: 'Host resource monitoring is unavailable.', details: { reason } } }
}

/** Decode validated NDJSON frames and release the reader on cancellation or failure. */
export async function* readFrames(response: Response, signal: AbortSignal): AsyncIterable<StreamFrame> {
  if (!response.ok || response.body === null) throw new Error('Invalid monitor stream response')
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let pending = ''
  let cancel: Promise<void> | undefined
  const abort = (): void => {
    cancel = reader.cancel().catch((error: unknown) => {
      // An errored fetch body has already reported its read failure to the consumer.
      if (!signal.aborted) throw error
    })
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    if (signal.aborted) return
    while (!signal.aborted) {
      const chunk = await reader.read()
      pending += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true })
      let newline = pending.indexOf('\n')
      while (newline !== -1) {
        const rawLine = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        if (rawLine.length > MAX_FRAME_CHARACTERS) throw new Error('Monitor frame exceeds the limit')
        const line = rawLine.trim()
        if (line !== '') yield streamFrameSchema.parse(JSON.parse(line))
        newline = pending.indexOf('\n')
      }
      if (pending.length > MAX_FRAME_CHARACTERS) throw new Error('Monitor frame exceeds the limit')
      if (chunk.done) {
        if (pending.trim() !== '') yield streamFrameSchema.parse(JSON.parse(pending))
        return
      }
    }
  } finally {
    signal.removeEventListener('abort', abort)
    if (cancel !== undefined) await cancel
    else await reader.cancel()
    reader.releaseLock()
  }
}

/** Resource owner shared by every body in this browser plugin instance. */
export class MonitorResourceOwner {
  private readonly lifetime = new AbortController()
  private readonly interrupts = new Set<() => void>()
  private readonly completions = new Set<Promise<void>>()
  readonly provider: ResourceProvider<'system-monitor'>

  /** @param environment Browser transport and visibility owned by this plugin instance. */
  constructor(private readonly environment: MonitorEnvironment) {
    this.provider = { protocol: 'system-monitor', open: (address, context) => this.open(address, context.signal) }
  }

  /** Interrupt the current request or reconnect wait; the existing resource stream owns the retry. */
  readonly retry = (): void => {
    for (const interrupt of this.interrupts) interrupt()
  }

  /** Stop admission and await every active stream's reader cleanup. @returns Settled stream cleanup. */
  async dispose(): Promise<void> {
    this.lifetime.abort()
    await Promise.all(this.completions)
  }

  private async *open(address: string, callerSignal: AbortSignal): AsyncIterable<RemoteResult<Snapshot>> {
    if (address !== MONITOR_ADDRESS) { yield failure('invalid-address'); return }
    const signal = AbortSignal.any([callerSignal, this.lifetime.signal])
    if (signal.aborted) return
    let complete = (): void => {}
    const completion = new Promise<void>(resolve => { complete = resolve })
    this.completions.add(completion)
    let request: AbortController | undefined
    let revision = 0
    const waiters = new Set<() => void>()
    const interrupt = (): void => {
      revision += 1
      request?.abort()
      for (const wake of [...waiters]) wake()
    }
    const wait = (milliseconds?: number): Promise<void> => new Promise(resolve => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const wake = (): void => {
        if (timer !== undefined) clearTimeout(timer)
        waiters.delete(wake)
        resolve()
      }
      waiters.add(wake)
      if (signal.aborted) wake()
      else if (milliseconds !== undefined) timer = setTimeout(wake, milliseconds)
    })
    this.interrupts.add(interrupt)
    signal.addEventListener('abort', interrupt, { once: true })
    const unobserve = this.environment.observeVisibility(interrupt)
    let config: z.infer<typeof configSchema> | undefined
    try {
      while (!signal.aborted) {
        if (this.environment.hidden()) { await wait(); continue }
        const started = revision
        const currentRequest = new AbortController()
        request = currentRequest
        let watchdog: ReturnType<typeof setTimeout> | undefined
        let timedOut = false
        try {
          const configuration = await this.environment.fetch('/api/dsh-system-monitor/config', { signal: request.signal, cache: 'no-store' })
          if (!configuration.ok) throw new Error('Monitor configuration unavailable')
          const latestConfig = configSchema.parse(await configuration.json())
          if (signal.aborted || this.environment.hidden() || started !== revision) continue
          config = latestConfig
          const streamTimeoutMs = config.streamTimeoutMs
          const resetWatchdog = (): void => {
            if (watchdog !== undefined) clearTimeout(watchdog)
            watchdog = setTimeout(() => { timedOut = true; currentRequest.abort() }, streamTimeoutMs)
          }
          resetWatchdog()
          const response = await this.environment.fetch('/api/dsh-system-monitor/stream', { signal: request.signal, cache: 'no-store' })
          for await (const frame of readFrames(response, request.signal)) {
            if (signal.aborted || this.environment.hidden() || started !== revision) break
            resetWatchdog()
            yield frame.kind === 'snapshot' ? { ok: true, value: frame.value } : failure(frame.code)
          }
          if (!signal.aborted && !this.environment.hidden() && started === revision) yield failure(timedOut ? 'stale' : 'disconnected')
        } catch (error) {
          if (!signal.aborted && !this.environment.hidden() && started === revision) {
            yield failure(timedOut ? 'stale' : error instanceof z.ZodError || error instanceof SyntaxError ? 'invalid-response' : 'connection-failed')
          }
        } finally {
          if (watchdog !== undefined) clearTimeout(watchdog)
          request.abort()
          request = undefined
        }
        if (signal.aborted) return
        if (this.environment.hidden() || started !== revision) continue
        // Before a valid Host configuration exists, only an explicit retry or visibility change retries.
        await wait(config?.reconnectMs)
      }
    } finally {
      request?.abort()
      unobserve()
      signal.removeEventListener('abort', interrupt)
      this.interrupts.delete(interrupt)
      this.completions.delete(completion)
      complete()
    }
  }
}
