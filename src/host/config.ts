/** Host-owned defaults; the browser receives effective refresh settings from the authenticated route. */
import Schema from '@deepseek-ai/schemastery'
import type { CollectorConfig } from '../shared/model.ts'
export const configSchema: Schema<CollectorConfig> = Schema.object({
  intervalMs: Schema.number().min(500).max(10000).step(1).default(1000),
  capacityIntervalMs: Schema.number().min(10000).max(3600000).step(1).default(60000),
  historySeconds: Schema.number().min(30).max(300).step(1).default(60),
  idleGraceMs: Schema.number().min(0).max(10000).step(1).default(1500),
  workerStopTimeoutMs: Schema.number().min(1000).max(30000).step(1).default(5000),
  reconnectMs: Schema.number().min(1000).max(30000).step(1).default(2000),
  streamTimeoutMs: Schema.number().min(3000).max(60000).step(1).default(30000),
  gpuEnabled: Schema.boolean().default(true),
  disksEnabled: Schema.boolean().default(true),
})
