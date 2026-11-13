// A connection source supplies a stream port, not a second receive/send screen.
// Availability is provided by AppPlatform services; this module never sniffs native APIs.
;(function (root) {
	'use strict'
	const P = root.AppPlatform, A = root.SerialAdapter, D = root.AppDialog
	if (!P || !A || !D || !P.service('classic') && !P.service('computer-ble')) return
	let choosing = false
	function el(tag, text, parent) { const e = document.createElement(tag); if (text) e.textContent = text; parent.appendChild(e); return e }
	function availableSources() {
		return [['computer-ble', 'BLE', 'computer-ble'], ['classic', I18n.t('connSource.classicBluetoothSpp'), 'classic']]
			.filter(([, , service]) => P.service(service)).map(([id, label]) => ({ id, label }))
	}
	async function requestPort(kind = 'serial') {
		if (choosing) throw new Error(I18n.t('connSource.selectingConnection'))
		if (kind === 'serial') return { port: await A.requestPort() }
		if (!availableSources().some(s => s.id === kind)) throw new Error(I18n.t('connSource.thisDeviceSourceIsUnavailable'))
		choosing = true
		let result = null, live = true, ownedBle = false, action = null, heldRecord = null, inspecting = false
		const nativeBle = P.service('computer-ble'), classic = P.service('classic')
		try {
			await D.panel({ title: I18n.t('connSource.selectDevice', { label: availableSources().find(s => s.id === kind).label }), wide: true, closeText: I18n.t('connSource.cancel'), build(body, dialog) {
				body.classList.add('connection-source')
				const content = el('div', null, body), error = el('p', null, body); error.setAttribute('role', 'status')
				const retry = el('button', I18n.t('connSource.retryReleasingTheUnfinishedSelection'), body); retry.type = 'button'; retry.className = 'btn btn-sm btn-outline-danger'; retry.hidden = true
				function showError(e) {
					if (!live) return
					error.textContent = e.message || String(e)
					retry.hidden = !(kind === 'computer-ble' && nativeBle.canRetryRelease())
				}
				async function run(fn, b) {
					if (action || !live) return
					error.textContent = ''; if (b) b.disabled = true
					const job = Promise.resolve().then(fn); action = job
					try { await job } catch (e) { showError(e) }
					finally { if (action === job) action = null; if (b) { b.disabled = false; if (b.afterAction) b.afterAction() } }
				}
				retry.onclick = () => run(async () => { await nativeBle.releasePicker(); ownedBle = false; heldRecord = null; retry.hidden = true; await showBle() }, retry)
				function button(parent, text, fn) {
					const b = el('button', text, parent); b.type = 'button'; b.className = 'btn btn-sm btn-outline-primary'
					b.onclick = () => run(fn, b)
					return b
				}
				function input(parent, label, value) { const l = el('label', label, parent), i = el('input', null, l); i.className = 'form-control form-control-sm'; i.value = value || ''; return i }
				function select(parent, label) { const l = el('label', label, parent), s = el('select', null, l); s.className = 'form-select form-select-sm'; return s }
				function option(s, value, label) { const o = el('option', label, s); o.value = String(value) }
				function done(port, discard) { result = { port, discard }; dialog.close() }
				function showClassic() {
					el('p', I18n.t('connSource.chooseADeviceThatOffersSpp'), content)
					button(content, I18n.t('connSource.choosePairedDevice'), async () => {
						const found = await classic.run('discover'); if (!live) return
						const d = found.devices.find(d => d.deviceId === found.selectedDeviceId)
						if (!d || !d.paired) throw new Error(I18n.t('connSource.pairWithTheSystemFirstThen'))
						done(classic.createPort(d.deviceId))
					})
					button(content, I18n.t('connSource.searchAndPair'), async () => {
						const found = await classic.run('pair'); if (!live) return
						const d = found.devices.find(d => d.deviceId === found.selectedDeviceId)
						if (!d || !d.paired) throw new Error(I18n.t('connSource.theSystemHasnTConfirmedPairing'))
						done(classic.createPort(d.deviceId))
					})
				}
				async function showBle() {
					if (!live) return
					if (!ownedBle && !nativeBle.canSelect()) {
						content.replaceChildren()
						throw new Error(nativeBle.canRetryRelease() ? I18n.t('connSource.cleanupOfTheLastScanOr') : I18n.t('connSource.useThisLaneSDisconnectTo'))
					}
					ownedBle = true; content.replaceChildren()
					const filters = el('div', null, content); filters.className = 'connection-filters'
					const query = input(filters, I18n.t('connSource.nameAdvertisedUuidAliasContains'))
					const minimum = input(filters, I18n.t('connSource.minimumRssiPositiveNumberEG')); minimum.type = 'number'; minimum.min = '1'; minimum.max = '127'; minimum.step = '1'
					const rssiThreshold = () => {
						if (minimum.value === '') return ''
						const magnitude = Number(minimum.value)
						if (!Number.isInteger(magnitude) || magnitude < 1 || magnitude > 127) throw new Error(I18n.t('connSource.enterAMinimumRssiBetween1'))
						return -magnitude
					}
					const order = select(filters, I18n.t('connSource.sort')); option(order, 'signal', I18n.t('connSource.strongestSignal')); option(order, 'name', I18n.t('connSource.name')); option(order, 'recent', I18n.t('connSource.recentlySeen'))
					const state = el('p', null, content); state.setAttribute('role', 'status'); state.setAttribute('aria-live', 'polite')
					const rows = el('div', null, content); rows.className = 'connection-devices'; rows.setAttribute('role', 'group'); rows.setAttribute('aria-label', I18n.t('connSource.scanDevices'))
					let selectedId = '', scanning = false, viewAlive = true, scanJob = null
					const rowMap = new Map()
					const controls = el('div', null, content); controls.className = 'connection-actions'
					function paint() {
						if (!live || !viewAlive) return
						let list
						try { list = root.NativeBle.visibleDevices(nativeBle.devices(), query.value, rssiThreshold(), order.value) }
						catch (e) { state.textContent = e.message; connect.disabled = true; return }
						const ids = new Set(list.map(d => d.deviceId))
						for (const [id, row] of rowMap) if (!ids.has(id)) { row.remove(); rowMap.delete(id) }
						list.forEach((d, i) => {
							let row = rowMap.get(d.deviceId)
							if (!row) {
								row = el('button', null, rows); row.type = 'button'; row.className = 'connection-device'
								row.onclick = () => { if (!action && live) { selectedId = d.deviceId; paint() } }
								rowMap.set(d.deviceId, row)
							}
							row.setAttribute('aria-pressed', String(d.deviceId === selectedId))
							row.textContent = (d.alias ? d.alias + ' · ' : '') + d.name + ' · ' + (d.rssi == null ? I18n.t('connSource.signalUnknown') : d.rssi + ' dBm') + '\n' + (d.services.join(' · ') || I18n.t('connSource.noAdvertisedServiceUuid'))
							if (rows.children[i] !== row) {
								const focused = document.activeElement === row
								rows.insertBefore(row, rows.children[i] || null)
								if (focused) row.focus()
							}
						})
						const shown = I18n.t('connSource.showing', { length: list.length, length2: nativeBle.devices().length })
						state.textContent = (scanning ? I18n.t('connSource.scanning') : I18n.t('connSource.scanPaused')) + ' · ' + shown + (list.length ? '' : I18n.t('connSource.noMatchingDevices')) + (selectedId && !ids.has(selectedId) ? I18n.t('connSource.selectedDeviceHiddenByFilter') : '')
						connect.disabled = !selectedId || !ids.has(selectedId)
						pause.textContent = scanning ? I18n.t('connSource.pauseScan') : I18n.t('connSource.resumeScan')
					}
					function start() {
						scanning = true
						scanJob = nativeBle.scan(paint)
						scanJob.then(() => { scanning = false; paint() }, e => {
							scanning = false; paint()
							if (viewAlive) showError(e)
						})
					}
					const pause = button(controls, I18n.t('connSource.pauseScan'), async () => {
						if (scanning) { await nativeBle.stopScan(); await scanJob; scanning = false }
						else start()
						paint()
					})
					const connect = button(controls, I18n.t('connSource.connectAndDiscoverTxRx'), async () => {
						const device = nativeBle.devices().find(d => d.deviceId === selectedId)
						if (!device || !root.NativeBle.visibleDevices([device], query.value, rssiThreshold(), order.value).length) throw new Error(I18n.t('connSource.selectAVisibleDeviceFirst'))
						await nativeBle.stopScan(); if (!live) return
						state.textContent = I18n.t('connSource.connectingAndDiscoveringGatt'); inspecting = true
						try { heldRecord = await nativeBle.inspect(device) } finally { inspecting = false }
						if (!live) return
						viewAlive = false; showMapping(heldRecord)
					})
					connect.afterAction = paint
					query.oninput = minimum.oninput = order.onchange = paint
					el('p', I18n.t('connSource.theListUpdatesContinuouslyNamesAnd'), content)
					start(); paint()
				}
				function showMapping(record) {
					content.replaceChildren(); el('h3', I18n.t('connSource.txRxMapping', { name: record.device.name }), content)
					const alias = input(content, I18n.t('connSource.deviceAliasThisPageSCurrent'), nativeBle.preference(record.device.deviceId).alias)
					alias.maxLength = 32
					alias.oninput = () => nativeBle.remember(record.device.deviceId, { alias: alias.value.trim().slice(0, 32) })
					el('p', I18n.t('connSource.txIsComputerDeviceRxIs'), content)
					const mode = select(content, I18n.t('connSource.txWriteMode')); option(mode, 'true', I18n.t('connSource.withResponseWrite')); option(mode, 'false', I18n.t('connSource.withoutResponseWritewithoutresponse'))
					const tx = select(content, I18n.t('connSource.txComputerDevice')), rx = select(content, I18n.t('connSource.rxDeviceComputer'))
					const label = c => I18n.t('connSource.serviceInstance', { characteristic: c.characteristic, service: c.service, map: [[8, 'write'], [4, 'writeWithoutResponse'], [16, 'notify'], [32, 'indicate']].filter(([bit]) => c.props & bit).map(([, label]) => label).join(' / '), v: (c.id + 1) })
					function fill(s, list) { const old = s.value; s.replaceChildren(); option(s, '', I18n.t('connSource.selectAFullUuidAndIts')); for (const c of list) option(s, c.id, label(c)); if (list.some(c => String(c.id) === old)) s.value = old; else if (list.length === 1) s.value = String(list[0].id) }
					function paintTx() { fill(tx, record.chars.filter(c => c.props & (mode.value === 'true' ? 8 : 4))) }
					paintTx(); fill(rx, record.chars.filter(c => c.props & 48))
					const summary = el('pre', null, content); summary.className = 'connection-mapping'
					function preview() { summary.textContent = 'TX: ' + (tx.selectedOptions[0] && tx.selectedOptions[0].textContent || I18n.t('connSource.notSelected')) + '\nRX: ' + (rx.selectedOptions[0] && rx.selectedOptions[0].textContent || I18n.t('connSource.notSelected')) }
					mode.onchange = () => { paintTx(); preview() }; tx.onchange = rx.onchange = preview
					try {
						const saved = nativeBle.preference(record.device.deviceId).profile
						if (saved) { const ids = root.NativeBle.match(record.chars, saved); mode.value = String(saved.response); paintTx(); tx.value = String(ids.tx); rx.value = String(ids.rx) }
					} catch (e) { error.textContent = e.message || String(e) }
					preview()
					button(content, I18n.t('connSource.confirmMappingAndStart'), () => {
						const profile = root.NativeBle.mapping(record.chars, tx.value, rx.value, mode.value === 'true')
						nativeBle.remember(record.device.deviceId, { profile, alias: alias.value.trim().slice(0, 32) })
						const selected = nativeBle.createPort(record, profile, Number(tx.value), Number(rx.value))
						done(selected.port, selected.discard)
					})
					el('p', I18n.t('connSource.showsConnectedOnlyAfterTheRx'), content)
					button(content, I18n.t('connSource.backToScanChangeDevice'), async () => { await nativeBle.close(record); heldRecord = null; await showBle() })
				}
				// Enter the requested picker directly; the device dropdown already chose the source.
				run(kind === 'computer-ble' ? showBle : showClassic)
			} })
			live = false
			if (!result && ownedBle) {
				// In-flight inspection has no handle yet: invalidate and drain it immediately.
				if (inspecting) await nativeBle.releasePicker()
				else { await nativeBle.stopScan(); if (heldRecord) await nativeBle.close(heldRecord) }
			}
			if (action) await action.catch(() => {})
			return result
		} finally { live = false; choosing = false }
	}
	const api = { requestPort, availableSources, isBusyForUpdate: () => choosing,
		ports: () => [...(P.service('classic') ? P.service('classic').ports() : []), ...(P.service('computer-ble') ? P.service('computer-ble').ports() : [])],
	}
	P.provide('connection-source', api)
	A.addPortProvider(() => api.ports())
})(window)
