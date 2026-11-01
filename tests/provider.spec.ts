import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ResourceRegistry } from '../../../../packages/client/resources/src/client/resources.ts'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { MONITOR_ADDRESS, MonitorResourceOwner, readFrames } from '../src/client/provider.ts'
import type { Snapshot, StreamFrame } from '../src/shared/model.ts'
import { deferred, sample } from './host-fixtures.ts'

afterEach(() => vi.useRealTimers())
const value = (): Snapshot => ({ ...sample(), history: [] })
const encoder = new TextEncoder()
function harness(autoConsume = true) {
  let hidden = false
  let configuration = { reconnectMs: 1000, intervalMs: 1000, streamTimeoutMs: 3000 }
  let configurationStatus = 200
  const listeners = new Set<() => void>()
  const openings = [deferred<void>(), deferred<void>(), deferred<void>()]
  const cancellations = [deferred<void>(), deferred<void>(), deferred<void>()]
  const streams: ReadableStreamDefaultController<Uint8Array>[] = []
  const fetch = vi.fn(async (path: string, _init: RequestInit): Promise<Response> => {
    if (path.endsWith('/config')) return Response.json(configuration, { status: configurationStatus })
    const index = streams.length
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { streams.push(controller); openings[index]?.resolve() },
      cancel() { cancellations[index]?.resolve() },
    }))
  })
  const owner = new MonitorResourceOwner({ fetch, hidden: () => hidden, observeVisibility: listener => { listeners.add(listener); return () => { listeners.delete(listener) } } })
  const controller = new AbortController()
  const frames: RemoteResult<Snapshot>[] = []
  let onFrame = (_frame: RemoteResult<Snapshot>): void => {}
  const running = (async () => { if (!autoConsume) return; for await (const frame of owner.provider.open(MONITOR_ADDRESS, { signal: controller.signal })) { frames.push(frame); onFrame(frame) } })()
  return {
    owner, fetch, frames, listeners, openings, cancellations, running,
    configure(next: typeof configuration) { configuration = next; configurationStatus = 200 },
    failConfiguration(status: number) { configurationStatus = status },
    observe(callback: (frame: RemoteResult<Snapshot>) => void) { onFrame = callback },
    visible(show: boolean) { hidden = !show; for (const listener of [...listeners]) listener() },
    send(frame: StreamFrame, index = streams.length - 1) { streams[index]?.enqueue(encoder.encode(JSON.stringify(frame) + '\n')) },
    noise(index = streams.length - 1) { streams[index]?.enqueue(encoder.encode('\n \n')) },
    closeStream(index = streams.length - 1) { streams[index]?.close() },
    async stop() { controller.abort(); await running; await owner.dispose() },
  }
}

