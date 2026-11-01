/** Native sidebar type, shared resource provider and reversible feature styles. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-resources/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { IconGaugeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { MonitorBody, MonitorTitle, type MonitorInjected } from './Monitor.tsx'
import { MonitorResourceOwner } from './provider.ts'
import { en, zh, NS } from './locales.ts'
import { cssText } from './Monitor.module.css'

export const inject = ['slots', 'locale', 'resources', 'sidebarRightTabs']
/** Register one page; all streams, readers, styles and contributions leave with the plugin. @param ctx Client plugin scope. */
export function apply(ctx: Context): void {
  const id = 'dsh-system-monitor'
  const t = ctx.locale.bind(NS)
  const owner = new MonitorResourceOwner({
    fetch: (input, init) => fetch(input, init),
    hidden: () => document.visibilityState === 'hidden',
    observeVisibility: listener => {
      document.addEventListener('visibilitychange', listener)
      return () => { document.removeEventListener('visibilitychange', listener) }
    },
  })
  ctx.effect(async function* () {
    yield () => owner.dispose()
    yield ctx.locale.register(NS, { en, zh })
    const style = document.createElement('style')
    style.dataset.dshSystemMonitorStyle = ''
    style.textContent = cssText
    document.head.appendChild(style)
    yield () => { style.remove() }
    yield ctx.resources.register(owner.provider)
    yield ctx.sidebarRightTabs.register({
      id, kind: 'system-monitor', title: () => t('title'),
      guide: [{ id: 'host', order: 80, title: () => t('title'), description: () => t('description'), icon: IconGaugeOutlineRegular }],
    })
    yield ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab', key: id, locale: NS,
      inject: (): MonitorInjected => ({ retry: owner.retry }),
    }, MonitorBody))
    yield ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab.title', key: id, locale: NS,
    }, MonitorTitle))
  }, 'system-monitor: sidebar and resource lifetime')
}
