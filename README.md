English | [简体中文](README.zh-CN.md)

# DeviceDock

A serial port and device debugging workbench for the browser and the desktop client, with no login.

## Features

- **Communication debugging**: one lane or two lanes A/B with independent port settings, protocols and log formats; HEX / TEXT / ANSI / parsed log display; list and chat log views; quick send, cyclic send, log filtering, copy and export.
- **Protocols**: built-in SEK and CJ/T 188 parsers plus external protocol packages added from a repository or a local source, see the [protocol contract](docs/protocol-contract.md) and the [example protocol repository](examples/protocol-repo/).
- **Test flows and curves**: build batch or randomized read/write flows from the protocol's field catalogue, run them on the active lane, and plot decoded metrics as live curves.
- **Firmware packaging and upgrade**: build compressed or binary-diff update packages, keep imported firmware in a local library, and upgrade a device over the current lane; a diff package the device rejects is retried once as a compressed package.
- **Desktop client only**: native serial ports, computer BLE and classic Bluetooth SPP connections, the plugin host (see the [plugin contract](docs/plugin-contract.md) and the [example plugin](examples/plugin-hello/)), the local MCP service (see [desktop/MCP.md](desktop/MCP.md)) and in-app updates.

## Platforms

The web build runs in Chromium-based browsers and uses Web Serial. The desktop client targets macOS and Windows and loads the same page inside a Tauri 2 shell. On mobile the layout is unchanged but the profile keeps only the SEK protocol settings, SEK commands and firmware upgrade, over BLE, classic Bluetooth or, on Android, a serial port.

## Running from source

The web build is plain static files, so any static file server works:

```sh
python3 -m http.server 8000
```

Open `http://localhost:8000/` in Chrome or Edge. Web Serial needs a secure context (localhost counts) and is not available in Safari or Firefox.

The desktop client needs a Rust toolchain and the native toolchain of the host system:

```sh
cd desktop
npm install
npm run dev     # development
npm run build   # packaged build
```

Packages are copied to `desktop/release/<channel>/`, where the channel is `main` for official builds and `dev` for previews, and each channel keeps only its latest build there.

## Downloads

Installers are published on GitHub Releases: a `.dmg` for macOS and a portable `.zip` for Windows. The Windows build has no installer, extract the archive and run `DeviceDock.exe`; it needs the Microsoft Edge WebView2 runtime. The client checks for updates and installs them in place.

## Tests

```sh
for f in tests/*.cjs; do node "$f" || echo "FAIL $f"; done
node --test desktop/scripts/*.test.mjs
cargo test --manifest-path desktop/src-tauri/Cargo.toml --lib
cargo test --manifest-path desktop/portable-update-common/Cargo.toml
cargo test --manifest-path desktop/portable-updater/Cargo.toml
```

The `tests/*.cjs` files are plain Node scripts that feed synthetic serial data, so they need neither a browser nor hardware. Behaviour that has no automated test, such as the UI and real port handling, is checked by hand in a browser against a real or virtual serial port.

## License

[Apache License 2.0](LICENSE)
