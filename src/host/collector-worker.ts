/** Private worker entry: one retained native collector, no subprocesses and no overlapping reads. */
import { parentPort, workerData } from 'node:worker_threads'
import { collectorConfigSchema, sampleSchema } from '../shared/model.ts'
import { createWindowsCollector } from './windows.ts'
const port = parentPort
if (port === null) throw new Error('System monitor collector requires a Worker parent')
const config = collectorConfigSchema.parse(workerData)
const collector = createWindowsCollector(config)
let timer: ReturnType<typeof setTimeout> | undefined
let closed = false
const close = (): void => {
  if (closed) return
  closed = true
  if (timer !== undefined) clearTimeout(timer)
  try { collector.close() } finally { port.close() }
}
port.on('message', (input: unknown) => {
  if (typeof input !== 'object' || input === null || !('kind' in input) || input.kind !== 'stop') throw new Error('Invalid collector control message')
  close()
})
const tick = (): void => {
  if (closed) return
  const started = performance.now()
  try {
    port.postMessage(sampleSchema.parse(collector.collect()))
  } catch (error) {
    close()
    throw error
  }
  timer = setTimeout(tick, Math.max(0, config.intervalMs - (performance.now() - started)))
}
tick()
