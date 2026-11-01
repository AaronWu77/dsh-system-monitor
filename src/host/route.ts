/** Authenticated Connection routes; disconnect releases the shared sampler and backpressure retains at most one frame. */
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import type { CollectorConfig } from '../shared/model.ts'
import type { MonitorHub } from './hub.ts'
/** Exact routes inherit Connection authentication and owner-only access checks. */
export function monitorRoutes(hub: MonitorHub, config: CollectorConfig): ConnectionFetchRoute[] {
  return [{ path: '/api/dsh-system-monitor/config', methods: ['GET'], requestBody: 'buffered', fetch: async () => Response.json({ reconnectMs: config.reconnectMs, intervalMs: config.intervalMs, streamTimeoutMs: config.streamTimeoutMs }, { headers: { 'cache-control': 'no-store' } }) },
    { path: '/api/dsh-system-monitor/stream', methods: ['GET'], requestBody: 'buffered', fetch: async request => {
      let release: (() => void) | undefined
      let ended = false
      let end: (() => void) | undefined
      const encoder = new TextEncoder()
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const finish = (): void => {
            if (ended) return
            ended = true
            request.signal.removeEventListener('abort', finish)
            release?.()
            controller.close()
          }
          end = finish
          if (request.signal.aborted) { finish(); return }
          release = hub.subscribe({ frame(value) {
            if (ended || (controller.desiredSize ?? 0) <= 0) return
            controller.enqueue(encoder.encode(JSON.stringify(value) + '\n'))
          }, end: finish })
          request.signal.addEventListener('abort', finish, { once: true })
          if (ended) release()
        },
        cancel() {
          if (ended) return
          ended = true
          if (end !== undefined) request.signal.removeEventListener('abort', end)
          release?.()
        },
      }, { highWaterMark: 1 })
      return new Response(body, { headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
    } }]
}
