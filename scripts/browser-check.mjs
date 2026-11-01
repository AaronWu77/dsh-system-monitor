/** Browser acceptance against the existing GUI. Creates one empty owned session, never sends a model prompt. */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { cpus } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { processProbes } from './process-metrics.mjs'
import { createWindowsNative } from '../src/host/windows-native.ts'
import { counterNumber, parseGpuInstance } from '../src/host/windows-metrics.ts'
import { browserCookie } from './browser-auth.mjs'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const checkout = resolve(root, '../../..')
const origin = process.env.DSH_MONITOR_ORIGIN ?? 'http://127.0.0.1:3080'
assert.equal(new URL(origin).hostname, '127.0.0.1', 'Acceptance uses the explicitly selected local Host only')
const expectedGpuCount = process.env.DSH_MONITOR_EXPECT_GPU_COUNT === undefined ? undefined : Number(process.env.DSH_MONITOR_EXPECT_GPU_COUNT)
if (expectedGpuCount !== undefined) assert.ok(Number.isInteger(expectedGpuCount) && expectedGpuCount >= 1 && expectedGpuCount <= 64, 'DSH_MONITOR_EXPECT_GPU_COUNT must be an integer from 1 to 64')
const output = resolve(root, '.local/browser')
await mkdir(output, { recursive: true })
const cookie = await browserCookie(checkout, process.env.DSH_HOME, origin)
const browser = await chromium.launch({ headless: true, channel: process.env.DSH_BROWSER_CHANNEL ?? 'chrome' })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', locale: 'zh-CN' })
await context.addCookies([cookie])
const page = await context.newPage()
const report = { origin, checks: [], screenshots: [], layouts: [], errors: [] }
const resources = ['cpu', 'memory', 'gpu', 'disks']
const historyName = /history|历史趋势/i
const streamPath = '/api/dsh-system-monitor/stream'
let ownedSession
let ownedWorkspace
let monitorTemporarilyDisabled = false
let probe
let native
const perfSeconds = Number(process.env.DSH_MONITOR_PERF_SECONDS ?? 0)
const perfRows = []
const performanceSession = await browser.newBrowserCDPSession()
const hostPid = Number(process.env.DSH_MONITOR_HOST_PID)
const taskPid = Number(process.env.DSH_TASKMGR_PID)
async function measure(stage, seconds) {
  if (!probe) return
  const logical = cpus().length
  const take = async () => {
    const processes = (await performanceSession.send('SystemInfo.getProcessInfo')).processInfo
    const chrome = new Map(processes.map(row => [row.id, probe.read(row.id)]).filter(([, value]) => value !== null))
    const host = probe.read(hostPid), task = probe.read(taskPid)
    assert.ok(host && task, 'End-to-end comparison requires readable Host and existing Task Manager processes')
    let engineRows
    try { native.collect(); engineRows = native.readCounter('gpu') } catch (error) { engineRows = null }
    const gpu = pids => {
      if (engineRows === null) return null
      const values = new Map()
      for (const row of engineRows) {
        const match = /^pid_([0-9]+)_/i.exec(row.name)
        if (!match || !pids.has(Number(match[1]))) continue
        const identity = parseGpuInstance(row.name)
        const value = counterNumber(row)
        if (!identity || identity.engine === null || value === null) return null
        const key = identity.id + ':' + identity.engine
        values.set(key, (values.get(key) ?? 0) + value)
      }
      return values.size === 0 ? 0 : Math.min(100, Math.max(...values.values()))
    }
    return { now: performance.now(), chrome, host, task, browserGpu: gpu(new Set(chrome.keys())), hostGpu: gpu(new Set([hostPid])), taskGpu: gpu(new Set([taskPid])) }
  }
  let before = await take()
  for (let i = 0; i < seconds; i++) {
    await delay(1000)
    const after = await take()
    const elapsed = after.now - before.now
    let browserCpuMs = 0
    for (const [pid, current] of after.chrome) { const previous = before.chrome.get(pid); if (previous) browserCpuMs += Math.max(0, current.cpuMs - previous.cpuMs) }
    perfRows.push({ stage, intervalMs: elapsed, browserCpuPercent: browserCpuMs / elapsed / logical * 100,
      browserPrivateBytes: [...after.chrome.values()].reduce((sum, process) => sum + process.privateBytes, 0),
      hostCpuPercent: (after.host.cpuMs - before.host.cpuMs) / elapsed / logical * 100, hostPrivateBytes: after.host.privateBytes,
      taskCpuPercent: (after.task.cpuMs - before.task.cpuMs) / elapsed / logical * 100, taskPrivateBytes: after.task.privateBytes,
      browserGpuPercent: after.browserGpu, hostGpuPercent: after.hostGpu, taskGpuPercent: after.taskGpu })
    before = after
  }
}
async function rpc(method, args) {
  const response = await context.request.post(origin + '/api/' + method, { data: { type: 'client-request', rpcId: randomUUID(), method, payload: { args } }, headers: { Origin: origin } })
  assert.equal(response.status(), 200, 'RPC HTTP status for ' + method)
  const frame = await response.json()
  if (frame.result?.ok !== true) throw new Error('RPC failed for ' + method + ': ' + JSON.stringify(frame.result?.error))
  return frame.result.value
}
async function selectedResource(panel, resource) {
  const detail = panel.locator('[data-resource-detail="' + resource + '"]')
  await detail.waitFor({ state: 'visible', timeout: 15000 })
  assert.equal(await panel.locator('[data-resource-detail]').count(), 1, 'Only the selected resource has a detail view')
  assert.equal(await panel.locator('button[data-resource][aria-pressed="true"]').count(), 1)
  for (const candidate of resources) {
    const button = panel.locator('button[data-resource="' + candidate + '"]')
    assert.equal(await button.isEnabled(), true, 'Resource selector remains actionable: ' + candidate)
    assert.equal(await button.getAttribute('aria-pressed'), String(candidate === resource))
  }
  assert.equal(await panel.locator('[data-monitor-trend]').count(), 1, 'One selected-resource trend; GPU gauge is a separate image')
  assert.equal(await panel.getByRole('img', { name: historyName }).count(), 1, 'The selected trend has its own accessible name')
  assert.equal(await panel.locator('[data-monitor-trend]').getAttribute('tabindex'), '0', 'Trend supports keyboard inspection')
  return detail
}
async function waitForTrend(panel) {
  const trend = panel.locator('[data-monitor-trend]')
  await trend.waitFor({ state: 'visible', timeout: 15000 })
  await page.waitForFunction(() => {
    const history = document.querySelector('[data-system-monitor] [data-monitor-trend]')
    return history && [...history.querySelectorAll('path')].some(path => (path.getAttribute('d') ?? '').includes(' L'))
  }, undefined, { timeout: 30000 })
}
async function checkTheme(panel) {
  const theme = await panel.evaluate(element => {
    const names = ['--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-label-primary', '--dsw-alias-label-secondary', '--dsw-alias-border-l2', '--dsw-alias-brand-primary-new-colorprimary-new-color']
    const body = getComputedStyle(document.body)
    const style = getComputedStyle(element)
    const trend = element.querySelector('[data-monitor-trend]')
    const probe = document.createElement('span')
    probe.style.display = 'none'
    element.append(probe)
    try {
      const resolvedTokens = Object.fromEntries(names.map(name => {
        probe.style.color = 'var(' + name + ')'
        return [name, getComputedStyle(probe).color]
      }))
      return {
        dark: document.body.hasAttribute('data-ds-dark-theme'),
        globalTokens: Object.fromEntries(names.map(name => [name, body.getPropertyValue(name).trim()])),
        panelTokens: Object.fromEntries(names.map(name => [name, style.getPropertyValue(name).trim()])),
        resolvedTokens,
        panelColor: style.color,
        trendColor: trend ? getComputedStyle(trend).color : null,
      }
    } finally { probe.remove() }
  })
  report.theme = theme
  assert.equal(theme.dark, false, 'Acceptance requires the existing GUI global light appearance; do not override body theme attributes')
  for (const [name, value] of Object.entries(theme.globalTokens)) {
    assert.ok(value, 'The existing GUI supplies semantic token ' + name)
    assert.equal(theme.panelTokens[name], value, 'The monitor inherits the global token ' + name)
  }
  assert.equal(theme.panelColor, theme.resolvedTokens['--dsw-alias-label-primary'])
  assert.equal(theme.trendColor, theme.resolvedTokens['--dsw-alias-brand-primary-new-colorprimary-new-color'])
  assert.equal(await panel.getByRole('button', { name: /dark|light|深色|浅色/i }).count(), 0, 'The monitor has no separate theme switch')
  report.checks.push('existing GUI global light theme and inherited DSH brand/label/surface tokens; no feature theme override')
}
async function checkResourceDetail(panel, resource) {
  const detail = await selectedResource(panel, resource)
  switch (resource) {
    case 'cpu': {
      const cores = detail.locator('[data-core]')
      await cores.first().waitFor({ state: 'visible', timeout: 15000 })
      const indexes = await cores.evaluateAll(cells => cells.map(cell => Number(cell.getAttribute('data-core'))))
      assert.equal(indexes.length, cpus().length, 'The local Host shows every logical processor')
      assert.deepEqual(indexes, indexes.map((_, index) => index), 'Logical-processor matrix has one indexed cell per core')
      break
    }
    case 'memory':
      await detail.locator('[data-meter="memory"]').waitFor({ state: 'visible', timeout: 15000 })
      assert.match(await detail.textContent(), /\d[\d.,]*\s*(GiB|MiB|TiB)/, 'Memory detail includes real capacity values')
      break
    case 'gpu':
      await detail.locator('[data-monitor-gauge]').first().waitFor({ state: 'visible', timeout: 15000 })
      await detail.locator('[data-meter="vram"]').first().waitFor({ state: 'visible', timeout: 15000 })
      await detail.getByText(/专用显存|Dedicated memory/).first().waitFor({ state: 'visible' })
      await detail.locator('[aria-label="引擎负载"], [aria-label="Engine utilization"]').waitFor({ state: 'visible', timeout: 15000 })
      break
    case 'disks':
      await detail.locator('[data-physical-disk]').first().waitFor({ state: 'visible', timeout: 15000 })
      await detail.locator('[data-volume]').first().waitFor({ state: 'visible', timeout: 15000 })
      break
    default:
      assert.fail('Unexpected resource ' + resource)
  }
}
async function checkGpuCount(panel) {
  if (expectedGpuCount === undefined) return
  await selectedResource(panel, 'gpu')
  await waitForTrend(panel)
  const count = 1 + await panel.locator('[data-resource-detail="gpu"] button[data-gpu-device]').count()
  assert.equal(count, expectedGpuCount, 'Live GPU inventory equals the selected device plus the other-device buttons')
  report.gpuCount = { expected: expectedGpuCount, actual: count }
  report.checks.push('live GPU inventory: selected device plus other-device buttons = ' + count)
}
async function checkLayout(panel, resource, viewportWidth) {
  await page.waitForFunction(() => {
    const element = document.querySelector('[data-system-monitor]')
    if (!element) return false
    const rect = element.getBoundingClientRect()
    return rect.width <= innerWidth && rect.right <= innerWidth + 1 && rect.left >= -1
  }, undefined, { timeout: 15000 })
  const geometry = await panel.evaluate(element => {
    const bounds = element.getBoundingClientRect()
    const detail = element.querySelector('[data-resource-detail]')
    const controls = [...element.querySelectorAll('button')].map(button => {
      const rect = button.getBoundingClientRect()
      return { resource: button.getAttribute('data-resource'), width: rect.width, height: rect.height, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
    })
    return { panelWidth: element.clientWidth, scrollWidth: element.scrollWidth, detailWidth: detail?.clientWidth, detailScrollWidth: detail?.scrollWidth, left: bounds.left, right: bounds.right, viewportWidth: innerWidth, controls }
  })
  assert.ok(geometry.scrollWidth <= geometry.panelWidth + 1, 'Panel horizontal overflow: ' + resource + ' at ' + viewportWidth)
  assert.ok(geometry.detailScrollWidth <= geometry.detailWidth + 1, 'Resource detail horizontal overflow: ' + resource + ' at ' + viewportWidth)
  for (const [index, control] of geometry.controls.entries()) {
    assert.ok(control.width > 0 && control.height > 0 && control.left >= geometry.left - 1 && control.right <= geometry.right + 1, 'Primary controls stay inside the panel at ' + viewportWidth)
    for (const other of geometry.controls.slice(index + 1)) {
      const overlapX = Math.min(control.right, other.right) - Math.max(control.left, other.left)
      const overlapY = Math.min(control.bottom, other.bottom) - Math.max(control.top, other.top)
      assert.ok(overlapX <= 1 || overlapY <= 1, 'Primary controls do not overlap at ' + viewportWidth)
    }
  }
  const vertical = await panel.evaluate(element => {
    const bounds = element.getBoundingClientRect()
    return { panelHeight: element.clientHeight, contentHeight: element.scrollHeight, viewportHeight: innerHeight, top: bounds.top, bottom: bounds.bottom }
  })
  assert.ok(vertical.top >= -1 && vertical.bottom <= vertical.viewportHeight + 1, 'Panel must stay within the viewport instead of clipping overflowing ' + resource + ' content')
  await panel.evaluate(element => { element.scrollTop = 0 })
  if (vertical.contentHeight > vertical.panelHeight + 1) {
    await panel.hover()
    await page.mouse.wheel(0, vertical.contentHeight)
    await page.waitForFunction(() => {
      const element = document.querySelector('[data-system-monitor]')
      return element && element.scrollTop > 0 && element.scrollHeight - element.clientHeight - element.scrollTop <= 1
    }, undefined, { timeout: 15000 })
    const footerVisible = await panel.evaluate(element => {
      const bounds = element.getBoundingClientRect()
      const footer = element.querySelector('footer')?.getBoundingClientRect()
      return footer && footer.top >= bounds.top && footer.bottom <= bounds.bottom
    })
    assert.equal(footerVisible, true, 'Wheel scrolling reaches the footer of ' + resource)
    await page.mouse.wheel(0, -vertical.contentHeight)
    await page.waitForFunction(() => document.querySelector('[data-system-monitor]')?.scrollTop === 0, undefined, { timeout: 15000 })
    await panel.press('End')
    await page.waitForFunction(() => {
      const element = document.querySelector('[data-system-monitor]')
      return element && element.scrollHeight - element.clientHeight - element.scrollTop <= 1
    }, undefined, { timeout: 15000 })
    await panel.press('Home')
    await page.waitForFunction(() => document.querySelector('[data-system-monitor]')?.scrollTop === 0, undefined, { timeout: 15000 })
    report.checks.push(resource + ' content reaches its footer and returns to the top with wheel and keyboard at ' + viewportWidth + 'x' + vertical.viewportHeight)
  }
  const name = 'monitor-' + resource + '-' + viewportWidth + 'x' + vertical.viewportHeight + '-light.png'
  await panel.screenshot({ path: resolve(output, name) })
  report.layouts.push({ resource, ...geometry, capture: vertical })
  report.screenshots.push(name)
}
try {
  const unauthorized = await fetch(origin + '/api/dsh-system-monitor/config')
  assert.equal(unauthorized.status, 401)
  const denied = await context.request.get(origin + '/api/dsh-system-monitor/config', { headers: { Origin: 'http://example.invalid' } })
  assert.equal(denied.status(), 403)
  const config = await context.request.get(origin + '/api/dsh-system-monitor/config')
  assert.equal(config.status(), 200)
  report.checks.push('existing 3080 Host: unauthenticated401, foreign-origin403, owner200')
  page.on('pageerror', error => { report.errors.push(error.message) })
  const testDirectory = resolve(output, 'workspace-' + randomUUID())
  await mkdir(testDirectory, { recursive: true })
  const adopted = await rpc('workspace/create', { request: { path: testDirectory } })
  assert.equal(adopted.created, true, 'Acceptance must own a newly created workspace')
  ownedWorkspace = adopted.workspace.workspaceId
  const created = await rpc('session/create', { request: { workspaceId: ownedWorkspace, sessionId: randomUUID() } })
  ownedSession = created.sessionId
  await rpc('session/rename', { request: { sessionId: ownedSession, title: 'System Monitor acceptance (empty)' } })
  await page.goto(origin, { waitUntil: 'domcontentloaded' })
  await page.locator('style[data-dsh-system-monitor-style]').waitFor({ state: 'attached', timeout: 60000 })
  const group = page.locator('[data-row-key="workspace:' + ownedWorkspace + '"]')
  await group.waitFor({ state: 'visible', timeout: 30000 })
  if (await group.getAttribute('aria-expanded') === 'false') await group.click()
  const row = page.locator('[data-row-key="session:' + ownedSession + '"]')
  await row.waitFor({ state: 'attached', timeout: 30000 })
  if (await row.getAttribute('aria-selected') !== 'true') await row.dispatchEvent('click')
  const expand = page.locator('[data-sidebar-right-expand]')
  if (await expand.isVisible()) await expand.click()
  else await page.keyboard.press('Control+Shift+B')
  const guide = page.locator('[data-sidebar-right-guide-entry="system-monitor"]')
  if (!(await guide.isVisible())) {
    const add = page.getByRole('button', { name: /^(新标签页|New tab)$/ }).last()
    if (await add.isVisible()) await add.click()
  }
  await guide.waitFor({ timeout: 15000 })
  if (perfSeconds > 0) {
    assert.ok(Number.isInteger(perfSeconds) && perfSeconds >= 10 && perfSeconds <= 120)
    probe = processProbes()
    native = createWindowsNative({ gpuEnabled: true, disksEnabled: false })
    await measure('warmup-excluded', 30)
    await measure('guide-no-monitor', 30)
  }
  await guide.click()
  const panel = page.locator('[data-system-monitor]')
  await panel.waitFor({ state: 'visible', timeout: 15000 })
  await panel.locator('button[data-resource="gpu"][aria-pressed="true"]').waitFor({ state: 'visible', timeout: 15000 })
  assert.deepEqual(await panel.locator('button[data-resource]').evaluateAll(buttons => buttons.map(button => button.getAttribute('data-resource'))), resources)
  await selectedResource(panel, 'gpu')
  await waitForTrend(panel)
  await checkTheme(panel)
  await checkGpuCount(panel)
  report.checks.push('real profile discovers built browser factory and guide; four actual resource buttons, GPU selected by default, one selected detail and trend, no model request')
  if (process.env.DSH_MONITOR_PROFILE === '1') {
    const profiler = await context.newCDPSession(page)
    await profiler.send('Profiler.enable')
    await delay(15000)
    await profiler.send('Profiler.start')
    await delay(10000)
    const { profile } = await profiler.send('Profiler.stop')
    const total = profile.nodes.reduce((sum, node) => sum + (node.hitCount ?? 0), 0)
    const top = profile.nodes.filter(node => node.hitCount > 0).sort((a, b) => b.hitCount - a.hitCount).slice(0, 30).map(node => ({ function: node.callFrame.functionName, url: node.callFrame.url, hits: node.hitCount, sharePercent: node.hitCount / total * 100 }))
    const durations = []
    for (const [name, captured] of [['live', profile]]) {
      const ownerUrl = captured.nodes.map(node => node.callFrame.url).find(url => url.includes('dsh-system-monitor/client.js'))
      assert.ok(ownerUrl, 'Profile must include the actual combined monitor module URL')
      const text = await (await context.request.get(ownerUrl)).text()
      const marker = 'window.__ModuleLoader__.load({id:"dsh-system-monitor"'
      const index = text.indexOf(marker)
      if (index < 0) { durations.push({ stage: name, classificationUnavailable: 'The server rewrote the factory wrapper; no monitor-specific CPU share is asserted.' }); continue }
      const next = text.indexOf('window.__ModuleLoader__.load({id:', index + marker.length)
      const startLine = text.slice(0, index).split(String.fromCharCode(10)).length - 1
      const endLine = next < 0 ? Infinity : text.slice(0, next).split(String.fromCharCode(10)).length - 1
      const parents = new Map()
      const own = new Set()
      for (const node of captured.nodes) {
        for (const child of node.children ?? []) parents.set(child, node.id)
        const frame = node.callFrame
        if (frame.url === ownerUrl && frame.lineNumber >= startLine && frame.lineNumber < endLine) own.add(node.id)
      }
      let ownUs = 0
      for (let i = 0; i < (captured.samples ?? []).length; i++) {
        let id = captured.samples[i]
        while (id !== undefined && !own.has(id)) id = parents.get(id)
        if (id !== undefined) ownUs += captured.timeDeltas[i] ?? 0
      }
      const durationUs = captured.endTime - captured.startTime
      durations.push({ stage: name, durationMs: durationUs / 1000, monitorJavaScriptMs: ownUs / 1000, monitorJavaScriptWholeMachineCpuPercent: ownUs / durationUs / cpus().length * 100, ownStackNodes: own.size })
    }
    await panel.getByRole('button', { name: /^(暂停|Pause)$/ }).click()
    await profiler.send('Profiler.start')
    await delay(10000)
    const { profile: pausedProfile } = await profiler.send('Profiler.stop')
    const pausedTotal = pausedProfile.nodes.reduce((sum, node) => sum + (node.hitCount ?? 0), 0)
    const pausedTop = pausedProfile.nodes.filter(node => node.hitCount > 0).sort((a, b) => b.hitCount - a.hitCount).slice(0, 8).map(node => ({ function: node.callFrame.functionName, hits: node.hitCount, sharePercent: node.hitCount / pausedTotal * 100 }))
    await panel.getByRole('button', { name: /^(恢复|Resume)$/ }).click()
    await delay(3000)
    await profiler.send('Profiler.start')
    await delay(10000)
    const { profile: resumedProfile } = await profiler.send('Profiler.stop')
    const resumedTotal = resumedProfile.nodes.reduce((sum, node) => sum + (node.hitCount ?? 0), 0)
    const resumedTop = resumedProfile.nodes.filter(node => node.hitCount > 0).sort((a, b) => b.hitCount - a.hitCount).slice(0, 8).map(node => ({ function: node.callFrame.functionName, hits: node.hitCount, sharePercent: node.hitCount / resumedTotal * 100 }))
    await writeFile(resolve(output, 'renderer-profile.json'), JSON.stringify({ total, top, durations, pausedTop, resumedTop, warmupMs: 15000, limitation: 'Sampling of monitor JavaScript call stacks and descendants, not renderer layout, paint, driver work or a complete process CPU measurement.' }, null, 2) + String.fromCharCode(10))
    console.log(JSON.stringify({ rendererProfileSummary: durations, activeTop: top.slice(0, 5).map(({ url, ...row }) => row), pausedTop, resumedTop }, null, 2))
    await profiler.detach()
  }
  if (perfSeconds > 0) await measure('monitor-live', perfSeconds)
  for (const [width, height] of [[390, 600], [720, 600], [1440, 600], [390, 1000], [720, 1000], [1440, 1000]]) {
    await page.setViewportSize({ width, height })
    await panel.waitFor({ state: 'visible' })
    for (const resource of ['gpu', 'cpu', 'memory', 'disks']) {
      await panel.locator('button[data-resource="' + resource + '"]').click()
      await checkResourceDetail(panel, resource)
      await waitForTrend(panel)
      await checkLayout(panel, resource, width)
    }
    report.checks.push('all four resource selections and primary controls fit viewport ' + width + 'x' + height + ' without horizontal overflow')
  }
  const cpuButton = panel.locator('button[data-resource="cpu"]')
  await cpuButton.focus()
  await cpuButton.press('Enter')
  await selectedResource(panel, 'cpu')
  await page.setViewportSize({ width: 390, height: 1000 })
  assert.equal(await cpuButton.evaluate(button => button === document.activeElement), true, 'Resource-selector focus survives responsive width changes')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await panel.locator('button[data-resource="cpu"]').click()
  await selectedResource(panel, 'cpu')
  await panel.getByRole('button', { name: /^(暂停|Pause)$/ }).click()
  await panel.getByRole('button', { name: /^(恢复|Resume)$/ }).waitFor({ state: 'visible' })
  assert.equal(await panel.getAttribute('data-paused'), 'true')
  await selectedResource(panel, 'cpu')
  const frozenSample = await panel.getByText(/^(更新于|Updated )/).textContent()
  for (const resource of ['gpu', 'memory', 'disks', 'cpu']) {
    await panel.locator('button[data-resource="' + resource + '"]').click()
    await selectedResource(panel, resource)
    assert.equal(await panel.getByText(/^(更新于|Updated )/).textContent(), frozenSample, 'Paused selection keeps the frozen sample timestamp')
  }
  if (perfSeconds > 0) await measure('monitor-paused', 30)
  await panel.getByRole('button', { name: /^(恢复|Resume)$/ }).click()
  await panel.getByRole('button', { name: /^(暂停|Pause)$/ }).waitFor({ state: 'visible' })
  assert.equal(await panel.getAttribute('data-paused'), null)
  await selectedResource(panel, 'cpu')
  await waitForTrend(panel)
  await page.waitForFunction(previous => [...document.querySelectorAll('[data-system-monitor] span')].some(span => /^(更新于|Updated )/.test(span.textContent ?? '') && span.textContent !== previous), frozenSample, { timeout: 15000 })
  report.checks.push('resource buttons support keyboard activation and retain focus across widths; pause freezes the snapshot while resources remain selectable, resume restores live data')
  const reconnect = page.waitForRequest(request => new URL(request.url()).pathname === streamPath, { timeout: 15000 })
  await Promise.all([reconnect, panel.getByRole('button', { name: /^(重新连接|重试|Reconnect|Retry)$/ }).click()])
  await waitForTrend(panel)
  report.checks.push('Reconnect opens a fresh authenticated stream without leaving the real profile panel')
  if (perfSeconds > 0) {
    await measure('monitor-live-confirm', perfSeconds)
    await panel.getByRole('button', { name: /^(暂停|Pause)$/ }).click()
    await measure('monitor-paused-confirm', 30)
    await panel.getByRole('button', { name: /^(恢复|Resume)$/ }).click()
    await waitForTrend(panel)
  }
  if (process.env.DSH_MONITOR_HMR_TEST === '1') {
    const disabled = await rpc('pluginManager/setBundleEnabled', { name: 'dsh-system-monitor', enabled: false })
    monitorTemporarilyDisabled = true
    assert.equal(disabled.application, 'applied')
    await page.locator('style[data-dsh-system-monitor-style]').waitFor({ state: 'detached', timeout: 30000 })
    const missing = await context.request.get(origin + '/api/dsh-system-monitor/config')
    assert.equal(missing.status(), 404)
    const enabled = await rpc('pluginManager/setBundleEnabled', { name: 'dsh-system-monitor', enabled: true })
    assert.equal(enabled.application, 'applied')
    monitorTemporarilyDisabled = false
    await page.locator('style[data-dsh-system-monitor-style]').waitFor({ state: 'attached', timeout: 30000 })
    assert.equal(await page.locator('style[data-dsh-system-monitor-style]').count(), 1)
    await selectedResource(panel, 'gpu')
    await waitForTrend(panel)
    report.checks.push('real profile disable removes authenticated route and Client styles; re-enable restores one style and live data without restarting Host')
  }
  assert.deepEqual(report.errors, [])
  if (perfRows.length > 0) {
    const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length
    const summary = ['guide-no-monitor', 'monitor-live', 'monitor-paused', 'monitor-live-confirm', 'monitor-paused-confirm'].map(stage => {
      const rows = perfRows.filter(row => row.stage === stage)
      const fields = ['browserCpuPercent', 'hostCpuPercent', 'taskCpuPercent', 'browserPrivateBytes', 'hostPrivateBytes', 'taskPrivateBytes', 'browserGpuPercent', 'hostGpuPercent', 'taskGpuPercent']
      return Object.fromEntries([['stage', stage], ['samples', rows.length], ...fields.flatMap(field => { const values = rows.map(row => row[field]).filter(value => value !== null); return [[field + 'Mean', values.length ? mean(values) : null], [field + 'Peak', values.length ? Math.max(...values) : null]] })])
    })
    const evidence = { timestamp: new Date().toISOString(), note: 'Actual existing GUI and Host at 1 second update. Separate Chrome context/process tree. Native process CPU time and committed private memory; CPU normalized by 24 logical processors. Process-associated GPU Engine counters grouped by physical engine. No stress workload generated. Task Manager is the existing process; its page/visibility/update speed are not controlled. Host includes all other user sessions and background work, so incremental estimates remain subject to ambient activity.', summary, raw: perfRows }
    await writeFile(resolve(output, 'end-to-end-performance.json'), JSON.stringify(evidence, null, 2) + String.fromCharCode(10))
    report.performance = summary
  }
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + String.fromCharCode(10))
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  report.failure = error.message
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + String.fromCharCode(10))
  // Only capture the feature panel; never retain unrelated conversation content.
  const panel = page.locator('[data-system-monitor]')
  try {
    if (await panel.isVisible()) await panel.screenshot({ path: resolve(output, 'failure-panel.png') })
  } catch (screenshotError) { console.error('Failure-panel capture unavailable: ' + screenshotError.message) }
  throw error
} finally {
  if (monitorTemporarilyDisabled) {
    try { await rpc('pluginManager/setBundleEnabled', { name: 'dsh-system-monitor', enabled: true }) }
    catch (error) { console.error('Monitor restore failed: ' + error.message); process.exitCode = 1 }
  }
  if (ownedSession) {
    try { await rpc('workspace/archiveSession', { request: { sessionId: ownedSession } }); console.log('Archived the empty acceptance session') }
    catch (error) { console.error('Empty acceptance-session archive failed: ' + error.message); process.exitCode = 1 }
  }
  if (ownedWorkspace) {
    try { await rpc('workspace/delete', { request: { workspaceId: ownedWorkspace } }); console.log('Removed only the owned acceptance workspace registration') }
    catch (error) { console.error('Acceptance workspace cleanup failed: ' + error.message); process.exitCode = 1 }
  }
  native?.close()
  probe?.close()
  await context.close()
  await browser.close()
}