describe('monitor resource stream', () => {
  it('validates split UTF-8 and final frames without turning valid zero values into absence', async () => {
    const snapshot = { ...value(), hostName: '测试主机' }
    const bytes = encoder.encode(JSON.stringify({ kind: 'snapshot', value: snapshot }) + '\n' + JSON.stringify({ kind: 'failure', code: 'sampling-failed' }))
    const stream = new ReadableStream<Uint8Array>({ start(controller) { for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); controller.close() } })
    const frames: StreamFrame[] = []
    for await (const frame of readFrames(new Response(stream), new AbortController().signal)) frames.push(frame)
    expect(frames).toEqual([{ kind: 'snapshot', value: snapshot }, { kind: 'failure', code: 'sampling-failed' }])
    expect(snapshot.gpu.data?.[0]?.utilization).toBe(0)
  })

  it('rejects malformed and unsupported NDJSON values', async () => {
    for (const text of ['not-json\n', '{"kind":"other"}\n', JSON.stringify({ kind: 'snapshot', value: { ...value(), cpu: null } })]) {
      const consume = async () => { for await (const _frame of readFrames(new Response(text), new AbortController().signal)) { /* Decode every supplied frame. */ } }
      await expect(consume()).rejects.toThrow()
    }
  })

  it('cancels HTTP demand while hidden and starts one new stream when visible', async () => {
    vi.useFakeTimers()
    const h = harness()
    try {
      await h.openings[0].promise
      const received = deferred<void>()
      h.observe(frame => { if (frame.ok) received.resolve() })
      h.send({ kind: 'snapshot', value: value() })
      await received.promise
      h.visible(false)
      await h.cancellations[0].promise
      await vi.advanceTimersByTimeAsync(60000)
      expect(h.fetch).toHaveBeenCalledTimes(2)
      h.visible(true)
      await h.openings[1].promise
      expect(h.fetch).toHaveBeenCalledTimes(4)
      expect(h.frames.filter(frame => frame.ok)).toHaveLength(1)
    } finally { await h.stop() }
    expect(h.listeners.size).toBe(0)
  })

  it('uses the Host reconnect delay and lets explicit retry interrupt the stream', async () => {
    vi.useFakeTimers()
    const h = harness()
    try {
      await h.openings[0].promise
      const failed = deferred<void>()
      h.observe(frame => { if (!frame.ok) failed.resolve() })
      h.closeStream()
      await failed.promise
      await vi.advanceTimersByTimeAsync(999)
      expect(h.fetch).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1)
      await h.openings[1].promise
      h.owner.retry()
      await h.cancellations[1].promise
      await h.openings[2].promise
      expect(h.fetch).toHaveBeenCalledTimes(6)
    } finally { await h.stop() }
  })

  it('reads changed Host parameters on reconnect and keeps the last valid backoff if configuration fails', async () => {
    vi.useFakeTimers()
    const h = harness()
    try {
      await h.openings[0].promise
      let failed = deferred<void>()
      const received = deferred<void>()
      h.observe(frame => { if (frame.ok) received.resolve(); else failed.resolve() })
      h.configure({ reconnectMs: 2000, intervalMs: 2000, streamTimeoutMs: 5000 })
      h.closeStream()
      await failed.promise
      failed = deferred<void>()
      await vi.advanceTimersByTimeAsync(999)
      expect(h.fetch).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(1)
      await h.openings[1].promise
      expect(h.fetch).toHaveBeenCalledTimes(4)
      h.send({ kind: 'snapshot', value: value() })
      await received.promise
      await vi.advanceTimersByTimeAsync(4999)
      expect(h.frames.at(-1)?.ok).toBe(true)
      await vi.advanceTimersByTimeAsync(1)
      await failed.promise
      failed = deferred<void>()
      h.failConfiguration(503)
      await vi.advanceTimersByTimeAsync(1999)
      expect(h.fetch).toHaveBeenCalledTimes(4)
      await vi.advanceTimersByTimeAsync(1)
      await failed.promise
      expect(h.fetch).toHaveBeenCalledTimes(5)
      h.configure({ reconnectMs: 1000, intervalMs: 1000, streamTimeoutMs: 4000 })
      await vi.advanceTimersByTimeAsync(1999)
      expect(h.fetch).toHaveBeenCalledTimes(5)
      await vi.advanceTimersByTimeAsync(1)
      await h.openings[2].promise
      expect(h.fetch).toHaveBeenCalledTimes(7)
    } finally { await h.stop() }
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps the provider alive after a collector failure frame and accepts recovery', async () => {
    const h = harness()
    try {
      await h.openings[0].promise
      const failed = deferred<void>(), recovered = deferred<void>()
      h.observe(frame => { if (frame.ok) recovered.resolve(); else failed.resolve() })
      h.send({ kind: 'failure', code: 'collector-failed' })
      await failed.promise
      h.send({ kind: 'snapshot', value: value() })
      await recovered.promise
      expect(h.frames.map(frame => frame.ok)).toEqual([false, true])
      expect(h.fetch).toHaveBeenCalledTimes(2)
    } finally { await h.stop() }
  })

  it('requires an explicit retry when no valid Host reconnect configuration was received', async () => {
    const first = deferred<void>(), second = deferred<void>()
    const fetch = vi.fn(async () => { if (fetch.mock.calls.length === 1) { first.resolve(); return new Response('', { status: 503 }) } second.resolve(); return new Response('', { status: 503 }) })
    const owner = new MonitorResourceOwner({ fetch, hidden: () => false, observeVisibility: () => () => {} })
    const controller = new AbortController()
    const received = deferred<void>()
    const running = (async () => { for await (const _frame of owner.provider.open(MONITOR_ADDRESS, { signal: controller.signal })) received.resolve() })()
    try {
      await first.promise; await received.promise
      expect(fetch).toHaveBeenCalledOnce()
      owner.retry()
      await second.promise
      expect(fetch).toHaveBeenCalledTimes(2)
    } finally { controller.abort(); await running; await owner.dispose() }
  })

  it('shares one real resource stream across viewers and withdraws it before remount', async () => {
    const h = harness(false)
    const registry = new ResourceRegistry(new Context())
    const source = registry.source(MONITOR_ADDRESS)
    let unregister = registry.register(h.owner.provider)
    const received = deferred<void>(), failed = deferred<void>()
    const first = source.subscribe(() => {})
    const second = source.subscribe(() => {
      if (source.getSnapshot().status === 'live') received.resolve()
      if (source.getSnapshot().status === 'failed') failed.resolve()
    })
    try {
      await h.openings[0].promise
      expect(registry.source(MONITOR_ADDRESS)).toBe(source)
      expect(h.fetch).toHaveBeenCalledTimes(2)
      h.send({ kind: 'snapshot', value: value() })
      await received.promise
      h.send({ kind: 'failure', code: 'collector-failed' })
      await failed.promise
      expect(source.getSnapshot()).toMatchObject({ status: 'failed', value: value() })
      first()
      unregister()
      await h.cancellations[0].promise
      expect(source.getSnapshot().status).toBe('none')
      unregister = registry.register(h.owner.provider)
      await h.openings[1].promise
      expect(h.fetch).toHaveBeenCalledTimes(4)
      second()
      await h.cancellations[1].promise
    } finally { first(); second(); unregister(); await h.stop() }
    expect(h.listeners.size).toBe(0)
  })

  it('times out a silent stream and releases all watchdog timers on cleanup', async () => {
    vi.useFakeTimers()
    const h = harness()
    try {
      await h.openings[0].promise
      const received = deferred<void>(), failed = deferred<void>()
      h.observe(frame => { if (frame.ok) received.resolve(); else failed.resolve() })
      h.send({ kind: 'snapshot', value: value() })
      await received.promise
      await vi.advanceTimersByTimeAsync(1500)
      h.noise()
      await vi.advanceTimersByTimeAsync(1499)
      expect(h.frames.at(-1)?.ok).toBe(true)
      await vi.advanceTimersByTimeAsync(1)
      await failed.promise
      await h.cancellations[0].promise
      const last = h.frames.at(-1)
      expect(last?.ok).toBe(false)
      if (last?.ok === false && last.error.code === 'system-monitor/unavailable') expect(last.error.details.reason).toBe('stale')
      await vi.advanceTimersByTimeAsync(1000)
      await h.openings[1].promise
    } finally { await h.stop() }
    expect(vi.getTimerCount()).toBe(0)
  })

  it('joins an in-flight configuration request on disposal and does not reconnect', async () => {
    const entered = deferred<void>(), aborted = deferred<void>()
    const fetch = vi.fn((_path: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => { aborted.resolve(); reject(new DOMException('Aborted', 'AbortError')) }, { once: true })
      entered.resolve()
    }))
    const owner = new MonitorResourceOwner({ fetch, hidden: () => false, observeVisibility: () => () => {} })
    const running = (async () => { for await (const _frame of owner.provider.open(MONITOR_ADDRESS, { signal: new AbortController().signal })) { /* Disposal ends this pending read. */ } })()
    await entered.promise
    await owner.dispose()
    await aborted.promise
    await running
    expect(fetch).toHaveBeenCalledOnce()
  })
})
