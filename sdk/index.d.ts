/** DeviceDock extension API v1. All byte arrays are owned snapshots. */
export type LaneId = 'A' | 'B'
export type View = { title?: string; fields?: { label: string; value: string | number | boolean }[]; text?: string; children?: View[] }
export type Command = { id: string; title: string; fields?: { key: string; type: 'string' | 'number' | 'boolean'; required?: boolean }[] }
export type Decoded = { protocol: string; address?: string; command?: string | number; sequence?: number; values: Record<string, unknown> }
export type Frame = { bytes: Uint8Array; view?: View; decoded?: Decoded; metadata?: Record<string, unknown> }
export interface ProtocolContext { lane: LaneId; mode: 'live' | 'replay'; generation: number }
export interface ProtocolInstance {
 feed(bytes: Uint8Array): Frame[]
 decode?(bytes: Uint8Array): Frame
 configure?(options: Record<string, unknown>): void
 fork?(): ProtocolInstance
 encode?(command: { id: string; values?: Record<string, unknown> }): Uint8Array
 snapshot?(): unknown
 restore?(snapshot: unknown): void
 reset(): void
 dispose?(): void
}
export interface ProtocolDefinition {
 id: string; title: string; commands?: Command[]
 create(context: ProtocolContext): ProtocolInstance
}
export interface SerialOptions { baudRate: number; dataBits?: 7 | 8; stopBits?: 1 | 2; parity?: 'none' | 'even' | 'odd'; flowControl?: 'none' | 'hardware' }
export interface StreamPort {
 getInfo?(): Record<string, unknown>
 open(options: SerialOptions): Promise<void>
 readable: ReadableStream<Uint8Array> | null
 writable: WritableStream<Uint8Array> | null
 close(): Promise<void>
}
export interface TransportProvider { id: string; title: string; requestPort(options?: unknown): Promise<StreamPort> }
export interface LogRecord { sequence: number; lane: LaneId; generation: number; time: number; direction: 'rx' | 'tx' | 'system'; bytes: Uint8Array; frames?: Frame[]; views?: View[]; text?: string }
export interface SessionService {
 readonly generation: number
 readonly state: string
 readonly connected: boolean
 readonly deviceInfo: Record<string, unknown> | null
 readonly busy: boolean
 open(port: StreamPort, options: SerialOptions): Promise<void>
 close(): Promise<void>
 send(bytes: Uint8Array, options?: { owner?: string; generation?: number }): Promise<void>
 subscribe(fn: (record: LogRecord) => void): () => void
 claim(owner: string): () => void
 transaction<T>(owner: string, run: (scope: { signal: AbortSignal; send(bytes: Uint8Array): Promise<void>; subscribe(fn: (record: LogRecord) => void): () => void }) => Promise<T>, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<T>
}
export interface HostServices {
 assets: { read(packagePath: string): Promise<Uint8Array>; url(packagePath: string): string; createWorker(packagePath: string, options?: WorkerOptions): Promise<Worker> }
 apiVersion: 1
 capabilities: Readonly<Record<string, boolean>>
 registerProtocol(definition: ProtocolDefinition): () => void
 registerTransport(provider: TransportProvider): () => void
/** Versioned org.devicedock.*.v1 services, or plugin.<manifest-id>.<name>; collisions rejected. */
 registerService(id: string, service: unknown): () => void
 getService(id: string): unknown
 session(lane: LaneId): SessionService
 resources: { requestPort(providerId?: string, options?: unknown): Promise<StreamPort>; createSession(id: string): SessionService; releaseSession(id: string): Promise<void> }
 prepareDeactivate(check: () => void | Promise<void>): () => void
 storage: { get(key: string): unknown; set(key: string, value: unknown): void }
 mount: HTMLElement
 signal: AbortSignal
 log(message: string): void
}
export interface ExtensionModule { activate(host: HostServices): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)> }
export interface Manifest {
 schemaVersion: 1; id: string; name: string; version: string; apiVersion: 1
 kind: 'protocol' | 'plugin' | 'transport' | 'firmware'
 entry: string; platforms: ('web' | 'desktop' | 'mobile')[]
 capabilities: string[]; integrity: Record<string, string>
 license: string
}
