/** Worker ownership. Native DLL calls never execute on the DSH Host's event-loop thread. */
import { Worker } from 'node:worker_threads'
import type { CollectorConfig } from '../shared/model.ts'
import { sampleSchema } from '../shared/model.ts'
import type { SourceFactory } from './hub.ts'
/** Create the production source factory; every stop joins the exact worker it owns. */
export function workerSourceFactory(config: CollectorConfig, report: (error: Error) => void): SourceFactory {
  return (publish, failed) => {
    const worker = new Worker(new URL('./collector-worker.js', import.meta.url), { workerData: config, name: 'dsh-system-monitor' })
    let stopping = false
    let finished = false
    let failureSent = false
    let stopPromise: Promise<void> | undefined
    const fail = (error: Error): void => { if (!stopping && !failureSent) { failureSent = true; failed(error) } }
    const exited = new Promise<number>(resolve => {
      worker.once('exit', code => { finished = true; if (!stopping) fail(new Error('System monitor worker exited unexpectedly: ' + String(code))); resolve(code) })
    })
    worker.on('error', fail)
    worker.on('message', (input: unknown) => {
      if (stopping || failureSent) return
      const value = sampleSchema.safeParse(input)
      if (!value.success) { fail(new Error('System monitor worker returned an invalid sample')); return }
      publish(value.data)
    })
    return {
      stop(): Promise<void> {
        stopPromise ??= (async () => {
          stopping = true
          if (finished) return
          let timer: ReturnType<typeof setTimeout> | undefined
          let exceeded = false
          let forced = false
          try {
            worker.postMessage({ kind: 'stop' })
            const clean = await Promise.race([exited.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), config.workerStopTimeoutMs) })])
            exceeded = !clean
          } finally {
            if (timer !== undefined) clearTimeout(timer)
            if (!finished) { forced = true; await worker.terminate() }
            const code = await exited
            if (!forced && code !== 0) throw new Error('System monitor worker failed during graceful shutdown: ' + String(code))
          }
          if (exceeded) report(new Error('System monitor worker exceeded its shutdown deadline and was terminated'))
        })()
        return stopPromise
      },
    }
  }
}
