/** Worker-owned x64 Windows FFI. PDH queries stay open between samples; no subprocess is used. */
import koffi from 'koffi'
import type { CollectorConfig, Cpu, Memory, Volume } from '../shared/model.ts'
import { memoryValues, volumeValues, WindowsMetricError, type CounterValue, type GraphicsAdapter } from './windows-metrics.ts'

/** Counter families whose output is normalized independently. */
export type CounterKey = 'cpu' | 'read' | 'write' | 'idle' | 'gpu' | 'dedicated' | 'shared'
/** All native resources are owned by one synchronous Worker-local collector. */
export interface WindowsNative {
  readonly cpuSource: Cpu['source']
  collect(): void
  readCounter(key: CounterKey): CounterValue[]
  readMemory(): Memory
  readVolumes(): Volume[]
  readAdapters(): GraphicsAdapter[]
  close(): void
}
type NativeFunction = (...args: unknown[]) => number
const MORE_DATA = 0x800007d2
const MAX_COUNTER_BYTES = 4 * 1024 * 1024
const FORMAT_DOUBLE = 0x200
const ITEM_BYTES = 24

function nativeFailure(operation: string, code: number): WindowsMetricError {
  return new WindowsMetricError('sampling-failed', operation + ' failed: 0x' + (code >>> 0).toString(16))
}
function safeBytes(value: bigint): number {
  const result = Number(value)
  if (!Number.isSafeInteger(result)) throw new WindowsMetricError('sampling-failed', 'Native byte count exceeds the safe numeric range')
  return result
}
/** Decode names only while the native allocation containing them remains alive. */
function itemName(buffer: Buffer, address: bigint): string {
  const offset = Number(address - koffi.address(buffer))
  if (!Number.isSafeInteger(offset) || offset < 0 || offset % 2 !== 0 || offset + 2 > buffer.length) throw new WindowsMetricError('sampling-failed', 'PDH instance name points outside the returned buffer')
  let end = offset
  while (end + 2 <= buffer.length) {
    if (buffer.readUInt16LE(end) === 0) return buffer.subarray(offset, end).toString('utf16le')
    end += 2
  }
  throw new WindowsMetricError('sampling-failed', 'PDH instance name is not terminated')
}
function nativePointer(value: unknown): bigint {
  if (typeof value !== 'bigint' || value === 0n) throw new WindowsMetricError('sampling-failed', 'A native interface returned an invalid pointer')
  return value
}

interface AdapterIdentityApi {
  open(data: Buffer): number
  query(data: Buffer): number
  close(data: Buffer): number
}
// Official values: https://github.com/microsoft/win32metadata/blob/main/generation/WinSDK/RecompiledIdlHeaders/shared/d3dkmthk.h
const KMTQAITYPE_ADAPTERADDRESS = 6
const KMTQAITYPE_ADAPTERADDRESS_RENDER = 53

/** Resolve a PCI address using Worker-local D3DKMT bindings, including render aliases.
 * @param luid - Eight native LUID bytes from DXGI, low part first.
 * @param api - Synchronous bindings owned by the sampling Worker.
 * @returns A validated PCI identity, or null for failed queries or invalid addresses. Every successful open is closed; close failure throws.
 */
export function readAdapterPhysicalId(luid: Buffer, api: AdapterIdentityApi): string | null {
  const opened = Buffer.alloc(12) // D3DKMT_OPENADAPTERFROMLUID: LUID, uint32 handle (not a pointer).
  luid.copy(opened, 0, 0, 8)
  if (api.open(opened) !== 0) return null
  const handle = opened.subarray(8, 12) // D3DKMT_CLOSEADAPTER contains only the uint32 handle.
  try {
    const address = Buffer.alloc(12)
    const info = Buffer.alloc(24) // x64 D3DKMT_QUERYADAPTERINFO: handle, type, pointer, size, padding.
    info.writeUInt32LE(handle.readUInt32LE(), 0)
    info.writeBigUInt64LE(koffi.address(address), 8)
    info.writeUInt32LE(address.length, 16)
    for (const type of [KMTQAITYPE_ADAPTERADDRESS, KMTQAITYPE_ADAPTERADDRESS_RENDER]) {
      info.writeUInt32LE(type, 4)
      address.fill(0xff)
      if (api.query(info) !== 0) continue
      const bus = address.readUInt32LE(0), device = address.readUInt32LE(4), fn = address.readUInt32LE(8)
      // Virtual/display-only adapters can return successful status with sentinel addresses.
      if (bus <= 0xff && device <= 0x1f && fn <= 7) return 'pci_' + bus.toString(16).padStart(2, '0') + '_' + device.toString(16).padStart(2, '0') + '_' + fn
    }
    return null
  } finally {
    const status = api.close(handle)
    if (status !== 0) throw nativeFailure('D3DKMTCloseAdapter', status)
  }
}

