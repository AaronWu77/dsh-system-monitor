/** Independent Host plugin. Installs owner-authenticated read-only routes and a demand-driven collector. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { CollectorConfig } from '../shared/model.ts'
import { collectorConfigSchema } from '../shared/model.ts'
import { configSchema } from './config.ts'
import { MonitorHub } from './hub.ts'
import { workerSourceFactory } from './source.ts'
import { monitorRoutes } from './route.ts'
export const name = 'dsh-system-monitor'
export const inject = ['connection']
export interface Config extends CollectorConfig {}
export const Config = configSchema
/** Register routes after acquiring the hub; disposal revokes admission before joining the collector. */
export function apply(ctx: Context, input: Config): void {
  const config = collectorConfigSchema.parse(input)
  const report = (error: Error): void => { ctx.logger.error('System monitor: %s', error.message) }
  const hub = new MonitorHub(config, workerSourceFactory(config, report), report)
  ctx.effect(async function* () {
    yield () => hub.dispose()
    for (const route of monitorRoutes(hub, config)) yield ctx.connection.fetch.register(route)
  }, 'system-monitor: collector and authenticated routes')
}
