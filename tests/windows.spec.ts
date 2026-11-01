/** Native parsing and collector state use fixed counters and instance-local clocks. */
import { describe, expect, it, vi } from 'vitest'
import koffi from 'koffi'
import { counterNumber, cpuValues, diskValues, gpuValues, memoryValues, parseGpuInstance, volumeValues, WindowsMetricError, type CounterValue, type GraphicsAdapter } from '../src/host/windows-metrics.ts'
import { WindowsCollector, type CollectorIdentity } from '../src/host/windows.ts'
import { readAdapterPhysicalId, type CounterKey, type WindowsNative } from '../src/host/windows-native.ts'
import { sampleSchema, type CollectorConfig } from '../src/shared/model.ts'

const config: CollectorConfig = { intervalMs: 1000, capacityIntervalMs: 60000, historySeconds: 60, idleGraceMs: 0, workerStopTimeoutMs: 1000, reconnectMs: 1000, streamTimeoutMs: 15000, gpuEnabled: true, disksEnabled: true }
const row = (name: string, value: number, status = 0): CounterValue => ({ name, value, status })
const luid = '0x00000000_0x000112cb'
const memoryName = 'luid_' + luid + '_phys_0'
const engineName = (pid: number, engine = 0, adapter = luid, physical = 0) => 'pid_' + pid + '_luid_' + adapter + '_phys_' + physical + '_eng_' + engine + '_engtype_' + (engine === 0 ? '3D' : 'Copy')
const adapter: GraphicsAdapter = { luid, name: 'Fixture GPU', dedicatedTotalBytes: 1000, software: false, physicalId: null }
const pciAdapter: GraphicsAdapter = { ...adapter, physicalId: 'pci_01_00_0' }
const alias: GraphicsAdapter = { ...pciAdapter, luid: '0x00000000_0x0001ceb8' }
const pciId = 'pci_01_00_0_phys_0'
const adapterMemory = (adapter: GraphicsAdapter, physical = 0) => 'luid_' + adapter.luid + '_phys_' + physical