function createAdapterReader(): () => GraphicsAdapter[] {
  const dxgi = koffi.load('dxgi.dll')
  const gdi = koffi.load('gdi32.dll')
  const identityApi: AdapterIdentityApi = {
    open: gdi.func('int32 __stdcall D3DKMTOpenAdapterFromLuid(void *)'),
    query: gdi.func('int32 __stdcall D3DKMTQueryAdapterInfo(void *)'),
    close: gdi.func('int32 __stdcall D3DKMTCloseAdapter(void *)'),
  }
  const create: NativeFunction = dxgi.func('int32 __stdcall CreateDXGIFactory1(void *, void *)')
  const enumProto = koffi.proto('__stdcall', 'int32', ['void *', 'uint32', 'void *'])
  const descProto = koffi.proto('__stdcall', 'int32', ['void *', 'void *'])
  const releaseProto = koffi.proto('__stdcall', 'uint32', ['void *'])
  const method = (self: bigint, slot: number, proto: ReturnType<typeof koffi.proto>, ...args: unknown[]): number => {
    const table = nativePointer(koffi.decode(self, 'void *'))
    const fn = nativePointer(koffi.decode(table, slot * 8, 'void *'))
    const result: unknown = koffi.call(fn, proto, self, ...args)
    if (typeof result !== 'number') throw new WindowsMetricError('sampling-failed', 'DXGI method returned an invalid status')
    return result
  }
  // IID_IDXGIFactory1: GUID's first three fields use little-endian byte order.
  const iid = Buffer.from('78ae0a776ff2ba4da829253c83d1b387', 'hex')
  return () => {
    const output = Buffer.alloc(8)
    const created = create(iid, output)
    if (created < 0) throw nativeFailure('CreateDXGIFactory1', created)
    const factory = nativePointer(output.readBigUInt64LE())
    const adapters: GraphicsAdapter[] = []
    try {
      // The payload allows at most 64 adapters; one extra enumeration detects overflow.
      for (let index = 0; index <= 64; index++) {
        const pointer = Buffer.alloc(8)
        const status = method(factory, 12, enumProto, index, pointer)
        if ((status >>> 0) === 0x887a0002) return adapters
        if (status < 0) throw nativeFailure('IDXGIFactory1.EnumAdapters1', status)
        const adapter = nativePointer(pointer.readBigUInt64LE())
        try {
          if (index === 64) throw new WindowsMetricError('sampling-failed', 'DXGI adapter count exceeds the payload limit')
          const desc = Buffer.alloc(312)
          const read = method(adapter, 10, descProto, desc)
          if (read < 0) throw nativeFailure('IDXGIAdapter1.GetDesc1', read)
          const software = (desc.readUInt32LE(304) & 2) !== 0
          adapters.push({
            name: desc.subarray(0, 256).toString('utf16le').split(String.fromCharCode(0), 1)[0]!,
            luid: '0x' + desc.readUInt32LE(300).toString(16).padStart(8, '0') + '_0x' + desc.readUInt32LE(296).toString(16).padStart(8, '0'),
            dedicatedTotalBytes: safeBytes(desc.readBigUInt64LE(272)),
            software,
            physicalId: software ? null : readAdapterPhysicalId(desc.subarray(296, 304), identityApi),
          })
        } finally { method(adapter, 2, releaseProto) }
      }
      throw new WindowsMetricError('sampling-failed', 'DXGI enumeration did not terminate')
    } finally { method(factory, 2, releaseProto) }
  }
}

/** Open a local query and kernel bindings; only this thread may use or close them.
 * @param config - Validated deployment configuration.
 * @returns Native accessors. Closing releases all counter handles with the query.
 */
