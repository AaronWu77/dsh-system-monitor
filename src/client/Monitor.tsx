/** Sidebar chrome and tab-local viewing state; only Live holds the Host resource. */
import { useMemo, useState } from 'react'
import { Button, IconGaugeOutlineRegular, IconPauseOutlineRegular, IconPlayOutlineRegular, IconRefreshOutlineRegular, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { ResourceSnapshot } from '@deepseek-ai/dsh-client-resources/client'
import type { Gpu, Snapshot } from '../shared/model.ts'
import { Dashboard, type DashboardSelection, type ResourceKind } from './Dashboard.tsx'
import { createMetricFormatters } from './format.ts'
import { MONITOR_ADDRESS } from './provider.ts'
import type {} from './locales.ts'
import css from './Monitor.module.css'

/** Narrow callback face; live values arrive exclusively through useResource. */
export interface MonitorInjected { retry(): void }
type MonitorProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'systemMonitor'> & InjectFace<MonitorInjected>
type Labels = PropsLocale<'systemMonitor'>

function Content({ resource, paused, retry, onPause, onResume, t, ...selection }: {
  resource: ResourceSnapshot<Snapshot>; paused: boolean; retry(): void; onPause(): void; onResume(): void
} & Labels & DashboardSelection) {
  const snapshot = resource.value
  const failed = resource.status === 'failed' || resource.status === 'none'
  const locale = t('numberLocale')
  const format = useMemo(() => createMetricFormatters(t), [t, locale])
  return <section className={css.root} data-system-monitor data-paused={paused || undefined} aria-label={t('title')} tabIndex={0}>
    <header className={css.header}>
      <div className={css.heading}><h2>{t('overview')}</h2>{snapshot && <p className={css.host}>{t('host', { name: snapshot.hostName })}</p>}</div>
      <div className={css.controls}>
        <Button size="sm" onClick={paused ? onResume : onPause} icon={paused ? <IconPlayOutlineRegular /> : <IconPauseOutlineRegular />}>{paused ? t('resume') : t('pause')}</Button>
        {!paused && <Button size="sm" onClick={retry} icon={<IconRefreshOutlineRegular />}>{t('retry')}</Button>}
      </div>
    </header>
    <div className={css.status}>
      <StateDot state={paused ? 'idle' : failed ? 'warning' : snapshot === undefined ? 'ongoing' : 'done'} />
      <span>{paused ? t('paused') : failed ? t('unavailable') : snapshot === undefined ? t('noData') : t('live')}</span>
      {snapshot && <span>{t('sampled', { time: format.time(snapshot.timestamp) })}</span>}
    </div>
    {paused && <p className={css.banner} role="status">{t('pausedHint')}</p>}
    {!paused && failed && <p className={css.banner} role="status">{snapshot === undefined ? t('unavailable') : t('connectionFailed')}</p>}
    {snapshot === undefined
      ? <div className={css.empty}>{!paused && !failed ? <span role="status" aria-label={t('loading')}><StateDot state="ongoing" /></span> : t('noData')}</div>
      : <><Dashboard snapshot={snapshot} t={t} {...selection} /><footer className={css.footer}>
        <span>{t('cadence', { seconds: format.number(snapshot.intervalMs / 1000) })}</span>
        <span>{t('collection', { milliseconds: format.number(snapshot.collectionMs) })}</span>
      </footer></>}
  </section>
}

function Live(props: MonitorProps & DashboardSelection & { onPause(snapshot: Snapshot | null): void }) {
  const resource = props.useResource<'system-monitor'>(MONITOR_ADDRESS)
  return <Content resource={resource} t={props.t} retry={props.retry} selected={props.selected} gpuId={props.gpuId} select={props.select} selectGpu={props.selectGpu} paused={false} onPause={() => { props.onPause(resource.value ?? null) }} onResume={() => {}} />
}

/** Render the visible body; preserve resource/device selection while freezing one snapshot.
 * @param props - Framework-owned resource, sidebar and locale seats.
 * @returns The current selected resource or its paused snapshot.
 */
export function MonitorBody(props: MonitorProps) {
  const { tab } = props.useTabInfo()
  const [frozen, setFrozen] = useState<Snapshot | null | undefined>(undefined)
  const [selected, select] = useState<ResourceKind>('gpu')
  const [gpuId, selectGpu] = useState<Gpu['id'] | null>(null)
  const selection = { selected, select, gpuId, selectGpu }
  if (!tab.visible) return null
  if (frozen === undefined) return <Live {...props} {...selection} onPause={setFrozen} />
  return <Content resource={{ status: 'live', value: frozen ?? undefined, failure: undefined }} t={props.t} retry={props.retry} {...selection} paused onPause={() => {}} onResume={() => { setFrozen(undefined) }} />
}

/** Fixed tab title without a resource subscription.
 * @param props - The title's locale seat.
 * @returns The standard gauge icon and localized title.
 */
export function MonitorTitle({ t }: PropsRuntime<'sidebar.right.pane.tab.title'> & Labels) {
  return <span className={css.tabTitle}><IconGaugeOutlineRegular size={16} /><span>{t('title')}</span></span>
}