describe('Windows counter normalization', () => {
  it('keeps zero and both success statuses but not unavailable or non-finite values', () => {
    expect(counterNumber(row('idle', 0))).toBe(0)
    expect(counterNumber(row('new', 0, 1))).toBe(0)
    for (const entry of [row('bad-status', 0, 0xc0000bc6), row('negative', -1), row('nan', NaN), row('infinite', Infinity)]) expect(counterNumber(entry)).toBeNull()
  })

  it('sorts logical cores and excludes processor-group subtotals', () => {
    expect(cpuValues([row('_Total', 0), row('0,_Total', 100), row('1,0', 40), row('0,10', 30), row('0,2', 20)], 'processor-utility')).toEqual({ utilization: 0, cores: [20, 30, 40], source: 'processor-utility' })
    expect(cpuValues([row('_Total', 140), row('0', 120), row('1', 0)], 'processor-time')).toMatchObject({ utilization: 100, cores: [100, 0] })
    expect(() => cpuValues([row('_Total', 0, 2)], 'processor-utility')).toThrow(WindowsMetricError)
    expect(() => cpuValues([], 'processor-utility')).toThrow(WindowsMetricError)
    expect(() => cpuValues([row('_Total', 10), row('0,0', 0, 2)], 'processor-utility')).toThrow(WindowsMetricError)
  })

  it('distinguishes available physical memory from allocated process memory', () => {
    expect(memoryValues(1000, 1000)).toEqual({ totalBytes: 1000, availableBytes: 1000, usedBytes: 0, utilization: 0 })
    expect(memoryValues(1000, 0).utilization).toBe(100)
    expect(() => memoryValues(0, 0)).toThrow(WindowsMetricError)
    expect(() => memoryValues(1000, 1001)).toThrow(WindowsMetricError)
    expect(() => memoryValues(Infinity, 0)).toThrow(WindowsMetricError)
  })

  it('normalizes hexadecimal LUID casing without exposing the process id', () => {
    expect(parseGpuInstance('pid_99_luid_0x0_0x112CB_phys_0_eng_2_engtype_VideoDecode')).toEqual({ id: memoryName, luid, physical: 0, engine: 2, engineType: 'VideoDecode' })
    expect(parseGpuInstance(memoryName)).toMatchObject({ id: memoryName, engine: null })
    expect(parseGpuInstance('bad')).toBeNull()
    expect(parseGpuInstance('luid_0x0_0x1_phys_99999999999999999999')).toBeNull()
  })

  it('sums processes on one engine and takes the busiest engine instead of summing engines', () => {
    const values = gpuValues([adapter], [row(engineName(1), 30), row(engineName(2), 40), row(engineName(1, 1), 50)], [row(memoryName, 600)], [row(memoryName, 100)])
    expect(values).toEqual([{ id: memoryName, name: 'Fixture GPU', utilization: 70, dedicatedUsedBytes: 600, dedicatedTotalBytes: 1000, sharedUsedBytes: 100, engines: [{ name: '3D (0)', utilization: 70 }, { name: 'Copy (1)', utilization: 50 }] }])
  })

  it('preserves zero while keeping unavailable GPU fields null', () => {
    const [value] = gpuValues([adapter], [row(engineName(1), 0)], [row(memoryName, 0)], [row(memoryName, 0, 2)])
    expect(value).toMatchObject({ utilization: 0, dedicatedUsedBytes: 0, sharedUsedBytes: null })
    expect(() => gpuValues([adapter], [row(engineName(1), NaN), row(engineName(2), 10, 2)], [], [])).toThrow(WindowsMetricError)
    expect(() => gpuValues([], [row('unknown', 10)], [], [])).toThrow(WindowsMetricError)
  })

  it('does not turn an incomplete per-process engine aggregate into a false idle reading', () => {
    const [gpu] = gpuValues([adapter], [row(engineName(1), 0), row(engineName(2), 50, 2), row(engineName(3, 1), 40)], [], [])
    expect(gpu).toMatchObject({ utilization: null, dedicatedUsedBytes: null, engines: [{ name: 'Copy (1)', utilization: 40 }] })
    expect(gpuValues([adapter], [row(engineName(1), 0), row(engineName(2), NaN)], [row(memoryName, 0)], [])[0]).toMatchObject({ utilization: null, dedicatedUsedBytes: 0, engines: [] })
  })

  it('keeps adapters and physical nodes separate and omits software rendering', () => {
    const otherLuid = '0x00000000_0x00000100'
    const other: GraphicsAdapter = { ...adapter, luid: otherLuid, name: adapter.name }
    const software: GraphicsAdapter = { ...adapter, luid: '0x00000000_0x00000200', software: true }
    const values = gpuValues([adapter, other, software], [row(engineName(1), 60), row(engineName(2), 70), row(engineName(3, 0, luid, 1), 15), row(engineName(4, 0, otherLuid), 5), row(engineName(5, 0, software.luid), 100)], [], [])
    expect(values).toHaveLength(3)
    expect(values.find(value => value.id === memoryName)?.utilization).toBe(100)
    expect(values.find(value => value.id.endsWith('_phys_1'))).toMatchObject({ utilization: 15, dedicatedTotalBytes: null })
    expect(values.find(value => value.id.includes(otherLuid))?.utilization).toBe(5)
  })

  it('merges confirmed PCI aliases without hiding AMD or another identical model on a different PCI address', () => {
    const amd: GraphicsAdapter = { ...pciAdapter, luid: '0x00000000_0x00013917', physicalId: 'pci_13_00_0', name: 'AMD iGPU', dedicatedTotalBytes: 200 }
    const second: GraphicsAdapter = { ...pciAdapter, luid: '0x00000000_0x00000300', physicalId: 'pci_02_00_0' }
    const values = gpuValues([pciAdapter, amd, alias, second], [row(engineName(1), 40), row(engineName(2, 0, amd.luid), 0), row(engineName(3, 0, second.luid), 60)], [row(memoryName, 600), row(adapterMemory(amd), 0)], [])
    expect(values).toHaveLength(3)
    expect(values.find(value => value.id === pciId)).toMatchObject({ name: adapter.name, utilization: 40, dedicatedUsedBytes: 600 })
    expect(values.find(value => value.name === 'AMD iGPU')).toMatchObject({ id: 'pci_13_00_0_phys_0', utilization: 0, dedicatedUsedBytes: 0 })
    expect(values.filter(value => value.name === adapter.name).map(value => value.utilization).sort()).toEqual([40, 60])
  })

  it('retains different unknown LUIDs even when name and capacity match a known or unknown adapter', () => {
    const unknown = { ...alias, physicalId: null }
    const otherUnknown = { ...unknown, luid: '0x00000000_0x00000300' }
    const values = gpuValues([pciAdapter, unknown, otherUnknown], [row(engineName(1), 0)], [], [])
    expect(values).toHaveLength(3)
    for (const item of [unknown, otherUnknown]) expect(values.find(value => value.id === adapterMemory(item))).toMatchObject({ utilization: null, dedicatedUsedBytes: null, sharedUsedBytes: null, engines: [] })
  })

  it('selects a single complete alias report without double counting and keeps its physical id stable', () => {
    const engineRows = [row(engineName(1), 30), row(engineName(2, 0, alias.luid), 40)]
    const dedicated = [row(memoryName, 600), row(adapterMemory(alias), 900)]
    const shared = [row(memoryName, 100), row(adapterMemory(alias), 150)]
    const first = gpuValues([pciAdapter, alias], engineRows, dedicated, shared)
    expect(first).toEqual([{ id: pciId, name: adapter.name, utilization: 30, dedicatedUsedBytes: 600, dedicatedTotalBytes: 1000, sharedUsedBytes: 100, engines: [{ name: '3D (0)', utilization: 30 }] }])
    expect(gpuValues([alias, pciAdapter], [...engineRows].reverse(), [...dedicated].reverse(), [...shared].reverse())).toEqual(first)
    const switched = gpuValues([pciAdapter, alias], [row(engineName(1), 0, 2), engineRows[1]!], dedicated, [row(memoryName, 0, 2), shared[1]!])
    expect(switched).toEqual([{ ...first[0]!, utilization: 40, dedicatedUsedBytes: 900, sharedUsedBytes: 150, engines: [{ name: '3D (0)', utilization: 40 }] }])
    expect(gpuValues([alias], [engineRows[1]!], [dedicated[1]!], [shared[1]!])).toEqual(switched)
  })

  it('uses valid engine coverage to choose an equally complete report without summing aliases', () => {
    const [gpu] = gpuValues([pciAdapter, alias], [row(engineName(1), 10), row(engineName(2, 0, alias.luid), 30), row(engineName(3, 1, alias.luid), 40)], [], [])
    expect(gpu).toMatchObject({ id: pciId, utilization: 40, engines: [{ name: '3D (0)', utilization: 30 }, { name: 'Copy (1)', utilization: 40 }] })
  })

  it('uses confirmed identity rather than matching model names or dedicated capacity', () => {
    const renamed = { ...alias, name: 'Render alias', dedicatedTotalBytes: 2000 }
    const [gpu] = gpuValues([pciAdapter, renamed], [row(engineName(1, 0, renamed.luid), 0)], [row(adapterMemory(renamed), 0)], [])
    expect(gpu).toMatchObject({ id: pciId, name: 'Render alias', utilization: 0, dedicatedUsedBytes: 0, dedicatedTotalBytes: 2000 })
    expect(gpuValues([pciAdapter, renamed], [row(engineName(1, 0, renamed.luid), 0)], [], [])).toHaveLength(1)
  })

  it('does not stitch complementary partial reports into fabricated complete metrics', () => {
    const [value] = gpuValues([pciAdapter, alias], [row(engineName(1), 30)], [row(adapterMemory(alias), 600)], [row(adapterMemory(alias), 100)])
    expect(value).toMatchObject({ id: pciId, utilization: null, dedicatedUsedBytes: 600, sharedUsedBytes: 100, engines: [] })
    expect(() => gpuValues([pciAdapter, alias], [row(engineName(1), 0, 2)], [row(adapterMemory(alias), NaN)], [])).toThrow(WindowsMetricError)
  })

  it('keeps physical nodes distinct while deduplicating aliases within each node', () => {
    const values = gpuValues([pciAdapter, alias], [row(engineName(1), 10), row(engineName(2, 0, alias.luid), 20), row(engineName(3, 0, luid, 1), 30), row(engineName(4, 0, alias.luid, 1), 40)], [], [])
    expect(values.map(value => ({ id: value.id, utilization: value.utilization, capacity: value.dedicatedTotalBytes }))).toEqual([{ id: pciId, utilization: 10, capacity: 1000 }, { id: 'pci_01_00_0_phys_1', utilization: 30, capacity: null }])
  })

  it('does not count logical partitions or the total as additional physical disks', () => {
    const values = diskValues([row('0 D: E:', 0), row('1 C:', 20), row('_Total', 20)], [row('0 D: E:', 5), row('1 C:', 0)], [row('0 D: E:', 100), row('1 C:', 75)])
    expect(values).toEqual([{ id: '0', name: '0 D: E:', readBytesPerSecond: 0, writeBytesPerSecond: 5, activePercent: 0 }, { id: '1', name: '1 C:', readBytesPerSecond: 20, writeBytesPerSecond: 0, activePercent: 25 }])
    expect(diskValues([row('0 D: E:', NaN)], [row('0 D: E:', 0)], [])[0]).toMatchObject({ readBytesPerSecond: null, writeBytesPerSecond: 0, activePercent: null })
    expect(() => diskValues([row('_Total', 1)], [], [])).toThrow(WindowsMetricError)
  })

  it('computes volume capacity independently of physical disk rates', () => {
    expect(volumeValues('D:', 1000, 1000)).toEqual({ id: 'D:', totalBytes: 1000, freeBytes: 1000, usedBytes: 0, utilization: 0 })
    expect(volumeValues('E:', 1000, 0).utilization).toBe(100)
    for (const [total, free] of [[0, 0], [10, 11], [10, -1], [NaN, 0], [Number.MAX_SAFE_INTEGER + 1, 0]]) expect(() => volumeValues('C:', total!, free!)).toThrow(WindowsMetricError)
  })
})