export function createWindowsNative(config: CollectorConfig): WindowsNative {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new WindowsMetricError('unsupported-platform', 'The native collector requires Windows x64')
  const pdh = koffi.load('pdh.dll')
  const kernel = koffi.load('kernel32.dll')
  const open: NativeFunction = pdh.func('int32 __stdcall PdhOpenQueryW(str16, uintptr, void *)')
  const add: NativeFunction = pdh.func('int32 __stdcall PdhAddEnglishCounterW(void *, str16, uintptr, void *)')
  const collect: NativeFunction = pdh.func('int32 __stdcall PdhCollectQueryData(void *)')
  const formatted: NativeFunction = pdh.func('int32 __stdcall PdhGetFormattedCounterArrayW(void *, uint32, void *, void *, void *)')
  const close: NativeFunction = pdh.func('int32 __stdcall PdhCloseQuery(void *)')
  const memory: NativeFunction = kernel.func('int __stdcall GlobalMemoryStatusEx(void *)')
  const drives: NativeFunction = kernel.func('uint32 __stdcall GetLogicalDrives()')
  const driveType: NativeFunction = kernel.func('uint32 __stdcall GetDriveTypeW(str16)')
  const freeSpace: NativeFunction = kernel.func('int __stdcall GetDiskFreeSpaceExW(str16, void *, void *, void *)')
  const lastError: NativeFunction = kernel.func('uint32 __stdcall GetLastError()')
  const output = Buffer.alloc(8)
  const opened = open(null, 0, output)
  if (opened !== 0) throw nativeFailure('PdhOpenQueryW', opened)
  const query = nativePointer(output.readBigUInt64LE())
  const handles = new Map<CounterKey, bigint>()
  const buffers = new Map<CounterKey, Buffer>()
  let closed = false
  let adapterReader: (() => GraphicsAdapter[]) | null = null
  const addCounter = (key: CounterKey, path: string): boolean => {
    const result = Buffer.alloc(8)
    if (add(query, path, 0, result) !== 0) return false
    handles.set(key, nativePointer(result.readBigUInt64LE()))
    return true
  }
  let cpuSource: Cpu['source'] = 'processor-utility'
  try {
    if (!addCounter('cpu', '\\Processor Information(*)\\% Processor Utility')) {
      cpuSource = 'processor-time'
      addCounter('cpu', '\\Processor(*)\\% Processor Time')
    }
    if (config.disksEnabled) {
      addCounter('read', '\\PhysicalDisk(*)\\Disk Read Bytes/sec')
      addCounter('write', '\\PhysicalDisk(*)\\Disk Write Bytes/sec')
      addCounter('idle', '\\PhysicalDisk(*)\\% Idle Time')
    }
    if (config.gpuEnabled) {
      addCounter('gpu', '\\GPU Engine(*)\\Utilization Percentage')
      addCounter('dedicated', '\\GPU Adapter Memory(*)\\Dedicated Usage')
      addCounter('shared', '\\GPU Adapter Memory(*)\\Shared Usage')
    }
  } catch (error) {
    const status = close(query)
    if (status !== 0) throw new AggregateError([error, nativeFailure('PdhCloseQuery', status)], 'Native collector initialization and cleanup failed')
    throw error
  }
  const ensureOpen = (): void => { if (closed) throw new Error('The Windows collector is closed') }
  return {
    cpuSource,
    collect: () => {
      ensureOpen()
      const status = collect(query)
      if (status !== 0) throw nativeFailure('PdhCollectQueryData', status)
    },
    readCounter: (key) => {
      ensureOpen()
      const handle = handles.get(key)
      if (handle === undefined) return []
      const size = Buffer.alloc(4)
      const count = Buffer.alloc(4)
      for (let attempt = 0; attempt < 2; attempt++) {
        size.writeUInt32LE(0)
        const probe = formatted(handle, FORMAT_DOUBLE, size, count, null)
        if (probe === 0 && count.readUInt32LE() === 0) return []
        if ((probe >>> 0) !== MORE_DATA) throw nativeFailure('PdhGetFormattedCounterArrayW size', probe)
        const needed = size.readUInt32LE()
        if (needed < ITEM_BYTES || needed > MAX_COUNTER_BYTES) throw new WindowsMetricError('sampling-failed', 'PDH counter buffer exceeds the safe size limit')
        let buffer = buffers.get(key)
        if (!buffer || buffer.length < needed) { buffer = Buffer.alloc(needed); buffers.set(key, buffer) }
        size.writeUInt32LE(buffer.length)
        const status = formatted(handle, FORMAT_DOUBLE, size, count, buffer)
        if ((status >>> 0) === MORE_DATA) continue
        if (status !== 0) throw nativeFailure('PdhGetFormattedCounterArrayW data', status)
        const length = count.readUInt32LE()
        if (length * ITEM_BYTES > buffer.length) throw new WindowsMetricError('sampling-failed', 'PDH counter item count exceeds its returned buffer')
        const rows: CounterValue[] = []
        for (let index = 0; index < length; index++) {
          const offset = index * ITEM_BYTES
          rows.push({ name: itemName(buffer, buffer.readBigUInt64LE(offset)), status: buffer.readUInt32LE(offset + 8), value: buffer.readDoubleLE(offset + 16) })
        }
        return rows
      }
      throw new WindowsMetricError('sampling-failed', 'PDH counter instances changed during both bounded read attempts')
    },
    readMemory: () => {
      ensureOpen()
      const data = Buffer.alloc(64)
      data.writeUInt32LE(64)
      if (!memory(data)) throw nativeFailure('GlobalMemoryStatusEx', lastError())
      return memoryValues(safeBytes(data.readBigUInt64LE(8)), safeBytes(data.readBigUInt64LE(16)))
    },
    readVolumes: () => {
      ensureOpen()
      const mask = drives()
      if (mask === 0) throw nativeFailure('GetLogicalDrives', lastError())
      const volumes: Volume[] = []
      for (let index = 0; index < 26; index++) {
        if ((mask & (1 << index)) === 0) continue
        const id = String.fromCharCode(65 + index) + ':'
        const root = id + String.fromCharCode(92)
        if (driveType(root) !== 3) continue
        const available = Buffer.alloc(8), total = Buffer.alloc(8), free = Buffer.alloc(8)
        if (!freeSpace(root, available, total, free)) throw nativeFailure('GetDiskFreeSpaceExW', lastError())
        volumes.push(volumeValues(id, safeBytes(total.readBigUInt64LE()), safeBytes(free.readBigUInt64LE())))
      }
      return volumes
    },
    readAdapters: () => {
      ensureOpen()
      adapterReader ??= createAdapterReader()
      return adapterReader()
    },
    close: () => {
      if (closed) return
      closed = true
      buffers.clear()
      handles.clear()
      const status = close(query)
      if (status !== 0) throw nativeFailure('PdhCloseQuery', status)
    },
  }
}
