/** Diagnostic of the built production Worker, not a claim about complete browser/UI overhead. */
import assert from 'node:assert/strict'
import { Worker } from 'node:worker_threads'
import { cpus } from 'node:os'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import koffi from 'koffi'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('This diagnostic requires Windows x64')
const seconds = Number(process.argv[2] ?? 30)
if (!Number.isInteger(seconds) || seconds < 10 || seconds > 300) throw new Error('Duration must be an integer between 10 and 300 seconds')
const kernel = koffi.load('kernel32.dll')
const psapi = koffi.load('psapi.dll')
const getCurrentProcess = kernel.func('void * __stdcall GetCurrentProcess()')
const openProcess = kernel.func('void * __stdcall OpenProcess(uint32 access, int inheritHandle, uint32 processId)')
const closeHandle = kernel.func('int __stdcall CloseHandle(void *handle)')
const getTimes = kernel.func('int __stdcall GetProcessTimes(void *process, void *creation, void *exit, void *kernelTime, void *userTime)')
const getMemory = psapi.func('int __stdcall GetProcessMemoryInfo(void *process, void *counters, uint32 bytes)')
const own = getCurrentProcess()
const taskPid = Number(process.env.DSH_TASKMGR_PID)
const task = Number.isInteger(taskPid) && taskPid > 0 ? openProcess(0x1000, 0, taskPid) : null
if (Number.isInteger(taskPid) && taskPid > 0 && task === null) throw new Error('Unable to query the specified Task Manager process')
function processSample(handle) {
  if (handle === null) return null
  const creation = Buffer.alloc(8), exit = Buffer.alloc(8), kernelTime = Buffer.alloc(8), userTime = Buffer.alloc(8)
  if (!getTimes(handle, creation, exit, kernelTime, userTime)) throw new Error('GetProcessTimes failed')
  const mem = Buffer.alloc(80); mem.writeUInt32LE(80, 0)
  if (!getMemory(handle, mem, 80)) throw new Error('GetProcessMemoryInfo failed')
  return { cpuMs: Number(kernelTime.readBigUInt64LE() + userTime.readBigUInt64LE()) / 10000, privateBytes: Number(mem.readBigUInt64LE(72)), workingSetBytes: Number(mem.readBigUInt64LE(16)) }
}
const raw = [], collection = []
let worker, exitPromise, workerFailure
async function interval(stage, duration) {
  let previous = { time: performance.now(), own: processSample(own), task: processSample(task) }
  for (let i = 0; i < duration; i++) {
    await delay(1000)
    if (workerFailure) throw workerFailure
    const current = { time: performance.now(), own: processSample(own), task: processSample(task) }
    const elapsed = current.time - previous.time
    const utilization = (a, b) => a && b ? (b.cpuMs - a.cpuMs) / elapsed / cpus().length * 100 : null
    raw.push({ stage, intervalMs: elapsed, ownCpuPercent: utilization(previous.own, current.own), ownPrivateBytes: current.own.privateBytes, ownWorkingSetBytes: current.own.workingSetBytes, taskCpuPercent: utilization(previous.task, current.task), taskPrivateBytes: current.task?.privateBytes ?? null, taskWorkingSetBytes: current.task?.workingSetBytes ?? null })
    previous = current
  }
}
try {
  await interval('idle-before', 5)
  const { Config } = await import(new URL('../lib/index.js', import.meta.url))
  worker = new Worker(new URL('../lib/collector-worker.js', import.meta.url), { workerData: Config({}), name: 'monitor-performance' })
  exitPromise = new Promise(resolve => worker.once('exit', resolve))
  worker.on('error', error => { workerFailure = error })
  const ready = new Promise(resolve => worker.on('message', sample => {
    if (sample?.schemaVersion !== 1 || !Number.isFinite(sample.collectionMs)) { workerFailure = new Error('Invalid worker sample'); return }
    collection.push(sample.collectionMs)
    if (sample.cpu.status === 'live') resolve()
  }))
  let readyTimeout
  try { await Promise.race([ready, new Promise((_, reject) => { readyTimeout = setTimeout(() => reject(new Error('Collector readiness timeout')), 15000) })]) }
  finally { clearTimeout(readyTimeout) }
  await interval('monitor-open', seconds)
  const stopStart = performance.now()
  worker.postMessage({ kind: 'stop' })
  let stopTimeout
  let code
  try { code = await Promise.race([exitPromise, new Promise((_, reject) => { stopTimeout = setTimeout(() => reject(new Error('Collector stop timeout')), 5000) })]) }
  finally { clearTimeout(stopTimeout) }
  assert.equal(code, 0)
  const stopMs = performance.now() - stopStart
  await interval('idle-after', 5)
  const mean = values => values.reduce((a, b) => a + b, 0) / values.length
  const summarize = stage => {
    const rows = raw.filter(row => row.stage === stage)
    const taskCpu = rows.map(row => row.taskCpuPercent).filter(value => value !== null)
    return { count: rows.length, ownMeanCpuPercent: mean(rows.map(row => row.ownCpuPercent)), ownPeakCpuPercent: Math.max(...rows.map(row => row.ownCpuPercent)), ownMeanPrivateBytes: mean(rows.map(row => row.ownPrivateBytes)), taskMeanCpuPercent: taskCpu.length ? mean(taskCpu) : null, taskPeakCpuPercent: taskCpu.length ? Math.max(...taskCpu) : null, taskMeanPrivateBytes: rows[0]?.taskPrivateBytes === null ? null : mean(rows.map(row => row.taskPrivateBytes)) }
  }
  const report = { date: new Date().toISOString(), platform: process.platform, node: process.version, logicalProcessors: cpus().length, sampleIntervalMs: 1000, note: 'Built production collector Worker only. CPU percent normalized by logical CPU count. Includes native DLL work inside this Node process; excludes browser, Host transport, external driver work. Task Manager page/visibility and its update interval are not controlled by this script. No stress workload started.', taskManagerCompared: task !== null, summary: ['idle-before', 'monitor-open', 'idle-after'].map(summarize), collector: { count: collection.length, meanMs: mean(collection), peakMs: Math.max(...collection), rawMs: collection, stopMs }, raw }
  await mkdir(resolve(root, '.local'), { recursive: true })
  const output = resolve(root, '.local/collector-performance-' + Date.now() + '.json')
  await writeFile(output, JSON.stringify(report, null, 2) + String.fromCharCode(10))
  console.log(JSON.stringify({ ...report, raw: undefined, output }, null, 2))
} finally {
  if (worker) { await worker.terminate(); await exitPromise }
  if (task !== null) closeHandle(task)
}
