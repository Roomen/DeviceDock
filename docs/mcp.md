# MCP execution and compatibility

The desktop service is opt-in, loopback-only, bearer-authenticated and independent of login. It accepts exact localhost/loopback Host headers and rejects every browser Origin. The token persists in private application configuration; reveal and regenerate are explicit UI actions. Reloading a window replaces its document registration and drains its old requests. Window destruction removes only that window. Select a window using `windows_list` and the `window` argument when more than one is registered.

Each explicit tool has a bounded structural schema. The extension validates semantic fields. Optional definition `timeoutMs` is an integer from 1000 through 1800000; default is 30000. Native fence deadline and execution timeout use the same value. Catalogs are limited to 512 tools and 4 MiB; pending calls to 32. The public catalog omits the private deadline metadata. Extension registration changes update only that window without cancelling unrelated in-flight calls in the same document. A true document epoch change drains old calls. Disabling an owning extension still aborts and drains its own calls.

`commit(): Promise<void>` is awaited inside the actual serialized I/O queue immediately before the first effect, with signal/connection/owner checks before and after. No dispatcher precommit and no automatic mutation retry. `structuredContent.code` and `executed:false|"unknown"` distinguish requests that did not commit from uncertain committed operations. Read-only handlers need no commit. A timed-out mutation can have partial effects; inspect state/recovery before retrying.

| Previous name / argument | Current behavior |
| --- | --- |
| `serial_ports_list`, `serial_state` | Compatibility aliases for `serial_ports`, `host_state` |
| `serial_select` then `serial_open` | Explicit authorized opaque `deviceId` or exact unique `sn`; selected object is rechecked before opening |
| `serial_configure` | Validated lane options; idle connected lane is closed/reopened; partial/unknown errors remain visible |
| `encoding`, omitted encoding | Alias for `format`; default HEX |
| `append_crlf` | Preserved for composed serial writes |
| `serial_read` | Document/lane/generation cursor; `waitMs` through 30000; independent raw ring survives UI clear |
| `S` lane | Single-lane compatibility name for A; B remains an explicit independent lane |
| `blu_*` | `org.devicedock.power.blu_*`, only when the power extension is enabled |
| USB bridge `ble_*` | `org.devicedock.bridge.ble_*`, only when the bridge extension is enabled |
| `classic_*` | Exact allowlisted aliases for `<wireless-extension-id>.classic_*`, only while its attested native SPP transport is registered |

The original eight Classic SPP operations use the same native queue and independent byte cursor as the system pairing/transport provider. Discover/pair require local OS interaction and have 120-second bounds. They are absent from zero-plugin and unsupported-native catalogs. An enabled wireless extension owns registration, abort/drain and aliases. Busy/connected/system-dialog/lane-owned native state blocks deactivation; idle cleanup awaits native release. A third-party transport object cannot claim these unprefixed aliases. Standalone Classic tools reject core-lane ownership and direct callers to serial tools.

No registered business service is automatically callable. Only explicit adapters enter MCP. Stop/restart preserves the bearer token; regeneration invalidates in-flight requests. Update preparation freezes and drains calls while keeping the HTTP service alive; failed preparation resumes it.
