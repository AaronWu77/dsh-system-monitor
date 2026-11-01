/** Pure normalization of Windows counter values; unavailable readings never become zero. */
import type { Cpu, Disk, Gpu, Memory, MetricCode, Volume } from '../shared/model.ts'

/** A PDH formatted item, before its per-item status has been checked. */
export interface CounterValue { name: string; status: number; value: number }
/** DXGI metadata is joined to PDH by the boot-local adapter LUID. */
export interface GraphicsAdapter {
  luid: string
  name: string
  dedicatedTotalBytes: number
  software: boolean
  /** Native-verified PCI bus/device/function identity; null keeps this LUID distinct. */
  physicalId: string | null
}
/** Expected native failures retain the affected domain's previous successful sample. */
export class WindowsMetricError extends Error {
  constructor(readonly code: MetricCode, message: string) { super(message); this.name = 'WindowsMetricError' }
}

/** Read valid PDH values, including zero; invalid status and non-finite values return null.
 * @param item - Native counter item.
 * @returns A nonnegative value or null when it cannot be displayed.
 */
export function counterNumber(item: CounterValue): number | null {
  return (item.status === 0 || item.status === 1) && Number.isFinite(item.value) && item.value >= 0 ? item.value : null
}
const percent = (value: number): number => Math.min(100, Math.max(0, value))

/** Format CPU totals and logical cores without including processor-group subtotals.
 * @param rows - Processor Information or Processor formatted items.
 * @param source - Counter family selected during initialization.
 * @returns Current CPU values; absent totals throw an expected unavailable failure.
 */
export function cpuValues(rows: readonly CounterValue[], source: Cpu['source']): Cpu {
  const total = rows.find(row => row.name === '_Total')
  const utilization = total ? counterNumber(total) : null
  if (utilization === null) throw new WindowsMetricError('counter-unavailable', 'CPU total counter has no valid value')
  const cores = rows.flatMap(row => {
    if (!/^(?:\d+,)?\d+$/.test(row.name)) return []
    const value = counterNumber(row)
    if (value === null) throw new WindowsMetricError('counter-unavailable', 'A logical CPU counter has no valid value')
    const parts = row.name.split(',').map(Number)
    return [{ group: parts.length === 2 ? parts[0]! : 0, index: parts.at(-1)!, value: percent(value) }]
  }).sort((a, b) => a.group - b.group || a.index - b.index)
  if (cores.length > 1024) throw new WindowsMetricError('sampling-failed', 'CPU counter count exceeds the payload limit')
  return { utilization: percent(utilization), cores: cores.map(core => core.value), source }
}

/** Compute physical-memory usage from GlobalMemoryStatusEx, not process working sets.
 * @param totalBytes - Total visible physical memory.
 * @param availableBytes - Memory available to allocation, including reclaimable memory.
 * @returns Validated physical-memory values.
 */
export function memoryValues(totalBytes: number, availableBytes: number): Memory {
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0 || !Number.isSafeInteger(availableBytes) || availableBytes < 0 || availableBytes > totalBytes) {
    throw new WindowsMetricError('sampling-failed', 'Physical memory counters are invalid')
  }
  return { totalBytes, availableBytes, usedBytes: totalBytes - availableBytes, utilization: percent((totalBytes - availableBytes) / totalBytes * 100) }
}

/** GPU counter identity, shared across process engine and adapter-memory counters. */
export interface GpuInstance { id: string; luid: string; physical: number; engine: number | null; engineType: string | null }
/** Parse driver-generated names; PID is deliberately excluded from published identities.
 * @param name - One PDH instance name.
 * @returns The adapter/engine identity, or null for an unsupported name.
 */
export function parseGpuInstance(name: string): GpuInstance | null {
  const match = /(?:^|_)luid_0x([a-f\d]{1,8})_0x([a-f\d]{1,8})_phys_(\d+)(?:_eng_(\d+)_engtype_(.+))?$/i.exec(name)
  if (!match) return null
  const physical = Number(match[3])
  const engine = match[4] === undefined ? null : Number(match[4])
  if (!Number.isSafeInteger(physical) || (engine !== null && !Number.isSafeInteger(engine))) return null
  const luid = '0x' + match[1]!.toLowerCase().padStart(8, '0') + '_0x' + match[2]!.toLowerCase().padStart(8, '0')
  return { id: 'luid_' + luid + '_phys_' + physical, luid, physical, engine, engineType: match[5] ?? null }
}

/** Aggregate each LUID separately, then select one report per confirmed PCI identity and physical node.
 * @param adapters - DXGI metadata and optional native-verified PCI identity; software adapters are omitted.
 * @param engineRows - Per-process GPU engine utilization items.
 * @param dedicatedRows - Adapter-wide dedicated usage, not per-process allocation.
 * @param sharedRows - Adapter-wide shared usage.
 * @returns Device metrics with null for unavailable fields; no usable device data throws. PCI-based ids survive alias changes; unknown devices retain LUID ids.
 * Reports are ranked by valid metric fields, then valid engine count, then LUID. Alias metrics are never combined.
 */
