# Example: an independently built plugin page

`examples/page-plugin/` (next to this document; only `manifest.json` and
`index.js` live there so the package stays packable) is a complete, standalone
extension package source that demonstrates the page contract. It is built and verified exactly like any other
package, so it also proves the published contract instead of describing it.

```sh
node tools/integrate.mjs pack examples/page-plugin /tmp/page-demo.json   # verify + pack
# then import /tmp/page-demo.json in 扩展管理, tick 「信任此版本」 and enable
```

The package is not part of the shipped registry: the default distribution stays
zero-plugin.

## What the example uses

```js
export function activate(host) {
  const page = host.registerPage({ title: 'Example page' })
  // host.mount is this extension's own <section>; nothing else is reachable.
  // host.signal aborts on disable; every listener must use it.
  page.setTitle('Renamed')            // optional; defaults to manifest.name
  return () => { /* dispose owned DOM/resources */ }
}
```

## Page rules enforced by the host

1. One navigation entry per enabled extension. The label is the page title from
   `registerPage({title})`, otherwise `manifest.name` (trimmed to 40 chars).
2. Packages that register only parsers/transports (`kind: protocol`, no DOM) get
   **no** page: an empty tab is never created. If a legacy `host.mount` plugin
   appends UI (even after an async step), the page is promoted automatically.
3. Switching pages only toggles `hidden`. The section, its state and any running
   work stay alive; the host never re-runs `activate()`.
4. `devicedock:page-show` / `devicedock:page-hide` fire on the section, and
   `devicedock:page-resize` on `window`. Re-measure anything that needs layout
   (xterm fit, canvases, iframe bounds) on those events: a hidden pane has zero
   size and would otherwise keep a stale layout.
5. Disabling the extension removes the entry, removes the section and closes
   every contribution. If the removed page is the current one, the host returns
   to 「通信调试」.
6. Protocol/plugin/transport/firmware packages keep their existing lifecycle
   contract; `registerPage` is additive and optional.
