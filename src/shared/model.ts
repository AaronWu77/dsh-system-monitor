/** Versioned worker and browser payloads. Values use bytes, bytes/second and percent. */
import { z } from 'zod'
const finite = z.number().finite().nonnegative()
const percent = finite.max(100)
/** Supported metric degradation reasons; display copy belongs to the client locale. */
export const metricCodeSchema = z.enum(['unsupported-platform', 'counter-unavailable', 'sampling-failed', 'warming-up', 'collector-failed'])
/** A domain keeps its last valid value and timestamp when a later read fails. */
export function metricSchema<T extends z.ZodType>(data: T) {
  return z.object({ status: z.enum(['live', 'warming', 'unavailable', 'error']), data: data.nullable(), sampledAt: finite.nullable(), code: metricCodeSchema.nullable() })
}
export const cpuSchema = z.object({ utilization: percent, cores: z.array(percent).max(1024), source: z.enum(['processor-utility', 'processor-time']) })
export const memorySchema = z.object({ totalBytes: finite, availableBytes: finite, usedBytes: finite, utilization: percent })
export const gpuSchema = z.object({ id: z.string(), name: z.string(), utilization: percent.nullable(), dedicatedUsedBytes: finite.nullable(), dedicatedTotalBytes: finite.nullable(), sharedUsedBytes: finite.nullable(), engines: z.array(z.object({ name: z.string(), utilization: percent })).max(128) })
export const diskSchema = z.object({ id: z.string(), name: z.string(), readBytesPerSecond: finite.nullable(), writeBytesPerSecond: finite.nullable(), activePercent: percent.nullable() })
export const volumeSchema = z.object({ id: z.string(), totalBytes: finite, freeBytes: finite, usedBytes: finite, utilization: percent })
/** One collector sample; the host owns history and subscriber lifetime. */
export const sampleSchema = z.object({ schemaVersion: z.literal(1), timestamp: finite, hostName: z.string(), cpuName: z.string(), logicalProcessors: z.number().int().positive().max(1024), intervalMs: z.number().int().min(500).max(10000), collectionMs: finite, cpu: metricSchema(cpuSchema), memory: metricSchema(memorySchema), gpu: metricSchema(z.array(gpuSchema).max(64)), disks: metricSchema(z.array(diskSchema).max(256)), volumes: metricSchema(z.array(volumeSchema).max(256)) })
export const historyPointSchema = z.object({ timestamp: finite, cpu: percent.nullable(), memory: percent.nullable(), gpu: z.record(z.string(), percent.nullable()), disks: z.record(z.string(), z.object({ read: finite.nullable(), write: finite.nullable(), active: percent.nullable() })) })
/** The Host returns bounded history with each current sample; nothing is persisted. */
export const snapshotSchema = sampleSchema.extend({ history: z.array(historyPointSchema).max(900) })
export type MetricCode = z.infer<typeof metricCodeSchema>
export type Metric<T> = { status: 'live' | 'warming' | 'unavailable' | 'error'; data: T | null; sampledAt: number | null; code: MetricCode | null }
export type Cpu = z.infer<typeof cpuSchema>
export type Memory = z.infer<typeof memorySchema>
export type Gpu = z.infer<typeof gpuSchema>
export type Disk = z.infer<typeof diskSchema>
export type Volume = z.infer<typeof volumeSchema>
export type Sample = z.infer<typeof sampleSchema>
export type HistoryPoint = z.infer<typeof historyPointSchema>
export type Snapshot = z.infer<typeof snapshotSchema>
/** Live protocol frames; configuration travels from Host, not browser bundle defaults. */
export const streamFrameSchema = z.discriminatedUnion('kind', [z.object({ kind: z.literal('snapshot'), value: snapshotSchema }), z.object({ kind: z.literal('failure'), code: metricCodeSchema })])
export type StreamFrame = z.infer<typeof streamFrameSchema>
/** Deployment-varying collector settings, validated before the worker starts. */
export const collectorConfigSchema = z.object({ intervalMs: z.number().int().min(500).max(10000), capacityIntervalMs: z.number().int().min(10000).max(3600000), historySeconds: z.number().int().min(30).max(300), idleGraceMs: z.number().int().min(0).max(10000), workerStopTimeoutMs: z.number().int().min(1000).max(30000), reconnectMs: z.number().int().min(1000).max(30000), streamTimeoutMs: z.number().int().min(3000).max(60000), gpuEnabled: z.boolean(), disksEnabled: z.boolean() })
export type CollectorConfig = z.infer<typeof collectorConfigSchema>
/** Worker-only collection interface; all platform handles belong to this instance. */
export interface Collector { collect(): Sample; close(): void }