const nativeLuid = Buffer.from('78563412efcdab90', 'hex')
function identityApi(replies: { status: number; address?: [number, number, number] }[]) {
  const open = vi.fn((data: Buffer) => {
    expect(data.length).toBe(12)
    expect(data.subarray(0, 8)).toEqual(nativeLuid)
    expect(data.readUInt32LE(8)).toBe(0)
    data.writeUInt32LE(0xfedcba98, 8)
    return 0
  })
  const query = vi.fn((data: Buffer) => {
    expect(data.length).toBe(24)
    expect(data.readUInt32LE(0)).toBe(0xfedcba98)
    expect(data.readUInt32LE(16)).toBe(12)
    const reply = replies.shift()
    if (!reply) throw new Error('Unexpected adapter identity query')
    if (reply.address) koffi.encode(data.readBigUInt64LE(8), 'uint32', reply.address, 3)
    return reply.status
  })
  const close = vi.fn((data: Buffer) => {
    expect(data.length).toBe(4)
    expect(data.readUInt32LE()).toBe(0xfedcba98)
    return 0
  })
  return { open, query, close }
}

describe('Worker-local D3DKMT PCI identity', () => {
  it('uses the native LUID and uint32 handle layouts, query type 6, and closes the adapter', () => {
    const api = identityApi([{ status: 0, address: [1, 0, 0] }])
    expect(readAdapterPhysicalId(nativeLuid, api)).toBe('pci_01_00_0')
    expect(api.open).toHaveBeenCalledTimes(1)
    expect(api.query.mock.calls.map(([data]) => data.readUInt32LE(4))).toEqual([6])
    expect(api.close).toHaveBeenCalledTimes(1)
  })

  it.each([
    { status: -1073741811 },
    { status: 0, address: [0xffffffff, 0xffff, 0xffff] as [number, number, number] },
    { status: 0, address: [256, 0, 0] as [number, number, number] },
    { status: 0, address: [0, 32, 0] as [number, number, number] },
    { status: 0, address: [0, 0, 8] as [number, number, number] },
  ])('uses official render address type 53 when ordinary address is unavailable: %j', reply => {
    const api = identityApi([reply, { status: 0, address: [19, 2, 7] }])
    const types: number[] = []
    const query = (data: Buffer) => { types.push(data.readUInt32LE(4)); return api.query(data) }
    expect(readAdapterPhysicalId(nativeLuid, { ...api, query })).toBe('pci_13_02_7')
    expect(types).toEqual([6, 53])
    expect(api.close).toHaveBeenCalledTimes(1)
  })

  it('keeps failed opens unknown and does not close an unopened handle', () => {
    const api = identityApi([])
    api.open.mockReturnValueOnce(-1073741811)
    expect(readAdapterPhysicalId(nativeLuid, api)).toBeNull()
    expect(api.query).not.toHaveBeenCalled()
    expect(api.close).not.toHaveBeenCalled()
  })

  it('keeps failed queries, sentinel render addresses, and unwritten output unknown instead of inventing PCI zero', () => {
    for (const replies of [
      [{ status: -1073741811 }, { status: -1073741811 }],
      [{ status: 0 }, { status: 0 }],
      [{ status: 0, address: [0xffffffff, 0xffff, 0xffff] as [number, number, number] }, { status: 0, address: [0xffffffff, 0xffff, 0xffff] as [number, number, number] }],
    ]) {
      const api = identityApi(replies)
      expect(readAdapterPhysicalId(nativeLuid, api)).toBeNull()
      expect(api.query).toHaveBeenCalledTimes(2)
      expect(api.close).toHaveBeenCalledTimes(1)
    }
  })

  it('closes the opened handle when a binding throws and reports close failure', () => {
    const api = identityApi([])
    const failure = new Error('Native binding failure')
    api.query.mockImplementationOnce(() => { throw failure })
    expect(() => readAdapterPhysicalId(nativeLuid, api)).toThrow(failure)
    expect(api.close).toHaveBeenCalledTimes(1)
    const failedClose = identityApi([{ status: 0, address: [0, 0, 0] }])
    failedClose.close.mockReturnValueOnce(-1073741811)
    expect(() => readAdapterPhysicalId(nativeLuid, failedClose)).toThrow('D3DKMTCloseAdapter')
    expect(failedClose.close).toHaveBeenCalledTimes(1)
  })
})

