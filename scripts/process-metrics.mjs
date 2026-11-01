/** Query process CPU time and committed private memory without spawning monitoring commands. Diagnostic-only. */
import koffi from 'koffi'
const kernel = koffi.load('kernel32.dll')
const psapi = koffi.load('psapi.dll')
const open = kernel.func('void * __stdcall OpenProcess(uint32 access, int inheritHandle, uint32 processId)')
const close = kernel.func('int __stdcall CloseHandle(void *handle)')
const times = kernel.func('int __stdcall GetProcessTimes(void *process, void *creation, void *exit, void *kernelTime, void *userTime)')
const memory = psapi.func('int __stdcall GetProcessMemoryInfo(void *process, void *counters, uint32 bytes)')
export function processProbes() {
  const handles = new Map()
  return {
    read(pid) {
      let handle = handles.get(pid)
      if (handle === undefined) { handle = open(0x1000, 0, pid); if (handle === null) return null; handles.set(pid, handle) }
      const created = Buffer.alloc(8), exited = Buffer.alloc(8), kernel = Buffer.alloc(8), user = Buffer.alloc(8), mem = Buffer.alloc(80)
      if (!times(handle, created, exited, kernel, user)) return null
      mem.writeUInt32LE(80)
      if (!memory(handle, mem, 80)) return null
      return { cpuMs: Number(kernel.readBigUInt64LE() + user.readBigUInt64LE()) / 10000, privateBytes: Number(mem.readBigUInt64LE(72)), workingSetBytes: Number(mem.readBigUInt64LE(16)) }
    },
    close() { for (const handle of handles.values()) close(handle); handles.clear() },
  }
}
