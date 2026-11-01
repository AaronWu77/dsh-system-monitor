/** Synchronous collector invoked only by the dedicated sampling Worker. */
import { availableParallelism, cpus, hostname } from 'node:os'
import type { Collector, CollectorConfig, Cpu, Disk, Gpu, Memory, Metric, Sample, Volume } from '../shared/model.ts'
import { createWindowsNative, type WindowsNative } from './windows-native.ts'
import { cpuValues, diskValues, gpuValues, WindowsMetricError, type GraphicsAdapter } from './windows-metrics.ts'

/** Immutable machine metadata and clocks supplied by the owning Worker. */
export interface CollectorIdentity {
  hostName: string
  cpuName: string
  logicalProcessors: number
  now(): number
  monotonic(): number
}
const empty = <T>(): Metric<T> => ({ status: 'unavailable', data: null, sampledAt: null, code: null })

function attempt<T>(previous: Metric<T>, timestamp: number, read: () => T): Metric<T> {
  try { return { status: 'live', data: read(), sampledAt: timestamp, code: null } }
  catch (error) {
    if (!(error instanceof WindowsMetricError)) throw error
    const status = error.code === 'warming-up' ? 'warming' : error.code === 'counter-unavailable' || error.code === 'unsupported-platform' ? 'unavailable' : 'error'
    return { status, data: previous.data, sampledAt: previous.sampledAt, code: error.code }
  }
}

/** Own metric retention and refresh cadence independently of the native bindings.
 * @param config - Validated collection intervals and enabled device domains.
 * @param native - Thread-local PDH and kernel accessor whose ownership transfers here.
 * @param identity - Machine metadata and monotonic/wall clocks.
 */
export class WindowsCollector implements Collector {
  private closed = false
  private primed = false
  private cpu: Metric<Cpu> = empty()
  private memory: Metric<Memory> = empty()
  private gpu: Metric<Gpu[]> = empty()
  private disks: Metric<Disk[]> = empty()
  private volumes: Metric<Volume[]> = empty()
  private capacityAttempt = -Infinity
  private adapterAttempt = -Infinity
  private adapters: GraphicsAdapter[] = []
  private adapterFailure: WindowsMetricError | null = null
  constructor(private readonly config: CollectorConfig, private readonly native: WindowsNative, private readonly identity: CollectorIdentity) {}

  /** Sample all enabled domains; expected native failures affect only their domain.
   * @returns A versioned sample. Retained values keep their original sampledAt.
   */
  collect(): Sample {
    if (this.closed) throw new Error('The Windows collector is closed')
    const start = this.identity.monotonic()
    const timestamp = this.identity.now()
    const warming = !this.primed
    let queryFailure: WindowsMetricError | null = null
    try { this.native.collect(); this.primed = true }
    catch (error) {
      if (!(error instanceof WindowsMetricError)) throw error
      queryFailure = error
      this.primed = false
    }
    const rate = <T>(previous: Metric<T>, read: () => T): Metric<T> => attempt(previous, timestamp, () => {
      if (queryFailure) throw queryFailure
      if (warming) throw new WindowsMetricError('warming-up', 'Rate counters require a second sample')
      return read()
    })
    this.cpu = rate(this.cpu, () => cpuValues(this.native.readCounter('cpu'), this.native.cpuSource))
    this.memory = attempt(this.memory, timestamp, () => this.native.readMemory())
    if (this.config.gpuEnabled) this.gpu = rate(this.gpu, () => this.readGpu(start))
    if (this.config.disksEnabled) {
      this.disks = rate(this.disks, () => diskValues(this.native.readCounter('read'), this.native.readCounter('write'), this.native.readCounter('idle')))
      if (start - this.capacityAttempt >= this.config.capacityIntervalMs) {
        this.capacityAttempt = start
        this.volumes = attempt(this.volumes, timestamp, () => this.native.readVolumes())
      }
    }
    return {
      schemaVersion: 1, timestamp,
      hostName: this.identity.hostName, cpuName: this.identity.cpuName, logicalProcessors: this.identity.logicalProcessors,
      intervalMs: this.config.intervalMs, collectionMs: Math.max(0, this.identity.monotonic() - start),
      cpu: this.cpu, memory: this.memory, gpu: this.gpu, disks: this.disks, volumes: this.volumes,
    }
  }

  private readGpu(monotonic: number): Gpu[] {
    if (monotonic - this.adapterAttempt >= this.config.capacityIntervalMs) {
      this.adapterAttempt = monotonic
      try { this.adapters = this.native.readAdapters(); this.adapterFailure = null }
      catch (error) {
        if (!(error instanceof WindowsMetricError)) throw error
        this.adapterFailure = error
      }
    }
    if (this.adapterFailure) throw this.adapterFailure
    return gpuValues(this.adapters, this.native.readCounter('gpu'), this.native.readCounter('dedicated'), this.native.readCounter('shared'))
  }

  /** Idempotently release the query; collection after close is a programming error. */
  close(): void {
    if (this.closed) return
    this.closed = true
    this.native.close()
  }
}

/** Create a local Windows x64 collector; this never follows a Session's SSH provider.
 * @param config - Host-validated collection configuration.
 * @returns A synchronous, Worker-owned collector; the caller must close it.
 */
export function createWindowsCollector(config: CollectorConfig): Collector {
  const processors = cpus()
  const identity: CollectorIdentity = {
    hostName: hostname(), cpuName: processors[0]?.model ?? '', logicalProcessors: processors.length || availableParallelism(),
    now: () => Date.now(), monotonic: () => performance.now(),
  }
  if (identity.logicalProcessors > 1024) throw new WindowsMetricError('unsupported-platform', 'Logical processor count exceeds the supported payload limit')
  return new WindowsCollector(config, createWindowsNative(config), identity)
}