export function gpuValues(adapters: readonly GraphicsAdapter[], engineRows: readonly CounterValue[], dedicatedRows: readonly CounterValue[], sharedRows: readonly CounterValue[]): Gpu[] {
  const metadata = new Map(adapters.map(adapter => [adapter.luid.toLowerCase(), adapter]))
  const devices = new Map<string, { identity: GpuInstance; engines: Map<number, { name: string; value: number }>; incompleteEngines: Set<number>; dedicated: number | null; shared: number | null }>()
  const device = (identity: GpuInstance) => {
    if (metadata.get(identity.luid)?.software) return null
    let value = devices.get(identity.id)
    if (!value) {
      value = { identity, engines: new Map(), incompleteEngines: new Set(), dedicated: null, shared: null }
      devices.set(identity.id, value)
    }
    return value
  }
  for (const adapter of adapters) {
    if (!adapter.software) device({ id: 'luid_' + adapter.luid.toLowerCase() + '_phys_0', luid: adapter.luid.toLowerCase(), physical: 0, engine: null, engineType: null })
  }
  for (const row of engineRows) {
    const identity = parseGpuInstance(row.name)
    const value = counterNumber(row)
    if (!identity || identity.engine === null) continue
    const entry = device(identity)
    if (!entry) continue
    if (value === null) { entry.incompleteEngines.add(identity.engine); continue }
    const existing = entry.engines.get(identity.engine)
    entry.engines.set(identity.engine, { name: (identity.engineType ?? String(identity.engine)) + ' (' + identity.engine + ')', value: value + (existing?.value ?? 0) })
  }
  for (const [rows, field] of [[dedicatedRows, 'dedicated'], [sharedRows, 'shared']] as const) {
    for (const row of rows) {
      const identity = parseGpuInstance(row.name)
      if (!identity || identity.engine !== null) continue
      const entry = device(identity)
      if (entry) entry[field] = counterNumber(row)
    }
  }
  if (devices.size > 64) throw new WindowsMetricError('sampling-failed', 'GPU device count exceeds the payload limit')
  const selected = new Map<string, { gpu: Gpu; validFields: number }>()
  for (const entry of [...devices.values()].sort((a, b) => a.identity.id.localeCompare(b.identity.id))) {
    if (entry.engines.size > 128) throw new WindowsMetricError('sampling-failed', 'GPU engine count exceeds the payload limit')
    const adapter = metadata.get(entry.identity.luid)
    const engines = [...entry.engines.entries()].filter(([engine]) => !entry.incompleteEngines.has(engine)).sort(([a], [b]) => a - b).map(([, value]) => ({ name: value.name, utilization: percent(value.value) }))
    const id = adapter?.physicalId ? adapter.physicalId + '_phys_' + entry.identity.physical : entry.identity.id
    const gpu: Gpu = {
      id,
      name: adapter?.name ?? entry.identity.id,
      utilization: engines.length === 0 || entry.incompleteEngines.size !== 0 ? null : Math.max(...engines.map(engine => engine.utilization)),
      dedicatedUsedBytes: entry.dedicated,
      dedicatedTotalBytes: entry.identity.physical === 0 ? adapter?.dedicatedTotalBytes ?? null : null,
      sharedUsedBytes: entry.shared,
      engines,
    }
    const validFields = [gpu.utilization, gpu.dedicatedUsedBytes, gpu.sharedUsedBytes].filter(value => value !== null).length
    const previous = selected.get(id)
    if (!previous || validFields > previous.validFields || (validFields === previous.validFields && engines.length > previous.gpu.engines.length)) selected.set(id, { gpu, validFields })
  }
  const result = [...selected.values()].map(value => value.gpu).sort((a, b) => a.id.localeCompare(b.id))
  if (!result.some(gpu => gpu.utilization !== null || gpu.dedicatedUsedBytes !== null || gpu.sharedUsedBytes !== null || gpu.engines.length !== 0)) {
    throw new WindowsMetricError('counter-unavailable', 'GPU counters have no valid adapter values')
  }
  return result
}

/** Join physical disk counters and exclude the aggregate _Total row.
 * @param reads - Read-throughput items in bytes/second.
 * @param writes - Write-throughput items in bytes/second.
 * @param idle - Idle-time percentage items.
 * @returns One row per physical disk; logical volumes are not duplicated here.
 */
export function diskValues(reads: readonly CounterValue[], writes: readonly CounterValue[], idle: readonly CounterValue[]): Disk[] {
  const disks = new Map<string, Disk>()
  for (const [rows, field] of [[reads, 'readBytesPerSecond'], [writes, 'writeBytesPerSecond'], [idle, 'activePercent']] as const) {
    for (const row of rows) {
      if (row.name === '_Total') continue
      const id = /^(\d+)(?:\s|$)/.exec(row.name)?.[1] ?? row.name
      let disk = disks.get(id)
      if (!disk) { disk = { id, name: row.name, readBytesPerSecond: null, writeBytesPerSecond: null, activePercent: null }; disks.set(id, disk) }
      const value = counterNumber(row)
      disk[field] = value === null ? null : field === 'activePercent' ? percent(100 - value) : value
    }
  }
  if (disks.size > 256) throw new WindowsMetricError('sampling-failed', 'Disk device count exceeds the payload limit')
  const result = [...disks.values()]
  if (!result.some(disk => disk.readBytesPerSecond !== null || disk.writeBytesPerSecond !== null || disk.activePercent !== null)) throw new WindowsMetricError('counter-unavailable', 'Physical disk counters have no valid values')
  return result
}

/** Normalize a mounted volume's capacity; zero total capacity is not a usable volume.
 * @param id - Drive root identifier.
 * @param totalBytes - Total volume capacity.
 * @param freeBytes - Total free bytes, independent of caller disk quotas.
 * @returns Volume capacity values.
 */
export function volumeValues(id: string, totalBytes: number, freeBytes: number): Volume {
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0 || !Number.isSafeInteger(freeBytes) || freeBytes < 0 || freeBytes > totalBytes) throw new WindowsMetricError('sampling-failed', 'Volume capacity values are invalid')
  return { id, totalBytes, freeBytes, usedBytes: totalBytes - freeBytes, utilization: percent((totalBytes - freeBytes) / totalBytes * 100) }
}
