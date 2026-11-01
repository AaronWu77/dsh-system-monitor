// @vitest-environment jsdom
import { useEffect } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ResourceProtocol, ResourceSnapshot } from '@deepseek-ai/dsh-client-resources/client'
import type { ResourceProtocolMap } from '@deepseek-ai/dsh-client-ui-slots'
import type { Snapshot } from '../src/shared/model.ts'
import { MonitorBody, MonitorTitle } from '../src/client/Monitor.tsx'
import { bytes, createMetricFormatters, percent, trendAreaPath, trendPath } from '../src/client/format.ts'
import { en, zh, type MonitorKey } from '../src/client/locales.ts'
import { sample } from './host-fixtures.ts'

afterEach(cleanup)
const snapshot = (): Snapshot => ({ ...sample(), history: [{ timestamp: 1000, cpu: 10, memory: 25, gpu: { 'gpu-a': 0 }, disks: { '0': { read: 0, write: 0, active: 0 } } }] })
function translate(dictionary: typeof en | typeof zh) {
  return (key: string, params?: Record<string, unknown>): string => {
    let text = dictionary[key as MonitorKey] ?? key
    for (const [name, value] of Object.entries(params ?? {})) text = text.replaceAll('{' + name + '}', String(value))
    return text
  }
}
function setup(initial: ResourceSnapshot<Snapshot> = { status: 'live', value: snapshot(), failure: undefined }) {
  let resource = initial
  let visible = true
  let holders = 0
  const retry = vi.fn()
  function useResource<P extends ResourceProtocol>(): ResourceSnapshot<ResourceProtocolMap[P]> {
    useEffect(() => { holders += 1; return () => { holders -= 1 } }, [])
    return resource as ResourceSnapshot<ResourceProtocolMap[P]>
  }
  const props = { t: translate(en), retry, useResource, useTabInfo: () => ({ tab: { visible } }) } as Parameters<typeof MonitorBody>[0]
  const view = render(<MonitorBody {...props} />)
  return {
    props, retry, view, holders: () => holders,
    update(next: ResourceSnapshot<Snapshot>) { resource = next; view.rerender(<MonitorBody {...props} />) },
    visibility(next: boolean) { visible = next; view.rerender(<MonitorBody {...props} />) },
  }
}
function choose(name: 'CPU' | 'Memory' | 'GPU' | 'Disks') {
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Select a resource' })).getByRole('button', { name: new RegExp('^' + name + ' ·') }))
  return screen.getByRole('region', { name })
}

