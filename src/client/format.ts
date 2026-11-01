/** Pure localized value formatting and bounded SVG geometry. */
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { Metric, MetricCode } from '../shared/model.ts'
import type {} from './locales.ts'
export type MonitorTranslate = TranslateNS<'systemMonitor'>
/** @param value Numeric metric or absence. @param t Locale seat. @returns Localized percentage. */
export function percent(value: number | null | undefined, t: MonitorTranslate): string {
  return value == null ? t('unknown') : t('percent', { value: new Intl.NumberFormat(t('numberLocale'), { maximumFractionDigits: 1 }).format(value) })
}
/** @param value Bytes or absence. @param t Locale seat. @returns Localized binary-unit quantity. */
export function bytes(value: number | null | undefined, t: MonitorTranslate): string {
  if (value == null) return t('unknown')
  const units = ['unitByte', 'unitKiB', 'unitMiB', 'unitGiB', 'unitTiB'] as const
  const index = value === 0 ? 0 : Math.min(units.length - 1, Math.max(0, Math.floor(Math.log(value) / Math.log(1024))))
  return t('bytes', { value: new Intl.NumberFormat(t('numberLocale'), { maximumFractionDigits: index === 0 ? 0 : 1 }).format(value / 1024 ** index), unit: t(units[index]) })
}
/** @param code Metric degradation code. @param t Locale seat. @returns Actionable localized state. */
export function reason(code: MetricCode | null, t: MonitorTranslate): string {
  switch (code) {
    case 'warming-up': return t('warming')
    case 'unsupported-platform': return t('unsupported')
    case 'counter-unavailable': return t('counterUnavailable')
    case 'collector-failed': return t('collectorFailed')
    case 'sampling-failed': return t('samplingFailed')
    case null: return t('noData')
  }
}
/** @param metric Domain state. @param t Locale seat. @returns Non-live notice, including retained-value status. */
export function metricNotice<T>(metric: Metric<T>, t: MonitorTranslate): string | undefined {
  if (metric.status === 'live') return undefined
  const line = reason(metric.code, t)
  return metric.data === null ? line : line + ' · ' + t('lastKnown')
}
/** @param values Percentage samples; null values create gaps. @returns One SVG path in a 240 by 48 coordinate space. */
export function trendPath(values: readonly (number | null)[]): string {
  let path = ''
  let connected = false
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i]
    if (value === null) { connected = false; continue }
    const x = values.length <= 1 ? 240 : i * 240 / (values.length - 1)
    const y = 46 - Math.min(100, Math.max(0, value)) * 0.44
    path += (connected ? ' L' : ' M') + x.toFixed(1) + ',' + y.toFixed(1)
    connected = true
  }
  return path.trim()
}

/** Reuse locale formatters across sample updates and chart-pointer interactions.
 * @param t - Current locale seat.
 * @returns Scalar and unit formatters without process-wide caches.
 */
export function createMetricFormatters(t: MonitorTranslate) {
  const decimal = new Intl.NumberFormat(t('numberLocale'), { maximumFractionDigits: 1 })
  const integer = new Intl.NumberFormat(t('numberLocale'), { maximumFractionDigits: 0 })
  const clock = new Intl.DateTimeFormat(t('numberLocale'), { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
  const size = (value: number | null | undefined): string => {
    if (value == null) return t('unknown')
    const units = ['unitByte', 'unitKiB', 'unitMiB', 'unitGiB', 'unitTiB'] as const
    const index = value === 0 ? 0 : Math.min(units.length - 1, Math.max(0, Math.floor(Math.log(value) / Math.log(1024))))
    return t('bytes', { value: (index === 0 ? integer : decimal).format(value / 1024 ** index), unit: t(units[index]) })
  }
  return {
    bytes: size,
    percent: (value: number | null | undefined) => value == null ? t('unknown') : t('percent', { value: decimal.format(value) }),
    rate: (value: number | null | undefined) => value == null ? t('unknown') : t('rate', { value: size(value) }),
    number: (value: number) => decimal.format(value),
    time: (timestamp: number) => clock.format(new Date(timestamp)),
  }
}

/** Close each valid trend run separately so unavailable intervals remain empty.
 * @param values - Percentage samples with null gaps.
 * @returns SVG area paths in the same coordinate space as trendPath.
 */
export function trendAreaPath(values: readonly (number | null)[]): string {
  const areas: string[] = []
  let run: { x: number; y: number }[] = []
  const flush = () => {
    if (run.length > 1) {
      const first = run[0]!, last = run.at(-1)!
      areas.push('M' + first.x.toFixed(1) + ',46 ' + run.map(point => 'L' + point.x.toFixed(1) + ',' + point.y.toFixed(1)).join(' ') + ' L' + last.x.toFixed(1) + ',46 Z')
    }
    run = []
  }
  for (const [index, value] of values.entries()) {
    if (value === null) { flush(); continue }
    run.push({ x: values.length <= 1 ? 240 : index * 240 / (values.length - 1), y: 46 - Math.min(100, Math.max(0, value)) * .44 })
  }
  flush()
  return areas.join(' ')
}