function fixture(options: Partial<CollectorConfig> = {}) {
  let clock = 0
  const counters: Record<CounterKey, CounterValue[]> = {
    cpu: [row('_Total', 20), row('0,0', 10), row('0,1', 30)], read: [row('0 D: E:', 0)], write: [row('0 D: E:', 10)], idle: [row('0 D: E:', 90)], gpu: [row(engineName(1), 0)], dedicated: [row(memoryName, 0)], shared: [row(memoryName, 0)],
  }
  const native: WindowsNative = {
    cpuSource: 'processor-utility', collect: vi.fn(), readCounter: vi.fn((key: CounterKey) => counters[key]), readMemory: vi.fn(() => memoryValues(1000, 500)), readVolumes: vi.fn(() => [volumeValues('D:', 1000, 500)]), readAdapters: vi.fn(() => [adapter]), close: vi.fn(),
  }
  const identity: CollectorIdentity = { hostName: 'fixture-host', cpuName: 'fixture-cpu', logicalProcessors: 2, now: () => 100000 + clock, monotonic: () => clock }
  const collector = new WindowsCollector({ ...config, ...options }, native, identity)
  return { collector, native, counters, advance: (milliseconds = 1000) => { clock += milliseconds } }
}

describe('Windows collector domain lifetime', () => {
  it('warms rate counters while immediately sampling memory and capacity', () => {
    const { collector, native, advance } = fixture()
    try {
      const first = collector.collect()
      expect(first.cpu).toMatchObject({ status: 'warming', data: null, code: 'warming-up' })
      expect(first.gpu.status).toBe('warming')
      expect(first.disks.status).toBe('warming')
      expect(first.memory.status).toBe('live')
      expect(first.volumes.status).toBe('live')
      advance()
      const second = collector.collect()
      expect(sampleSchema.safeParse(second).success).toBe(true)
      expect(second.cpu.data?.utilization).toBe(20)
      expect(second.gpu.data?.[0]?.utilization).toBe(0)
      expect(native.readVolumes).toHaveBeenCalledTimes(1)
      expect(native.readAdapters).toHaveBeenCalledTimes(1)
    } finally { collector.close() }
  })

  it('retains a failed GPU sample and its timestamp without stopping other domains', () => {
    const { collector, native, advance } = fixture()
    try {
      collector.collect(); advance()
      const good = collector.collect()
      vi.mocked(native.readCounter).mockImplementation(key => { if (key === 'gpu') throw new WindowsMetricError('sampling-failed', 'GPU read failed'); return key === 'cpu' ? [row('_Total', 5)] : [] })
      advance()
      const failed = collector.collect()
      expect(failed.gpu).toEqual({ status: 'error', data: good.gpu.data, sampledAt: good.gpu.sampledAt, code: 'sampling-failed' })
      expect(failed.cpu).toMatchObject({ status: 'live', data: { utilization: 5 }, sampledAt: 102000 })
      expect(failed.memory.sampledAt).toBe(102000)
    } finally { collector.close() }
  })

  it('keeps the previous memory reading on native failure and recovers on success', () => {
    const { collector, native, advance } = fixture()
    try {
      const good = collector.collect()
      vi.mocked(native.readMemory).mockImplementationOnce(() => { throw new WindowsMetricError('sampling-failed', 'memory unavailable') })
      advance()
      expect(collector.collect().memory).toEqual({ ...good.memory, status: 'error', code: 'sampling-failed' })
      advance()
      expect(collector.collect().memory).toMatchObject({ status: 'live', sampledAt: 102000, code: null })
    } finally { collector.close() }
  })

  it('re-primes rate counters after a failed query while memory continues', () => {
    const { collector, native, advance } = fixture()
    try {
      collector.collect(); advance(); collector.collect()
      vi.mocked(native.collect).mockImplementationOnce(() => { throw new WindowsMetricError('sampling-failed', 'PDH query failed') })
      advance()
      const failed = collector.collect()
      expect(failed.cpu.status).toBe('error')
      expect(failed.gpu.status).toBe('error')
      expect(failed.memory.status).toBe('live')
      advance(); expect(collector.collect().cpu.status).toBe('warming')
      advance(); expect(collector.collect().cpu.status).toBe('live')
    } finally { collector.close() }
  })

  it('refreshes capacity and adapter metadata only at the configured slow cadence', () => {
    const { collector, native, advance } = fixture()
    try {
      collector.collect(); advance(); collector.collect()
      advance(59000); collector.collect()
      expect(native.readVolumes).toHaveBeenCalledTimes(2)
      expect(native.readAdapters).toHaveBeenCalledTimes(1)
      advance(); collector.collect()
      expect(native.readAdapters).toHaveBeenCalledTimes(2)
    } finally { collector.close() }
  })

  it('does not read disabled domains and closes its native owner exactly once', () => {
    const { collector, native, advance } = fixture({ gpuEnabled: false, disksEnabled: false })
    collector.collect(); advance()
    const sample = collector.collect()
    expect(sample.gpu.data).toBeNull()
    expect(sample.disks.data).toBeNull()
    expect(native.readAdapters).not.toHaveBeenCalled()
    expect(native.readVolumes).not.toHaveBeenCalled()
    expect(vi.mocked(native.readCounter).mock.calls.map(([key]) => key)).toEqual(['cpu'])
    collector.close(); collector.close()
    expect(native.close).toHaveBeenCalledTimes(1)
    expect(() => collector.collect()).toThrow('closed')
  })

  it('retains capacity after a failed slow refresh without retrying on every sample', () => {
    const { collector, native, advance } = fixture()
    try {
      const good = collector.collect().volumes
      vi.mocked(native.readVolumes).mockImplementationOnce(() => { throw new WindowsMetricError('sampling-failed', 'capacity read failed') })
      advance(60000)
      expect(collector.collect().volumes).toEqual({ ...good, status: 'error', code: 'sampling-failed' })
      advance()
      expect(collector.collect().volumes.status).toBe('error')
      expect(native.readVolumes).toHaveBeenCalledTimes(2)
      advance(59000)
      expect(collector.collect().volumes).toMatchObject({ status: 'live', sampledAt: 220000 })
    } finally { collector.close() }
  })

  it('contains adapter discovery failure and retries only at metadata cadence', () => {
    const { collector, native, advance } = fixture()
    try {
      collector.collect()
      vi.mocked(native.readAdapters).mockImplementationOnce(() => { throw new WindowsMetricError('counter-unavailable', 'adapter discovery unavailable') })
      advance()
      const failed = collector.collect()
      expect(failed.gpu).toMatchObject({ status: 'unavailable', data: null, code: 'counter-unavailable' })
      expect(failed.cpu.status).toBe('live')
      advance()
      expect(collector.collect().gpu.status).toBe('unavailable')
      expect(native.readAdapters).toHaveBeenCalledTimes(1)
      advance(59000)
      expect(collector.collect().gpu.status).toBe('live')
      expect(native.readAdapters).toHaveBeenCalledTimes(2)
    } finally { collector.close() }
  })

  it('propagates programming defects instead of publishing a false successful sample', () => {
    const { collector, native } = fixture()
    try {
      vi.mocked(native.readMemory).mockImplementationOnce(() => { throw new TypeError('fixture defect') })
      expect(() => collector.collect()).toThrow(TypeError)
    } finally { collector.close() }
  })
})
