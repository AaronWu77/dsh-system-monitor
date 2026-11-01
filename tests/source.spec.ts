import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { workerSourceFactory } from '../src/host/source.ts'
import { testConfig } from './host-fixtures.ts'
const state = vi.hoisted(() => ({ mode: 'clean', terminated: 0, stopped: 0 }))
vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events')
  return { Worker: class extends EventEmitter {
    postMessage() {
      state.stopped += 1
      if (state.mode === 'throw') throw new Error('control-port-failed')
      if (state.mode === 'timeout') return
      queueMicrotask(() => this.emit('exit', state.mode === 'clean' ? 0 : 1))
    }
    async terminate() { state.terminated += 1; this.emit('exit', 1); return 1 }
  } }
})
afterEach(() => { state.mode = 'clean'; state.terminated = 0; state.stopped = 0; vi.useRealTimers() })
describe('owned Worker shutdown', () => {
  it('joins a normal exit and sends stop once', async () => {
    const failed = vi.fn(), report = vi.fn()
    const source = workerSourceFactory(testConfig, report)(vi.fn(), failed)
    await Promise.all([source.stop(), source.stop()])
    expect(state.stopped).toBe(1)
    expect(state.terminated).toBe(0)
    expect(failed).not.toHaveBeenCalled()
    expect(report).not.toHaveBeenCalled()
  })
  it('does not claim a failed graceful cleanup succeeded', async () => {
    state.mode = 'error'
    const source = workerSourceFactory(testConfig, vi.fn())(vi.fn(), vi.fn())
    await expect(source.stop()).rejects.toThrow('failed during graceful shutdown: 1')
    expect(state.terminated).toBe(0)
  })
  it('still terminates and joins when the control operation throws', async () => {
    state.mode = 'throw'
    const source = workerSourceFactory(testConfig, vi.fn())(vi.fn(), vi.fn())
    await expect(source.stop()).rejects.toThrow('control-port-failed')
    expect(state.terminated).toBe(1)
  })
  it('joins forced termination before reporting the shutdown deadline', async () => {
    vi.useFakeTimers()
    state.mode = 'timeout'
    const report = vi.fn(() => { expect(state.terminated).toBe(1) })
    const source = workerSourceFactory(testConfig, report)(vi.fn(), vi.fn())
    const done = source.stop()
    await vi.advanceTimersByTimeAsync(testConfig.workerStopTimeoutMs)
    await done
    expect(report).toHaveBeenCalledOnce()
  })
})
