import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// PROVES:         Source text only. That certain text is PRESENT, and that one
//                 forbidden form is ABSENT, in the two Rust files it reads with
//                 readFileSync -- src-tauri/src/lib.rs and
//                 src-tauri/src/utils/window_manager.rs. Adding
//                 `let _ = window.hide();` to the sliced close handler fails it.
// DOES NOT PROVE: That any of the checked code runs, compiles, or has the asserted
//                 effect.

const libSource = readFileSync('src-tauri/src/lib.rs', 'utf8')
const windowManagerSource = readFileSync(
  'src-tauri/src/utils/window_manager.rs',
  'utf8',
)
const combinedSource = `${libSource}\n${windowManagerSource}`

const closeHandlerStart = libSource.indexOf('pub fn handle_window_close')
const closeHandlerEnd = libSource.indexOf('#[cfg(feature = "clippy")]')

assert.ok(
  closeHandlerStart >= 0,
  'expected to find the Tauri window close handler',
)
assert.ok(
  closeHandlerEnd > closeHandlerStart,
  'expected close handler to appear before Tauri app build setup',
)

const closeHandler = libSource.slice(closeHandlerStart, closeHandlerEnd)

assert.ok(
  closeHandler.includes('api.prevent_close();'),
  'top-right X must still prevent the native close so it can hide/minimize safely',
)

assert.ok(
  !/let\s+_\s*=\s*window\.hide\(\)\s*;/.test(closeHandler),
  'CloseRequested must not ignore window.hide() result',
)

assert.ok(
  /handle_close_requested|handle_main_window_close|close_requested/.test(
    closeHandler,
  ),
  'CloseRequested should delegate to explicit close-lifecycle handling',
)

assert.ok(
  /tray_by_id\("main"\)|is_main_tray_available/.test(combinedSource),
  'close lifecycle must check whether the main tray is available before hiding',
)

assert.ok(
  /\.minimize\(\)/.test(combinedSource),
  'close lifecycle must fall back to minimizing the main window',
)

assert.ok(
  /CLOSE_REQUEST_IN_FLIGHT|CloseRequestGuard|compare_exchange/.test(
    combinedSource,
  ),
  'close lifecycle must guard repeated close requests',
)

assert.ok(
  /impl Drop for CloseRequestGuard[\s\S]*store\(false/.test(combinedSource),
  'close re-entry guard must auto-release through Drop',
)

assert.ok(
  /CLOSE_LIFECYCLE_LOG_LIMITER|CLOSE_WARNING_LOG_LIMITER|should_log_close/.test(
    combinedSource,
  ),
  'close diagnostics must be rate-limited or otherwise bounded',
)

console.log('close lifecycle validation passed')
