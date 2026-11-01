/** Resource-specific presentation over one validated Host snapshot. */
import { useMemo, useState, type CSSProperties } from 'react'
import type { Gpu, Snapshot } from '../shared/model.ts'
import { createMetricFormatters, metricNotice, type MonitorTranslate } from './format.ts'
import { LoadGauge, SegmentMeter, TrendChart, type TrendSample } from './Visuals.tsx'
import css from './Monitor.module.css'

/** Selection belongs to the tab body so pausing does not replace the user's view. */
export type ResourceKind = 'cpu' | 'memory' | 'gpu' | 'disks'
/** Local viewing state; no collector, store or subscription is exposed to presentation. */
export interface DashboardSelection {
  selected: ResourceKind
  gpuId: Gpu['id'] | null
  select(resource: ResourceKind): void
  selectGpu(id: Gpu['id']): void
}
type Format = ReturnType<typeof createMetricFormatters>
type Labels = { t: MonitorTranslate; format: Format }
const kinds = ['cpu', 'memory', 'gpu', 'disks'] as const

function complete(values: readonly (number | null)[], mode: 'sum' | 'max'): number | null {
  if (values.length === 0 || values.some(value => value === null)) return null
  const valid = values.filter((value): value is number => value !== null)
  return mode === 'sum' ? valid.reduce((sum, value) => sum + value, 0) : Math.max(...valid)
}
function ratio(used: number | null | undefined, total: number | null | undefined): number | null {
  return used == null || total == null || total <= 0 ? null : Math.max(0, Math.min(100, used / total * 100))
}
function primaryGpu(gpus: readonly Gpu[]): Gpu | undefined {
  return [...gpus].sort((a, b) => (b.dedicatedTotalBytes ?? 0) - (a.dedicatedTotalBytes ?? 0) || a.id.localeCompare(b.id))[0]
}

function CpuDetail({ snapshot, t, format }: { snapshot: Snapshot } & Labels) {
  const cpu = snapshot.cpu.data
  return <>
    <p className={css.kicker}>{t('processor')}</p>
    <div className={css.detailHeading}><div><h3>{snapshot.cpuName}</h3><p className={css.secondary}>{t('logicalProcessors', { count: snapshot.logicalProcessors })}</p></div><strong className={css.largeValue}>{format.percent(cpu?.utilization)}</strong></div>
    {cpu && cpu.cores.length > 0 && <>
      <div className={css.matrixHeading}><h4>{t('coreHeatmap')}</h4><span className={css.heatLegend}>{t('heatLow')}{[8, 16, 24, 33].map(tone => <i key={tone} style={{ '--core-tone': String(tone) + '%' } as CSSProperties} />)}{t('heatHigh')}</span></div>
      <div className={css.cores}>{cpu.cores.map((value, index) => <div key={index} className={css.core} data-core={index} style={{ '--core-tone': String(8 + value * .25) + '%' } as CSSProperties} aria-label={t('metricValue', { metric: t('core', { index }), value: format.percent(value) })}><span>{t('core', { index })}</span><strong>{format.percent(value)}</strong></div>)}</div>
      <p className={css.hint}>{t('coreHint')}</p>
    </>}
  </>
}

