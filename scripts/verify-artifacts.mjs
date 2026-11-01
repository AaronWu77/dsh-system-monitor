/** Built artifact smoke; the production Worker owns every native handle and must exit after stop. */
import assert from 'node:assert/strict'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { Worker } from 'node:worker_threads'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import vm from 'node:vm'
const root = fileURLToPath(new URL('../', import.meta.url))
const host = await import(new URL('../lib/index.js', import.meta.url))
assert.deepEqual(Object.keys(host).sort(), ['Config', 'apply', 'inject', 'name'])
assert.equal(host.name, 'dsh-system-monitor')
let browserEntry
const client = await readFile(resolve(root, 'lib/client.js'), 'utf8')
vm.runInNewContext(client, { window: { __ModuleLoader__: { load(value) { browserEntry = value } } } })
assert.equal(browserEntry.id, 'dsh-system-monitor')
assert.equal(typeof browserEntry.factory, 'function')
assert.ok(!client.includes('koffi'))
const report = { hostExports: Object.keys(host), browserBytes: Buffer.byteLength(client), windowsWorker: 'not run', samples: [] }
if (process.platform === 'win32' && process.arch === 'x64') {
  const worker = new Worker(new URL('../lib/collector-worker.js', import.meta.url), { workerData: host.Config({}), name: 'monitor-artifact-smoke' })
  const exit = once(worker, 'exit')
  let timeout
  try {
    const samples = await Promise.race([
      new Promise((resolve, reject) => {
        const rows = []
        worker.on('error', reject)
        worker.on('message', value => {
          if (value?.schemaVersion !== 1 || !Number.isFinite(value.timestamp)) { reject(new Error('Invalid worker sample')); return }
          rows.push(value)
          if (rows.length === 2) resolve(rows)
        })
      }),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Worker sample deadline exceeded')), 15000) }),
    ])
    for (const value of samples) {
      assert.equal(value.memory.status, 'live')
      assert.ok(value.memory.data.totalBytes > 0)
      assert.ok(value.collectionMs >= 0)
    }
    assert.equal(samples[1].cpu.status, 'live')
    report.samples = samples.map(value => ({ timestamp: value.timestamp, collectionMs: value.collectionMs, cpu: value.cpu.status, memory: value.memory.status, gpu: value.gpu.status, disks: value.disks.status, volumes: value.volumes.status }))
    worker.postMessage({ kind: 'stop' })
    const [code] = await exit
    assert.equal(code, 0)
    report.windowsWorker = 'two real samples; native handles closed; clean exit'
  } finally {
    clearTimeout(timeout)
    await worker.terminate()
    await exit.catch(() => {})
  }
} else report.windowsWorker = 'skipped: real counters require Windows x64'
await mkdir(resolve(root, '.local'), { recursive: true })
await writeFile(resolve(root, '.local/artifacts.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
