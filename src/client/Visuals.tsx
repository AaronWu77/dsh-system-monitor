/** Stateless gauges and a locally interactive SVG history view; no resource subscriptions. */
import { useId, useMemo, useState, type CSSProperties } from 'react'
import { trendAreaPath, trendPath, type createMetricFormatters, type MonitorTranslate } from './format.ts'
import css from './Monitor.module.css'

type Format = ReturnType<typeof createMetricFormatters>
/** One validated utilization sample; null leaves a gap in both trace and fill. */
export interface TrendSample { timestamp: number; value: number | null }

/** Display utilization without interpreting missing data as idle.
 * @param props - Current percentage, localized number and description.
 * @returns A compact, nonanimated load gauge.
 */
export function LoadGauge({ value, text, label }: { value: number | null; text: string; label: string }) {
  return <div className={css.gauge} data-monitor-gauge>
    <svg viewBox="0 0 172 162" role="img" aria-label={label}>
      <path className={css.gaugeTrack} d="M34.38 133.62 A73 73 0 1 1 137.62 133.62" />
      {Array.from({ length: 25 }, (_, index) => {
        const angle = (135 + index * 270 / 24) * Math.PI / 180
        return <line key={index} className={css.gaugeTick} x1={86 + Math.cos(angle) * 60} y1={82 + Math.sin(angle) * 60} x2={86 + Math.cos(angle) * 64} y2={82 + Math.sin(angle) * 64} />
      })}
      {value !== null && value > 0 && <path className={css.gaugeFill} d="M34.38 133.62 A73 73 0 1 1 137.62 133.62" pathLength={100} strokeDasharray={String(value) + ' 100'} />}
    </svg>
    <div className={css.gaugeFigure}><strong className={css.gaugeValue}>{text}</strong><span>{label}</span></div>
  </div>
}

/** Represent a measured ratio with neutral segments when it is unknown.
 * @param props - Percentage, localized description and the displayed quantity.
 * @returns An accessible segmented meter with no timer or animation.
 */
export function SegmentMeter({ value, label, kind }: { value: number | null; label: string; kind: string }) {
  return <div className={css.segments} data-meter={kind} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value ?? undefined}>
    {Array.from({ length: 32 }, (_, index) => {
      const amount = value === null ? 0 : Math.min(100, Math.max(0, (value - index * 100 / 32) * 32))
      return <span key={index} style={{ '--segment-fill': String(amount) + '%' } as CSSProperties} />
    })}
  </div>
}

/** Inspect the selected resource's retained history using a pointer or arrow keys.
 * @param props - Validated percentage samples and locale-owned formatting.
 * @returns An area trend that preserves gaps and labels its real sample interval.
 */
export function TrendChart({ samples, metric, t, format }: { samples: readonly TrendSample[]; metric: string; t: MonitorTranslate; format: Format }) {
  const id = useId().replaceAll(':', '')
  const gradientId = 'monitor-area-' + id
  const helpId = 'monitor-history-help-' + id
  const [position, setPosition] = useState<number | null>(null)
  const values = useMemo(() => samples.map(sample => sample.value), [samples])
  const line = useMemo(() => trendPath(values), [values])
  const area = useMemo(() => trendAreaPath(values), [values])
  const valid = useMemo(() => values.filter((value): value is number => value !== null), [values])
  const index = position === null || samples.length === 0 ? null : Math.round(position * (samples.length - 1))
  const selected = index === null ? undefined : samples[index]
  const x = index === null ? 0 : samples.length <= 1 ? 240 : index * 240 / (samples.length - 1)
  const first = samples[0], last = samples.at(-1)
  const seconds = first && last ? Math.max(0, Math.round((last.timestamp - first.timestamp) / 1000)) : 0
  const currentValue = last?.value
  const average = valid.length === 0 ? null : valid.reduce((sum, value) => sum + value, 0) / valid.length
  return <section className={css.trend} aria-label={t('trend', { metric })}>
    <div className={css.trendHead}><h4>{t('trendTitle')}</h4>
      <span className={css.chartReadout} data-monitor-history-readout>{selected ? t('chartSample', { time: format.time(selected.timestamp), value: format.percent(selected.value) }) : seconds > 0 ? t('historyRange', { seconds }) : t('singleSample')}</span>
    </div>
    <p id={helpId} className={css.srOnly}>{t('chartKeyboard')}</p>
    <div className={css.plotWrap}>
      <svg className={css.plot} viewBox="0 0 240 48" preserveAspectRatio="none" role="img" aria-label={t('trend', { metric })} aria-describedby={helpId} tabIndex={0} data-monitor-trend
        onPointerMove={event => { const bounds = event.currentTarget.getBoundingClientRect(); if (bounds.width > 0) setPosition(Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width))) }}
        onPointerLeave={() => { setPosition(null) }} onBlur={() => { setPosition(null) }}
        onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setPosition(value => Math.min(1, Math.max(0, (value ?? 1) + (event.key === 'ArrowLeft' ? -1 : 1) / Math.max(1, samples.length - 1)))) } }}>
        <defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--monitor-accent)" stopOpacity=".18" /><stop offset="100%" stopColor="var(--monitor-accent)" stopOpacity=".015" /></linearGradient></defs>
        <path className={css.chartGrid} d="M0,2H240 M0,24H240 M0,46H240" />
        <path d={area} fill={'url(#' + gradientId + ')'} />
        <path className={css.trace} d={line} />
        {selected && <line className={css.chartCursor} x1={x} x2={x} y1={2} y2={46} />}
        {selected?.value != null && <circle className={css.chartPoint} cx={x} cy={46 - selected.value * .44} r={1.5} />}
        {position === null && currentValue != null && <circle className={css.chartLast} cx={240} cy={46 - currentValue * .44} r={1} />}
      </svg>
      <div className={css.axisY} aria-hidden="true"><span>{format.percent(100)}</span><span>{format.percent(50)}</span><span>{format.percent(0)}</span></div>
      <div className={css.axisX}>{first && <span>{format.time(first.timestamp)}</span>}<span>{t('latest')}</span></div>
    </div>
    <div className={css.chartStats}><span>{t('average')}<strong>{format.percent(average)}</strong></span><span>{t('peak')}<strong>{format.percent(valid.length === 0 ? null : Math.max(...valid))}</strong></span><span className={css.legend}>{metric}</span></div>
  </section>
}
