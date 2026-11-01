import { describe, expect, it } from 'vitest'
import { configSchema } from '../src/host/config.ts'
import { collectorConfigSchema, sampleSchema, snapshotSchema } from '../src/shared/model.ts'
import { sample, testConfig } from './host-fixtures.ts'
describe('worker and wire validation', () => {
  it('supplies deployment defaults at the plugin configuration boundary', () => {
    expect(collectorConfigSchema.parse(configSchema())).toEqual({ ...testConfig, idleGraceMs: 1500, workerStopTimeoutMs: 5000, reconnectMs: 2000 })
  })
  it('preserves legitimate zero counters and null unavailable fields', () => {
    const value = sample()
    value.gpu.data![0]!.dedicatedTotalBytes = null
    expect(sampleSchema.parse(value).gpu.data?.[0]?.utilization).toBe(0)
    expect(sampleSchema.parse(value).gpu.data?.[0]?.dedicatedTotalBytes).toBeNull()
  })
  it.each([0, 499, 10001, NaN, Infinity])('rejects unsafe sampling interval %s', intervalMs => {
    expect(collectorConfigSchema.safeParse({ ...testConfig, intervalMs }).success).toBe(false)
  })
  it('rejects nonfinite measurements and an unbounded history', () => {
    const value = sample(); value.cpu.data!.utilization = NaN
    expect(sampleSchema.safeParse(value).success).toBe(false)
    expect(snapshotSchema.safeParse({ ...sample(), history: Array(901).fill({}) }).success).toBe(false)
  })
})