function GpuDetail({ gpu, gpus, onSelect, t, format }: { gpu: Gpu | undefined; gpus: readonly Gpu[]; onSelect(id: Gpu['id']): void } & Labels) {
  const [expanded, setExpanded] = useState(false)
  const engines = useMemo(() => [...(gpu?.engines ?? [])].sort((a, b) => b.utilization - a.utilization || a.name.localeCompare(b.name)), [gpu?.engines])
  const memoryPercent = ratio(gpu?.dedicatedUsedBytes, gpu?.dedicatedTotalBytes)
  const otherGpus = gpus.filter(device => device.id !== gpu?.id)
  return <>
    <p className={css.kicker}>{t('graphics')}</p>
    <div className={css.gpuHeading}><div className={css.deviceHeading}><h3>{gpu?.name ?? t('noGpu')}</h3>
      {gpu && <p className={css.secondary}>{t('deviceIndex', { index: gpus.findIndex(device => device.id === gpu.id) + 1 })}</p>}
      {engines[0] && <span className={css.engineBadge}>{t('engineSummary', { name: engines[0].name })}</span>}
    </div><LoadGauge value={gpu?.utilization ?? null} text={format.percent(gpu?.utilization)} label={t('gpuUtilization')} /></div>
    {gpu && <>
      <div className={css.memoryMeter}><div className={css.valueRow}><span>{t('dedicatedMemory')}</span><strong>{t('memoryUsed', { used: format.bytes(gpu.dedicatedUsedBytes), total: format.bytes(gpu.dedicatedTotalBytes) })}</strong></div>
        <SegmentMeter value={memoryPercent} label={t('dedicatedMemory')} kind="vram" />
        <div className={css.meterMeta}><span>{format.percent(memoryPercent)}</span><span>{t('sharedMemory')} · {format.bytes(gpu.sharedUsedBytes)}</span></div>
      </div>
      {engines.length > 0 && <div className={css.engines} aria-label={t('engineLoad')}>{engines.slice(0, 3).map(engine => <div key={engine.name}><div className={css.engineLabel}><span>{engine.name}</span><strong>{format.percent(engine.utilization)}</strong></div><div className={css.bar}><i style={{ width: String(engine.utilization) + '%' }} /></div></div>)}</div>}
      {engines.length > 3 && <details className={css.details} open={expanded} onToggle={event => { setExpanded(event.currentTarget.open) }}><summary>{t('moreEngines', { count: engines.length - 3 })}</summary>{expanded && <dl className={css.rows}>{engines.slice(3).map(engine => <div key={engine.name}><dt>{engine.name}</dt><dd>{format.percent(engine.utilization)}</dd></div>)}</dl>}</details>}
      {gpu.utilization === null && <p className={css.notice}>{t('partialGpu')}</p>}
    </>}
    {otherGpus.length > 0 && <div className={css.otherGpus}><h4>{t('otherGpus')}</h4>{otherGpus.map(device => <button type="button" key={device.id} data-gpu-device={device.id} className={css.deviceButton} onClick={() => { onSelect(device.id) }} aria-label={t('chooseGpu', { name: device.name, index: gpus.findIndex(candidate => candidate.id === device.id) + 1 })}><span>{device.name}<small>{t('deviceIndex', { index: gpus.findIndex(candidate => candidate.id === device.id) + 1 })}</small></span><strong>{format.percent(device.utilization)}</strong></button>)}</div>}
  </>
}

function MemoryDetail({ snapshot, t, format }: { snapshot: Snapshot } & Labels) {
  const memory = snapshot.memory.data
  return <>
    <p className={css.kicker}>{t('physicalMemory')}</p><div className={css.detailHeading}><div><h3>{t('memory')}</h3><p className={css.secondary}>{t('systemCapacity', { value: format.bytes(memory?.totalBytes) })}</p></div><strong className={css.largeValue}>{format.percent(memory?.utilization)}</strong></div>
    <div className={css.memoryComposition}><SegmentMeter value={memory?.utilization ?? null} label={t('memoryComposition')} kind="memory" /><div className={css.meterMeta}><span>{t('usedLabel')}</span><span>{t('availableLabel')}</span></div></div>
    <div className={css.memoryFacts}><div><span>{t('usedLabel')}</span><strong>{format.bytes(memory?.usedBytes)}</strong></div><div><span>{t('availableLabel')}</span><strong>{format.bytes(memory?.availableBytes)}</strong></div></div>
  </>
}

function DiskDetail({ snapshot, activity, t, format }: { snapshot: Snapshot; activity: number | null } & Labels) {
  const disks = snapshot.disks.data ?? []
  const read = complete(disks.map(disk => disk.readBytesPerSecond), 'sum'), write = complete(disks.map(disk => disk.writeBytesPerSecond), 'sum')
  return <>
    <p className={css.kicker}>{t('storage')}</p><div className={css.detailHeading}><div><h3>{t('busiestDisk')}</h3><p className={css.secondary}>{t('diskCount', { count: disks.length })}</p></div><strong className={css.largeValue}>{format.percent(activity)}</strong></div>
    <div className={css.transferFacts}><div><span>{t('read')}</span><strong>{format.rate(read)}</strong></div><div><span>{t('write')}</span><strong>{format.rate(write)}</strong></div></div>
    <div className={css.physicalDisks}>{disks.map(disk => <div key={disk.id} data-physical-disk={disk.id}><div className={css.valueRow}><h4>{disk.name}</h4><strong>{format.percent(disk.activePercent)}</strong></div><div className={css.diskRates}><span>{t('read')} · {format.rate(disk.readBytesPerSecond)}</span><span>{t('write')} · {format.rate(disk.writeBytesPerSecond)}</span></div></div>)}</div>
    {disks.length === 0 && <p className={css.notice}>{t('noDisks')}</p>}
    {disks.some(disk => disk.activePercent === null || disk.readBytesPerSecond === null || disk.writeBytesPerSecond === null) && <p className={css.notice}>{t('partialDisks')}</p>}
    <div className={css.volumeHeading}><h4>{t('volumes')}</h4>{snapshot.volumes.sampledAt !== null && <span>{t('capacitySampled', { time: format.time(snapshot.volumes.sampledAt) })}</span>}</div>
    <div className={css.volumes}>{snapshot.volumes.data?.map(volume => <div key={volume.id} data-volume={volume.id}><div className={css.valueRow}><h4>{volume.id}</h4><span>{format.percent(volume.utilization)}</span></div><div className={css.bar}><i style={{ width: String(volume.utilization) + '%' }} /></div><p>{t('memoryUsed', { used: format.bytes(volume.usedBytes), total: format.bytes(volume.totalBytes) })}</p><p>{t('free', { value: format.bytes(volume.freeBytes) })}</p></div>)}</div>
    {snapshot.volumes.data?.length === 0 && <p className={css.notice}>{t('noVolumes')}</p>}
    {metricNotice(snapshot.volumes, t) && <p className={css.notice}>{metricNotice(snapshot.volumes, t)}</p>}
    <p className={css.hint}>{t('capacityHint')}</p>
  </>
}

