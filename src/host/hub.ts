/** One demand-driven collector per Host. Streams share a bounded history and serialized worker teardown. */
import type { CollectorConfig, HistoryPoint, Sample, Snapshot, StreamFrame } from '../shared/model.ts'
export interface CollectorSource { stop(): Promise<void> }
export type SourceFactory = (sample: (value: Sample) => void, failed: (error: Error) => void) => CollectorSource
export interface MonitorSink { frame(value: StreamFrame): void; end(): void }
/** Convert one current sample to a compact history row; stale values never extend live trends. */
export function historyPoint(sample: Sample): HistoryPoint {
  return { timestamp: sample.timestamp,
    cpu: sample.cpu.status === 'live' ? sample.cpu.data?.utilization ?? null : null,
    memory: sample.memory.status === 'live' ? sample.memory.data?.utilization ?? null : null,
    gpu: Object.fromEntries((sample.gpu.data ?? []).map(gpu => [gpu.id, sample.gpu.status === 'live' ? gpu.utilization : null])),
    disks: Object.fromEntries((sample.disks.data ?? []).map(disk => [disk.id, {
      read: sample.disks.status === 'live' ? disk.readBytesPerSecond : null,
      write: sample.disks.status === 'live' ? disk.writeBytesPerSecond : null,
      active: sample.disks.status === 'live' ? disk.activePercent : null,
    }])),
  }
}
/** Own one collector, subscriber admission, idle grace, and shutdown completion. */
export class MonitorHub {
  private readonly sinks = new Set<MonitorSink>()
  private source: CollectorSource | undefined
  private idle: ReturnType<typeof setTimeout> | undefined
  private queue: Promise<void> = Promise.resolve()
  private closed = false
  private shutdownFailure: Error | undefined
  private latest: Snapshot | undefined
  private history: HistoryPoint[] = []
  constructor(private readonly config: CollectorConfig, private readonly factory: SourceFactory, private readonly report: (error: Error) => void) {}
  /** Add one stream; the returned disposer is idempotent. Closed hubs reject new admission. */
  subscribe(sink: MonitorSink): () => void {
    if (this.closed) throw new Error('System monitor is disposed')
    this.sinks.add(sink)
    if (this.idle !== undefined) { clearTimeout(this.idle); this.idle = undefined }
    if (this.latest !== undefined && this.source !== undefined) sink.frame({ kind: 'snapshot', value: this.latest })
    this.enqueue(() => this.start())
    let active = true
    return () => {
      if (!active) return
      active = false
      this.sinks.delete(sink)
      if (this.sinks.size !== 0 || this.closed) return
      this.idle = setTimeout(() => {
        this.idle = undefined
        this.enqueue(async () => { if (this.sinks.size === 0) await this.stop() })
      }, this.config.idleGraceMs)
      this.idle.unref()
    }
  }
  /** Stop admission, end all streams, and wait for the owned worker to exit. */
  async dispose(): Promise<void> {
    if (!this.closed) {
      this.closed = true
      if (this.idle !== undefined) { clearTimeout(this.idle); this.idle = undefined }
      const sinks = [...this.sinks]
      this.sinks.clear()
      for (const sink of sinks) sink.end()
      this.enqueue(() => this.stop())
    }
    let pending: Promise<void>
    do { pending = this.queue; await pending } while (pending !== this.queue)
    if (this.shutdownFailure !== undefined) throw this.shutdownFailure
  }
  private enqueue(operation: () => void | Promise<void>): void {
    this.queue = this.queue.then(operation).catch((error: unknown) => {
      if (this.shutdownFailure === undefined) this.fail(error instanceof Error ? error : new Error(String(error)))
    })
  }
  private start(): void {
    if (this.closed || this.sinks.size === 0 || this.source !== undefined) return
    this.history = []
    this.latest = undefined
    const generation = {}
    this.generation = generation
    this.source = this.factory(sample => {
      if (this.closed || this.generation !== generation) return
      const cutoff = sample.timestamp - this.config.historySeconds * 1000
      this.history.push(historyPoint(sample))
      const limit = Math.ceil(this.config.historySeconds * 1000 / this.config.intervalMs) + 1
      this.history = this.history.filter(point => point.timestamp >= cutoff).slice(-limit)
      this.latest = { ...sample, history: this.history }
      for (const sink of this.sinks) sink.frame({ kind: 'snapshot', value: this.latest })
    }, error => { if (!this.closed && this.generation === generation) this.fail(error) })
  }
  private generation: object | undefined
  private fail(error: Error): void {
    this.generation = undefined
    this.latest = undefined
    this.report(error)
    const sinks = [...this.sinks]
    this.sinks.clear()
    for (const sink of sinks) { sink.frame({ kind: 'failure', code: 'collector-failed' }); sink.end() }
    // A new subscription is serialized behind this worker's complete stop.
    this.enqueue(() => this.stop())
  }
  private async stop(): Promise<void> {
    const source = this.source
    this.generation = undefined
    this.latest = undefined
    this.history = []
    if (source === undefined) return
    try { await source.stop() }
    catch (error) {
      this.shutdownFailure = error instanceof Error ? error : new Error(String(error))
      this.closed = true
      const sinks = [...this.sinks]
      this.sinks.clear()
      for (const sink of sinks) { sink.frame({ kind: 'failure', code: 'collector-failed' }); sink.end() }
      this.report(this.shutdownFailure)
      throw this.shutdownFailure
    }
    this.source = undefined
  }
}
