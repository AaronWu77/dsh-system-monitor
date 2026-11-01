---
description: "Monitor the Windows DSH host's CPU, memory, GPUs and disks in the existing sidebar."
kind: "package-bundle"
---

# System Monitor

English | [中文](README.zh.md)

## Plugin information

| Field | Value |
|---|---|
| Package | dsh-system-monitor |
| Version | 0.1.0, not published to npm |
| License | MIT |
| Distribution | Local bundle with [source on GitHub](https://github.com/AaronWu77/dsh-SystemMonitor); no separate documentation site. |

Package identity and upstream declarations live in [package.json](package.json). An empty upstream list does not claim that the package and its dependencies are entirely original. The implementation uses the Harness plugin API, Windows system interfaces, and Koffi; their licenses remain applicable.

## Overview

Open the existing right sidebar, choose **New tab**, then **Host resources**. Four resource buttons select CPU, memory, GPU or disks, with GPU selected initially. The panel uses the existing DSH theme and adds no permanent chat-header button or footer card. The sidebar belongs to a conversation; the measurements always describe the local DSH Host, even when the conversation uses SSH or the browser runs on another device.

## Contents

- [Use](#use)
- [Configuration](#configuration)
- [Measurements and resource use](#measurements-and-resource-use)
- [Security and lifecycle](#security-and-lifecycle)
- [Development and verification](#development-and-verification)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

## Use

The top resource row contains four real buttons: **CPU**, **Memory**, **GPU** and **Disks**. The selected button stays pressed and displays one resource detail view and one recent-history trend. The initial selection is **GPU**; resource buttons also work with keyboard activation.

CPU shows its logical-processor matrix. Memory shows used/available composition and capacity. GPU shows an arc-shaped utilization gauge, a dedicated-memory bar, shared-memory readings and engines. Disks separates physical-disk activity/read/write readings from volume-capacity bars; volume capacity is not physical-disk utilization.

The panel begins with a short rate-counter warm-up. Use **Pause** to freeze the current view and release its live subscription; resource selection remains available. **Resume** starts live collection again, and **Reconnect** reconnects immediately. Unknown values display as unavailable, not as zero. A failed domain retains its last valid value and marks it stale.

Colors inherit DSH semantic tokens and follow the global GUI appearance; the plugin has no independent light/dark switch. Resource selectors and details adapt to the sidebar width, including a 390 px browser viewport. Content taller than the available sidebar scrolls within the panel; focus the panel to scroll with the keyboard, including Home and End.

Only a visible live panel subscribes. Switching tabs, pausing, closing the panel, or hiding the browser releases or suspends its HTTP stream. The Host stops the shared collector after its configured idle grace. Multiple panels or browser windows share that collector. Reopening after a complete stop starts a new short history; no background history is promised.

## Configuration

The [bundle patch](cordis.patch.yml) inserts one independent Host plugin whose browser entry is discovered from its manifest. Install it into the selected DSH profile after building; a build alone does not install it. The Host validates configuration and supplies effective browser timing through its authenticated endpoint.

| Field | Default | Meaning |
|---|---:|---|
| intervalMs | 1000 | Sampling period, integer 500–10000 ms. |
| capacityIntervalMs | 60000 | Fixed-volume capacity and adapter inventory refresh, 10000–3600000 ms. |
| historySeconds | 60 | In-memory trend window, 30–300 seconds. |
| idleGraceMs | 1500 | Grace after the final viewer disconnects, 0–10000 ms. |
| workerStopTimeoutMs | 5000 | Graceful worker shutdown deadline before forced termination, 1000–30000 ms. |
| reconnectMs | 2000 | Retry delay after a stream failure, 1000–30000 ms. |
| streamTimeoutMs | 30000 | Maximum interval without a valid stream frame, 3000–60000 ms. Keep it comfortably above intervalMs. |
| gpuEnabled | true | Collect GPU counters. |
| disksEnabled | true | Collect physical disks and fixed-volume capacities. |

Invalid configuration fails before routes are registered. Host configuration reload closes old streams and collectors; the next client connection reads the new settings.

## Measurements and resource use

The Windows x64 Worker keeps one PDH query and reuses its buffers. It calls system DLLs directly through Koffi, not PowerShell, nvidia-smi, or the selected session's subprocess provider. DXGI inventory and fixed-volume capacity refresh slowly. Browser charts are static SVG paths updated only on received samples, not continuous animation. History stays in bounded memory; samples are not written to disk or Session logs.

CPU prefers Processor Utility, with Processor Time as a named fallback. Physical memory is total minus available physical bytes. GPU utilization is the busiest physical engine after combining processes on that engine, not the sum of all engines or the VRAM occupancy. Dedicated memory capacity comes from DXGI; a GPU without matching counters keeps unknown live values. Software adapters are excluded.

GPU aliases are merged only when native PCI bus/device/function identity and the physical-node index confirm the same device. Unknown identity, different PCI addresses and different physical nodes remain separate even when their names match. For confirmed aliases, the collector selects one whole report, preferring valid metric fields and engine count; it never sums alias utilization or memory readings. Device names are display labels, not deduplication keys.

Physical-disk activity is derived from idle time; throughput is bytes per second. Capacity belongs to logical volumes. Two partitions on the same disk do not become two physical throughput records. The total disk row is excluded to avoid double counting. First samples and failed reads never create artificial zero points in trends.

Optional timing diagnostics are separate from UI acceptance. Their reports belong under .local; collector timings alone do not measure Host transport, browser rendering or complete Task Manager parity.

## Security and lifecycle

The exact read-only GET routes /api/dsh-system-monitor/config and /api/dsh-system-monitor/stream use Connection's existing owner authentication and origin checks. The plugin opens no port and registers no agent tools. Responses contain aggregate host/device metrics, not process IDs, command lines, filenames or credentials. Streaming readers are bounded; malformed payloads fail visibly. Slow readers do not accumulate an unbounded queue.

Every subscription, style, route and tab registration leaves with the plugin. Unload stops admission, closes streams, requests Worker shutdown, and joins the Worker. Native query handles and temporary DXGI objects are released by their owning collector. Domain failures do not cancel unrelated metrics; a Worker failure ends the stream with an explicit failure so the browser can reconnect. The last valid snapshot is never relabeled as current after a failure.

## Development and verification

Development expects this repository at `local-plugins/plugins/system-monitor` inside a Harness source checkout because development dependencies and verification helpers use relative paths. From this package directory, install dependencies with pnpm install --ignore-scripts. Run pnpm run build, pnpm run typecheck, pnpm test, and pnpm run test:artifacts. The artifact smoke loads the built Host and browser factory, reads real Windows Worker samples, and checks clean shutdown. Non-Windows native smoke is explicitly skipped. Pure algorithm and lifecycle tests remain deterministic.

Run pnpm run test:browser only after the latest plugin build is available to the existing local GUI and the page has reloaded. The browser check uses the real profile sidebar entry at http://127.0.0.1:3080; it never starts or restarts a server. It uses the existing read-only browser authentication helper and a separate browser context, creates one empty test session/workspace, sends no prompt, then archives the session and removes only its workspace registration in finally. It does not inspect user conversations. Credentials and cookies remain memory-only and absent from reports, screenshots and logs.

Browser acceptance checks four button selections, the default GPU detail, resource-specific details, one selected-resource history trend, pause/resume and reconnect, and the existing GUI light theme with inherited DSH brand tokens. It captures only the complete monitor panel for every resource at viewport widths 390, 720 and 1440, increasing only the test viewport height when needed; .local/browser/report.json records the checks, computed semantic colors, layout measurements and the 12 screenshot names. A GPU gauge is an additional accessible image, not another history trend. The script does not set body theme attributes or introduce a plugin theme switch. Optionally set DSH_MONITOR_EXPECT_GPU_COUNT to an integer from 1 to 64 to assert that the live GPU inventory equals one selected device plus its other-device buttons; for a machine independently confirmed to have two devices, use 2.

DSH_MONITOR_HMR_TEST=1 additionally verifies disable/re-enable cleanup and restores the enabled bundle. Optional diagnostics remain available: pnpm run perf:collector -- 30 measures the production Worker; DSH_TASKMGR_PID selects an already-running Task Manager process. DSH_MONITOR_PERF_SECONDS=30 with DSH_MONITOR_HOST_PID and DSH_TASKMGR_PID enables process/GPU measurements; DSH_MONITOR_PROFILE=1 records renderer sampling. These options are not required for UI integration acceptance and do not generate a stress workload.

## Model Experience

- **Tools:** none.
- **Prompt and context:** no new model-visible input or Session event.
- **Tokens and KV cache:** no model token or KV-cache cost; aggregate samples remain outside the conversation log.

## Known Limitations and Deferred Work

Live native collection currently supports Windows x64. GPU engine counters require compatible WDDM drivers; permissions or driver failures can make individual fields unavailable. Non-Windows and non-x64 Hosts report unsupported rather than silently invoking a shell fallback.

This replaces the resource-monitoring view, not Task Manager's process management, startup applications, service controls or task termination. Temperatures, fan speeds, power draw, remote-host monitoring, persisted history and alerts are not included. Physically separate linked GPU nodes can share a description; unsupported nodes retain unknown values. The sidebar needs a selected conversation and is not a global settings-page panel.

CPU/GPU readings need not match Task Manager point for point because sample windows and engine selection can differ. UI integration acceptance does not claim performance parity with Task Manager.
