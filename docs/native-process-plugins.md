# Native executable plugins

DeviceDock desktop can install and launch independently compiled executable plugin processes. This is separate from its JS/WASM extension loader and its built-in serial/BLE/SPP drivers. Native plugins use an OS process and stdio JSON-RPC; they do not use the C shared-library ABI of EasyCLIProxyAPI's weekly-reset-priority/semantic-router plugins.

A native executable runs with the user's OS permissions. Clearing its environment and isolating its page does **not** sandbox the executable's filesystem/network access. Only grant trust after checking the author, source and package digest. Installation does not execute code. Each package digest needs an explicit native-side trust grant; a new package, including a rebuilt version with the same name/version, needs new authorization. Trust can be revoked and is never imported through frontend settings backups. Startup does not automatically launch installed plugins.

## Build the example

Requires Rust/Cargo and Node.js. From the repository root:

```sh
node examples/native-process/build.mjs /private/tmp/devicedock-native-example
```

The script builds the standalone Rust executable with no DeviceDock SDK or external source-repository checkout, then creates `example.ddnative.json` and its `.sha256` file. Cargo uses the example's committed lockfile. The executable implements `echo` and `sum`; its self-contained page exercises both. In desktop Settings → Native plugins, import the JSON package, check its full digest, explicitly trust that digest, then start. The page is registered independently in the navigation. Stopping/revoking/uninstalling removes its page. Switching pages retains the process and iframe.

The current script builds for the machine running it. Build on the intended platform/architecture; the installer rejects a different target. Manifest targets use Rust names, for example `macos-aarch64`, `windows-x86_64`, `linux-x86_64`. Browser builds report native plugins unavailable.

## Package format

A `.ddnative.json` file contains:

```json
{
  "manifest": {
    "schemaVersion": 1,
    "kind": "native-process",
    "id": "org.example.plugin",
    "name": "Example",
    "version": "1.0.0",
    "target": "macos-aarch64",
    "executable": "bin/plugin",
    "page": "ui.html",
    "methods": ["echo", "sum"],
    "integrity": {
      "bin/plugin": "sha256-<64 lowercase hex characters>",
      "ui.html": "sha256-<64 lowercase hex characters>"
    }
  },
  "files": {
    "bin/plugin": "<base64 executable bytes>",
    "ui.html": "<base64 UTF-8 HTML bytes>"
  }
}
```

The full raw UTF-8 JSON file has a separate SHA-256 digest. All declared files need matching integrity entries; no paths outside the package, symlinks, Windows device names, trailing dots or case-alias collisions are accepted. Limits: 44 MiB JSON, 32 MiB decoded files, 128 files, 512 KiB UTF-8 page, 64 declared methods. Installation uses a fresh staging directory followed by rename into app data `native-plugins-v1/<digest>`. Existing content is verified rather than overwritten; executable/assets are read-only on Unix. Every store ancestor and accessed file is checked for symlinks; use canonical storage paths. Native-side grants live in `native-plugins-v1/trust.json` and are checked independently of frontend booleans. Files are revalidated before trust, launch, page serving and calls. A modified installed package is rejected; stop/revoke/uninstall still provide cleanup by digest.

## Process protocol and lifetime

The host directly executes the declared binary with no shell and no command-line arguments. Cwd is the immutable package directory. Environment is empty, except `SystemRoot` on Windows for OS compatibility. Stdin/stdout are newline-delimited JSON-RPC 2.0; stderr goes to the null sink. The process must not daemonize, create a new session or escape its inherited process group/job. It must not assume an inherited PATH, HOME, credentials or writable cwd.

The first request is:

```json
{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":1}}
```

Reply with the same ID and `result:{"protocolVersion":1}`. Later requests have increasing numeric IDs and only invoke methods listed in the manifest. Each request has exactly one response (`result` or `error`), with no plugin-to-host requests, extra stdout logs or unsolicited notifications. JSON-RPC errors terminate the process and surface a bounded host error. Native plugins have no device/session/MCP host API in this version.

Requests and responses are bounded to 64 KiB; an instance allows eight queued requests, and the host allows sixteen live/starting instances. Handshake and total call/queue time have a five-second deadline. Expired or abandoned queued requests are skipped. A caller timeout terminates its instance and awaits cleanup before reporting the error; it cannot leave a queued request executing later. A timeout cannot undo work already performed before its deadline, so plugin authors must design side effects accordingly.

Stop/revoke/uninstall wait for process cleanup, including direct-child reaping. Unix cleanup kills the process group; Windows uses a kill-on-close Job Object and rejects startup if job attachment fails. The process remains registered as stopping until completion, preventing a replacement from overlapping it. Owner lease barriers isolate windows and document generations; navigation/refresh/window destruction release the owning instances, application update drains them before installation, and app exit prevents new starts and waits for all registered processes. Runtime state and failure messages are separate from persisted installation/trust records.

## Page API and host integration

Pages are one self-contained HTML file with inline CSS/JavaScript and optional data images. No external scripts/styles, network fetches, nested frames, forms or filesystem assets are enabled. The verified custom-protocol response injects a small bridge and a restrictive CSP. The host mounts it in an iframe with **only** `sandbox="allow-scripts"`, giving it an opaque origin. It has no parent DOM or Tauri globals. Native code itself remains unsandboxed.

Page JavaScript calls:

```js
const result = await window.deviceDockNative.call('sum', {values: [1, 2, 3]})
// {sum: 6, count: 3}
```

The parent checks the exact iframe `event.source`, method allowlist, message size, in-flight count and current registration. Removing a page removes its bridge listener. Page show/hide events are forwarded as messages. Global host script CSP remains unchanged; only `frame-src 'self' devicedock-native: http://devicedock-native.localhost` is added.

Integration:

```js
import {mountNativePlugins} from './shell/native-plugins.js'
const nativePlugins = await mountNativePlugins({
  platform,
  panel: document.querySelector('#native-plugin-settings'),
  pagesContainer: document.querySelector('#native-plugin-pages'),
  registerPage: ({id, title, element}) => {
    // Register with PageController; return its removal function.
    return registerNativePage(id, title, element)
  },
  status
})
```

The module owns the settings panel and pages it creates. `registerPage` returns a function or an object with `dispose()`. `dispose()` removes listeners/pages and awaits `native_plugin_release_owned`. Native events (`native-plugin-state`) and management actions refresh state; there is no polling. Unchanged records retain management DOM and focus. The module returns `{refresh, dispose}` and never auto-starts code. An optional `events` dependency can replace the default Tauri event singleton in tests.

## Validation

Run the targeted backend and adapter checks:

```sh
cargo test --lib --manifest-path desktop/src-tauri/Cargo.toml native_plugins::tests
node --test tests/native-plugins.test.mjs
```

`native-smoke` also supplies mode `native-plugins`: it loads the independently compiled example package, exercises install/trust/start/page RPC/stop/restart/revoke/uninstall in a real desktop webview and writes the existing native-smoke JSON result. `DEVICEDOCK_NATIVE_SMOKE_ROOT` isolates package/trust storage only in that feature and mode; it is ignored in production builds. Set it to a canonical writable directory. The GUI smoke requires a real graphical session; successful Rust/DOM tests alone do not establish WebKit/WebView2 rendering support. This implementation was developed/tested on macOS arm64; Windows/Linux execution still needs platform validation. Use the task's GUI handoff for exact command/artifact paths and current GUI evidence.