describe('resource workbench', () => {
  it('provides a named keyboard-focusable region for scrolling the resource content', () => {
    setup()
    const panel = screen.getByRole('region', { name: 'Host resources' })
    expect(panel.tabIndex).toBe(0)
    panel.focus()
    expect(document.activeElement).toBe(panel)
  })

  it('renders four resource selectors and one focused device instead of four repeated cards', () => {
    setup()
    const buttons = within(screen.getByRole('navigation', { name: 'Select a resource' })).getAllByRole('button')
    expect(buttons.map(button => [button.getAttribute('aria-label'), button.getAttribute('aria-pressed')])).toMatchInlineSnapshot(
      `
      [
        [
          "CPU · 10%",
          "false",
        ],
        [
          "Memory · 25%",
          "false",
        ],
        [
          "GPU · 0%",
          "true",
        ],
        [
          "Disks · 0%",
          "false",
        ],
      ]
    `)
    const gpu = screen.getByRole('region', { name: 'GPU' })
    expect(within(gpu).getByRole('heading', { name: 'Test GPU' })).toBeTruthy()
    expect(within(gpu).getByRole('img', { name: 'GPU utilization' })).toBeTruthy()
    expect(within(gpu).getByRole('progressbar', { name: 'Dedicated memory' }).getAttribute('aria-valuenow')).toBe('0')
    expect(screen.getAllByRole('img', { name: 'GPU history' })).toHaveLength(1)
    expect(screen.queryByRole('region', { name: 'CPU' })).toBeNull()
  })

  it('shows the CPU matrix, memory composition and separate physical disks and capacities on selection', () => {
    setup()
    const cpu = choose('CPU')
    expect(within(cpu).getByRole('heading', { name: 'Test CPU' })).toBeTruthy()
    for (let index = 0; index < 4; index++) expect(within(cpu).getByLabelText('CPU ' + index + ' · 10%')).toBeTruthy()
    expect(screen.getByRole('img', { name: 'CPU history' })).toBeTruthy()
    const memory = choose('Memory')
    expect(within(memory).getByRole('progressbar', { name: 'Physical memory composition' }).getAttribute('aria-valuenow')).toBe('25')
    expect(within(memory).getByText('2 KiB')).toBeTruthy()
    expect(within(memory).getByText('6 KiB')).toBeTruthy()
    const disks = choose('Disks')
    expect(within(disks).getByRole('heading', { name: '0 D: E:' })).toBeTruthy()
    expect(within(disks).getByRole('heading', { name: 'D:' })).toBeTruthy()
    expect(within(disks).getByText(en.capacityHint)).toBeTruthy()
    expect(screen.getByRole('img', { name: 'Disks history' })).toBeTruthy()
  })

  it('freezes data, keeps the selected view and releases its resource hold when paused', () => {
    const h = setup()
    choose('CPU')
    expect(h.holders()).toBe(1)
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    expect(h.holders()).toBe(0)
    const newer = snapshot()
    newer.cpu.data!.utilization = 90
    h.update({ status: 'live', value: newer, failure: undefined })
    expect(screen.getByRole('button', { name: 'CPU · 10%' })).toBeTruthy()
    expect(screen.getByText('This view is frozen. Resume to collect current metrics.')).toBeTruthy()
    choose('Memory')
    const cpu = choose('CPU')
    expect(within(cpu).getByRole('heading', { name: 'Test CPU' })).toBeTruthy()
    expect(h.holders()).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    expect(h.holders()).toBe(1)
    expect(within(screen.getByRole('region', { name: 'CPU' })).getByText('90%')).toBeTruthy()
  })

  it('selects among real same-name GPUs without discarding a separate device and keeps that choice on pause', () => {
    const data = snapshot()
    data.gpu.data!.push({ ...data.gpu.data![0]!, id: 'gpu-b', utilization: 35 })
    const h = setup({ status: 'live', value: data, failure: undefined })
    fireEvent.click(screen.getByRole('button', { name: 'View Test GPU, device 2' }))
    expect(within(screen.getByRole('region', { name: 'GPU' })).getByText('35%')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    expect(screen.getByRole('button', { name: 'View Test GPU, device 1' })).toBeTruthy()
    expect(h.holders()).toBe(0)
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
    expect(within(screen.getByRole('region', { name: 'GPU' })).getByText('35%')).toBeTruthy()
  })

  it('keeps the primary adapter stable when a current utilization reading is unavailable', () => {
    const data = snapshot()
    data.gpu.data![0]!.utilization = null
    data.gpu.data!.push({ ...data.gpu.data![0]!, id: 'gpu-b', name: 'Small GPU', dedicatedTotalBytes: 1024, utilization: 0 })
    const h = setup({ status: 'live', value: data, failure: undefined })
    expect(within(screen.getByRole('region', { name: 'GPU' })).getByRole('heading', { name: 'Test GPU' })).toBeTruthy()
    expect(screen.getByText('GPU utilization is unavailable; other readings are retained')).toBeTruthy()
    const recovered = { ...data, gpu: { ...data.gpu, data: data.gpu.data!.map(gpu => ({ ...gpu, utilization: 0 })) } }
    h.update({ status: 'live', value: recovered, failure: undefined })
    expect(within(screen.getByRole('region', { name: 'GPU' })).getByRole('heading', { name: 'Test GPU' })).toBeTruthy()
  })

  it('releases the resource on tab hiding and resumes only for a visible body', () => {
    const h = setup()
    h.visibility(false)
    expect(h.holders()).toBe(0)
    expect(screen.queryByRole('region', { name: 'Host resources' })).toBeNull()
    h.visibility(true)
    expect(h.holders()).toBe(1)
    h.view.unmount()
    expect(h.holders()).toBe(0)
  })

  it('retains values after a failed stream and offers reconnect without blanking metrics', () => {
    const h = setup()
    h.update({ status: 'failed', value: snapshot(), failure: undefined })
    expect(screen.getByText('Connection interrupted. Showing the last received values.')).toBeTruthy()
    expect(choose('CPU')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    expect(h.retry).toHaveBeenCalledOnce()
  })

  it('shows unavailable GPU data as unknown and keeps other resources selectable', () => {
    const data = snapshot()
    data.gpu = { status: 'unavailable', data: null, sampledAt: null, code: 'counter-unavailable' }
    setup({ status: 'live', value: data, failure: undefined })
    const gpu = screen.getByRole('region', { name: 'GPU' })
    expect(within(gpu).queryByText('0%')).toBeNull()
    expect(within(gpu).getByText(en.counterUnavailable)).toBeTruthy()
    expect(within(gpu).getByText('—')).toBeTruthy()
    expect(choose('CPU')).toBeTruthy()
  })

  it('does not report a partial physical-disk sum as a complete read rate', () => {
    const data = snapshot()
    data.disks.data!.push({ id: '1', name: '1 C:', activePercent: null, readBytesPerSecond: null, writeBytesPerSecond: 100 })
    setup({ status: 'live', value: data, failure: undefined })
    const disks = choose('Disks')
    expect(within(disks).getByText('Some disk readings are unavailable')).toBeTruthy()
    expect(within(disks).getAllByText('—').length).toBeGreaterThan(0)
  })

  it('keeps a history gap unknown during keyboard inspection', () => {
    const data = snapshot()
    data.history.push({ ...data.history[0]!, timestamp: 2000, gpu: { 'gpu-a': null } }, { ...data.history[0]!, timestamp: 3000, gpu: { 'gpu-a': 50 } })
    setup({ status: 'live', value: data, failure: undefined })
    const chart = screen.getByRole('img', { name: 'GPU history' })
    fireEvent.keyDown(chart, { key: 'ArrowLeft' })
    expect(screen.getByText(/· —$/)).toBeTruthy()
    fireEvent.keyDown(chart, { key: 'ArrowRight' })
    expect(screen.getByText(/· 50%$/)).toBeTruthy()
  })

  it('reports initial loading and supports pausing before the first sample', () => {
    const h = setup({ status: 'loading', value: undefined, failure: undefined })
    expect(screen.getByRole('status', { name: 'Loading resource metrics' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    expect(h.holders()).toBe(0)
    expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy()
  })

  it('renders localized fixed chrome without a resource subscription', () => {
    const useResource = vi.fn()
    const props = { t: translate(zh), useResource } as Parameters<typeof MonitorTitle>[0]
    render(<MonitorTitle {...props} />)
    expect(screen.getByText('本机资源')).toBeTruthy()
    expect(useResource).not.toHaveBeenCalled()
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })

  it('formats absence separately from zero and does not fill across missing samples', () => {
    const t = translate(en), format = createMetricFormatters(t)
    expect(bytes(0, t)).toBe('0 B')
    expect(bytes(1024 ** 3, t)).toBe('1 GiB')
    expect(bytes(null, t)).toBe('—')
    expect(percent(0, t)).toBe('0%')
    expect(percent(undefined, t)).toBe('—')
    expect(format.percent(0)).toBe('0%')
    expect(format.bytes(null)).toBe('—')
    expect(format.rate(1024)).toBe('1 KiB/s')
    expect(trendPath([0, null, 100])).toBe('M0.0,46.0 M240.0,2.0')
    expect(trendPath([])).toBe('')
    expect(trendAreaPath([0, null, 100])).toBe('')
    const area = trendAreaPath([0, 25, null, 50, 75])
    expect(area.split('Z')).toHaveLength(3)
    expect(area).not.toContain('120.0')
  })
})
