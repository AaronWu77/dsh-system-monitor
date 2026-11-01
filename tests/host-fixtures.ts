import type { CollectorConfig, Sample } from '../src/shared/model.ts'
export const testConfig: CollectorConfig = { intervalMs: 1000, capacityIntervalMs: 60000, historySeconds: 60, idleGraceMs: 100, workerStopTimeoutMs: 1000, reconnectMs: 1000, streamTimeoutMs: 30000, gpuEnabled: true, disksEnabled: true }
export function sample(timestamp = 1000): Sample {
  return { schemaVersion: 1, timestamp, intervalMs: 1000, collectionMs: 1, hostName: 'test-host', cpuName: 'Test CPU', logicalProcessors: 4,
    cpu: { status: 'live', data: { utilization: 10, cores: [10, 10, 10, 10], source: 'processor-utility' }, sampledAt: timestamp, code: null },
    memory: { status: 'live', data: { totalBytes: 8192, availableBytes: 6144, usedBytes: 2048, utilization: 25 }, sampledAt: timestamp, code: null },
    gpu: { status: 'live', data: [{ id: 'gpu-a', name: 'Test GPU', utilization: 0, dedicatedUsedBytes: 0, dedicatedTotalBytes: 4096, sharedUsedBytes: 0, engines: [{ name: '3D', utilization: 0 }] }], sampledAt: timestamp, code: null },
    disks: { status: 'live', data: [{ id: '0', name: '0 D: E:', readBytesPerSecond: 0, writeBytesPerSecond: 0, activePercent: 0 }], sampledAt: timestamp, code: null },
    volumes: { status: 'live', data: [{ id: 'D:', totalBytes: 8192, freeBytes: 4096, usedBytes: 4096, utilization: 50 }], sampledAt: timestamp, code: null },
  }
}
export function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
