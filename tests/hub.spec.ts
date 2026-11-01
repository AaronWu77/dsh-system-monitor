import { afterEach, describe, expect, it, vi } from 'vitest'
import { MonitorHub, historyPoint } from '../src/host/hub.ts'
import type { MonitorSink } from '../src/host/hub.ts'
import type { Sample, StreamFrame } from '../src/shared/model.ts'
import { deferred, sample, testConfig } from './host-fixtures.ts'
afterEach(() => vi.useRealTimers())
describe('Host shared collector', () => {
  it('starts lazily, shares one source and bounds history across simultaneous viewers', async () => {
    vi.useFakeTimers()
    const started = deferred<void>()
    let publish!: (value: Sample) => void
    const stop = vi.fn(async () => {})
    const factory = vi.fn((next: (value: Sample) => void) => { publish = next; started.resolve(); return { stop } })
    const report = vi.fn()
    const hub = new MonitorHub(testConfig, factory, report)
    const a: StreamFrame[] = [], b: StreamFrame[] = []
    expect(factory).not.toHaveBeenCalled()
    const releaseA = hub.subscribe({ frame: value => a.push(value), end: vi.fn() })
    const releaseB = hub.subscribe({ frame: value => b.push(value), end: vi.fn() })
    await started.promise
    expect(factory).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 200; i++) publish(sample(i * 1000))
    const last = a.at(-1)
    expect(last?.kind).toBe('snapshot')
    if (last?.kind !== 'snapshot') throw new Error('Missing snapshot')
    expect(last.value.history).toHaveLength(61)
    expect(last.value.history[0]?.timestamp).toBe(139000)
    expect(b).toEqual(a)
    releaseA(); releaseA()
    await vi.advanceTimersByTimeAsync(100)
    expect(stop).not.toHaveBeenCalled()
    releaseB()
    await vi.advanceTimersByTimeAsync(100)
    expect(stop).toHaveBeenCalledTimes(1)
    await hub.dispose()
    expect(report).not.toHaveBeenCalled()
  })
  it('waits for a stopping worker before starting another and joins it on unload', async () => {
    vi.useFakeTimers()
    const starts = [deferred<void>(), deferred<void>()]
    const stopping = deferred<void>()
    const done = deferred<void>()
    const factory = vi.fn(() => { const n = factory.mock.calls.length - 1; starts[n]?.resolve(); return { stop: () => n === 0 ? stopping.promise : done.promise } })
    const hub = new MonitorHub(testConfig, factory, vi.fn())
    const sink: MonitorSink = { frame: vi.fn(), end: vi.fn() }
    const release = hub.subscribe(sink)
    await starts[0]?.promise
    release()
    await vi.advanceTimersByTimeAsync(100)
    hub.subscribe(sink)
    expect(factory).toHaveBeenCalledTimes(1)
    stopping.resolve()
    await starts[1]?.promise
    expect(factory).toHaveBeenCalledTimes(2)
    let disposed = false
    const disposal = hub.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    expect(sink.end).toHaveBeenCalledTimes(1)
    done.resolve()
    await disposal
    expect(disposed).toBe(true)
    expect(() => hub.subscribe(sink)).toThrow('disposed')
  })
  it('ends failed streams visibly and rejects late samples from the old source', async () => {
    const started = deferred<void>()
    let publish!: (value: Sample) => void
    let fail!: (error: Error) => void
    const stop = vi.fn(async () => {})
    const report = vi.fn()
    const hub = new MonitorHub(testConfig, (next, failed) => { publish = next; fail = failed; started.resolve(); return { stop } }, report)
    const frames: StreamFrame[] = []
    const end = vi.fn()
    hub.subscribe({ frame: value => frames.push(value), end })
    await started.promise
    publish(sample())
    fail(new Error('native failure'))
    publish(sample(2000))
    expect(frames.at(-1)).toEqual({ kind: 'failure', code: 'collector-failed' })
    expect(end).toHaveBeenCalledOnce()
    await hub.dispose()
    expect(stop).toHaveBeenCalledOnce()
    expect(report).toHaveBeenCalledOnce()
  })
  it('fails closed and reports unsuccessful cleanup without starting a replacement', async () => {
    vi.useFakeTimers()
    const started = deferred<void>()
    const failure = new Error('controlled-stop-rejection')
    const stop = vi.fn(async () => { throw failure })
    const factory = vi.fn(() => { started.resolve(); return { stop } })
    const report = vi.fn()
    const hub = new MonitorHub(testConfig, factory, report)
    const sink = { frame: vi.fn(), end: vi.fn() }
    const release = hub.subscribe(sink)
    await started.promise
    release()
    await vi.advanceTimersByTimeAsync(testConfig.idleGraceMs)
    expect(() => hub.subscribe(sink)).toThrow('disposed')
    await expect(hub.dispose()).rejects.toThrow('controlled-stop-rejection')
    expect(factory).toHaveBeenCalledOnce()
    expect(stop).toHaveBeenCalledOnce()
    expect(report).toHaveBeenCalledWith(failure)
  })
  it('does not invent zero samples when a previously valid domain fails', () => {
    const value = sample()
    value.cpu = { ...value.cpu, status: 'error', code: 'sampling-failed' }
    value.gpu = { ...value.gpu, status: 'unavailable', code: 'counter-unavailable' }
    const point = historyPoint(value)
    expect(point.cpu).toBeNull()
    expect(point.gpu['gpu-a']).toBeNull()
    expect(point.disks['0']).toEqual({ read: 0, write: 0, active: 0 })
  })
})