/** Render the chosen resource without introducing another resource holder.
 * @param props - One Host snapshot, tab-local selection and locale seat.
 * @returns Four overview selectors and one resource-specific detail and history.
 */
export function Dashboard({ snapshot, selected, gpuId, select, selectGpu, t }: { snapshot: Snapshot; t: MonitorTranslate } & DashboardSelection) {
  const locale = t('numberLocale')
  const format = useMemo(() => createMetricFormatters(t), [t, locale])
  const gpus = snapshot.gpu.data ?? []
  const gpu = gpus.find(device => device.id === gpuId) ?? primaryGpu(gpus)
  const disks = snapshot.disks.data ?? []
  const activity = complete(disks.map(disk => disk.activePercent), 'max')
  const values: Record<ResourceKind, number | null> = { cpu: snapshot.cpu.data?.utilization ?? null, memory: snapshot.memory.data?.utilization ?? null, gpu: gpu?.utilization ?? null, disks: activity }
  const captions: Record<ResourceKind, string> = {
    cpu: t('logicalProcessors', { count: snapshot.logicalProcessors }),
    memory: t('memoryUsed', { used: format.bytes(snapshot.memory.data?.usedBytes), total: format.bytes(snapshot.memory.data?.totalBytes) }),
    gpu: gpu ? t('memoryUsed', { used: format.bytes(gpu.dedicatedUsedBytes), total: format.bytes(gpu.dedicatedTotalBytes) }) : t('noGpu'),
    disks: t('diskCount', { count: disks.length }),
  }
  const samples = useMemo<TrendSample[]>(() => snapshot.history.map(point => ({ timestamp: point.timestamp, value: selected === 'cpu' ? point.cpu : selected === 'memory' ? point.memory : selected === 'gpu' ? gpu ? point.gpu[gpu.id] ?? null : null : complete(disks.map(disk => point.disks[disk.id]?.active ?? null), 'max') })), [snapshot.history, selected, gpu?.id, disks])
  const notice = metricNotice<unknown>(snapshot[selected], t)
  return <>
    <nav className={css.overview} aria-label={t('resourceNavigation')}>{kinds.map(kind => <button type="button" key={kind} data-resource={kind} className={css.metric} aria-pressed={kind === selected} onClick={() => { select(kind) }} aria-label={t('metricValue', { metric: t(kind), value: format.percent(values[kind]) })}>
      <span className={css.metricName}>{t(kind)}</span><strong className={css.metricValue}>{format.percent(values[kind])}</strong><span className={css.metricCaption}>{captions[kind]}</span>
      {values[kind] !== null && <i className={css.metricFill} style={{ width: String(values[kind]) + '%' }} />}
    </button>)}</nav>
    <div className={css.detailLayout}><section className={css.hero} data-resource-detail={selected} aria-label={t(selected)}>
      {selected === 'cpu' && <CpuDetail snapshot={snapshot} t={t} format={format} />}
      {selected === 'gpu' && <GpuDetail key={gpu?.id} gpu={gpu} gpus={gpus} onSelect={selectGpu} t={t} format={format} />}
      {selected === 'memory' && <MemoryDetail snapshot={snapshot} t={t} format={format} />}
      {selected === 'disks' && <DiskDetail snapshot={snapshot} activity={activity} t={t} format={format} />}
      {notice && <p className={css.notice}>{notice}</p>}
    </section><TrendChart samples={samples} metric={t(selected)} t={t} format={format} /></div>
  </>
}
