import { describe, expect, it, vi } from 'vitest'
import { MonitorHub } from '../src/host/hub.ts'
import { monitorRoutes } from '../src/host/route.ts'
import { streamFrameSchema } from '../src/shared/model.ts'
import type { Sample } from '../src/shared/model.ts'
import { deferred, sample, testConfig } from './host-fixtures.ts'
describe('authenticated-route payloads', () => {
  it('returns effective Host config without starting a collector', async () => {
    const factory = vi.fn()
    const hub = new MonitorHub(testConfig, factory, vi.fn())
    const route = monitorRoutes(hub, testConfig)[0]
    if (!route) throw new Error('Missing configuration route')
    const response = await route.fetch(new Request('http://test/api/dsh-system-monitor/config'))
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ reconnectMs: 1000, intervalMs: 1000, streamTimeoutMs: 30000 })
    expect(factory).not.toHaveBeenCalled()
    await hub.dispose()
  })
  it('streams newline-delimited frames, bounds a suspended reader and releases on disconnect', async () => {
    const started = deferred<void>()
    let publish!: (value: Sample) => void
    const stopped = vi.fn(async () => {})
    const hub = new MonitorHub({ ...testConfig, idleGraceMs: 0 }, next => { publish = next; started.resolve(); return { stop: stopped } }, vi.fn())
    const route = monitorRoutes(hub, testConfig)[1]
    if (!route) throw new Error('Missing stream route')
    const abort = new AbortController()
    const response = await route.fetch(new Request('http://test/api/dsh-system-monitor/stream', { signal: abort.signal }))
    const reader = response.body?.getReader()
    if (!reader) throw new Error('Missing stream body')
    await started.promise
    for (let i = 1; i <= 200; i++) publish(sample(i * 1000))
    const first = await reader.read()
    const text = new TextDecoder().decode(first.value)
    expect(text.endsWith('\n')).toBe(true)
    const frame = streamFrameSchema.parse(JSON.parse(text))
    expect(frame.kind === 'snapshot' && frame.value.timestamp).toBe(1000)
    const next = reader.read()
    publish(sample(201000))
    const second = streamFrameSchema.parse(JSON.parse(new TextDecoder().decode((await next).value)))
    expect(second.kind === 'snapshot' && second.value.timestamp).toBe(201000)
    abort.abort()
    expect((await reader.read()).done).toBe(true)
    await hub.dispose()
    expect(stopped).toHaveBeenCalledOnce()
  })
  it('does not start a collector for an already aborted request', async () => {
    const factory = vi.fn()
    const hub = new MonitorHub(testConfig, factory, vi.fn())
    const route = monitorRoutes(hub, testConfig)[1]
    const abort = new AbortController(); abort.abort()
    const response = await route!.fetch(new Request('http://test/api/dsh-system-monitor/stream', { signal: abort.signal }))
    expect(await response.text()).toBe('')
    expect(factory).not.toHaveBeenCalled()
    await hub.dispose()
  })
})
