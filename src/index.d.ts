/** A JSON boundary: native payloads and metadata retain their provider keys. */
export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject { [key: string]: JsonValue }

export type ErrorCode = 'INVALID_ARGUMENT' | 'AUTH_REQUIRED' | 'AUTH_FAILED'
  | 'UNSUPPORTED_OPERATION' | 'NETWORK_ERROR' | 'TIMEOUT' | 'ABORTED' | 'CLOSED'
  | 'RESYNC_REQUIRED' | 'OPERATION_FAILED';

export interface RequestOptions {
  signal?: AbortSignal;
  /** Deadline for the operation, including authentication and connection waits. */
  timeoutMs?: number;
}

export interface AuthSession {
  accessToken: string;
  refreshToken?: string;
  selectedTeamId?: number;
  source?: string;
}

export interface AuthStatus {
  authenticated: boolean;
  source?: string;
  storage?: string;
  expiresAt?: string | null;
  needsRefresh?: boolean;
  selectedTeamId?: number;
}

/** Managed authentication operations expose metadata, never session credentials. */
export interface Auth {
  status(options?: RequestOptions): Promise<AuthStatus>;
  refresh(options?: RequestOptions): Promise<AuthStatus>;
  logout(options?: RequestOptions): Promise<void>;
}

/** Authentication is controlled by the host; construction never initiates login. */
export interface AuthManager {
  getSession(options?: { forceRefresh?: boolean; signal?: AbortSignal }): Promise<AuthSession>;
  save?(session: AuthSession, options?: { signal?: AbortSignal }): Promise<void>;
  status?(options?: { signal?: AbortSignal }): Promise<AuthStatus>;
  logout?(options?: RequestOptions): Promise<void>;
}

export interface BotMetadata {
  id?: string;
  name?: string;
  viewerSessionId?: string;
  legacyAgentId?: string;
  harness?: string | number;
  kind?: string | number;
  viewerIsOwner?: boolean;
  viewerCanManage?: boolean;
  [key: string]: unknown;
}
export interface NativeBot extends BotMetadata { agentId: string }
export interface Bot extends BotMetadata { botId: string }

export interface RawRequestOptions extends RequestOptions {
  service?: string;
  maxFrameBytes?: number;
}

/** Opt-in transport injection for Node hosts and deterministic offline tests. */
export interface RawClient {
  rpc(method: string, body?: JsonObject, options?: RawRequestOptions): Promise<JsonObject>;
  stream(method: string, body: JsonObject, options?: RawRequestOptions): AsyncIterable<JsonObject>;
  listBots(options?: RequestOptions): Promise<NativeBot[]>;
  resolveBot(query: string | NativeBot, options?: RequestOptions): Promise<NativeBot>;
  accountFingerprint(options?: RequestOptions): Promise<string>;
  authManager?: AuthManager | null;
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
  close?(): void | Promise<void>;
}

export interface ClientOptions {
  tokenProvider?: (options?: RequestOptions) => string | Promise<string>;
  authManager?: AuthManager;
  fetchImpl?: typeof globalThis.fetch;
  http2Connect?: typeof import('node:http2').connect;
  /** Upstream client protocol version, independent of this package version. */
  version?: string;
  transport?: RawClient;
  /** Injected transports stay caller-owned unless this is explicitly true. */
  ownsTransport?: boolean;
  /** Maximum unread subscription events before RESYNC_REQUIRED. */
  maxBufferEvents?: number;
}

export interface LocalAttachment {
  path: string;
  name?: string;
  mimeType?: string;
  remotePath?: never;
}
export interface RemoteAttachment { remotePath: string; name: string; path?: never; mimeType?: never }
export type Attachment = string | LocalAttachment | RemoteAttachment;

export interface SendInput {
  botId: string;
  text: string;
  sessionId?: string;
  messageId?: string;
  attachments?: Attachment[];
  /** Defaults to false: return after acceptance, without waiting for a reply. */
  wait?: boolean;
  waitTimeoutMs?: number;
}

export interface NativeMessage {
  /** Exact uint64 decimal strings; never coerce these to JavaScript numbers. */
  seq: string;
  updatedSeq: string;
  entryId: string | null;
  kind: string | null;
  text: string | null;
  timestampMs: number | null;
  /** Native structured content; do not assume a text-only transcript. */
  entry: JsonObject | null;
  bodyUnavailable?: boolean;
  blobHash?: string;
}

export interface Message extends NativeMessage {
  id: string | null;
  role: string | null;
  replyToMessageId: string | null;
  createdAt: string | null;
  streaming: boolean;
}

export interface SendResult {
  botId: string;
  bot?: string;
  sessionId: string;
  messageId: string;
  delivery: JsonObject;
  status?: JsonObject;
  statusError?: string;
  replies?: NativeMessage[];
  replyPending?: boolean;
}

export type DeliveryState = 'unknown' | 'accepted';
export interface ErrorDetails {
  code?: ErrorCode;
  status?: number;
  requestId?: string;
  nativeCode?: string;
  receipt?: Partial<SendResult>;
  deliveryState?: DeliveryState;
}
export class BotterError extends Error {
  constructor(message?: string, details?: ErrorDetails);
  readonly code: ErrorCode;
  readonly status?: number;
  readonly requestId?: string;
  readonly nativeCode?: string;
  readonly receipt?: Partial<SendResult>;
  readonly deliveryState?: DeliveryState;
}

export interface HistoryInput {
  botId: string;
  sessionId?: string;
  /** 1–200 entries; defaults to 50. */
  limit?: number;
  beforeSeq?: string;
  generation?: number;
  unreadBoundaryMs?: string;
}

export interface HistoryPage {
  botId: string;
  bot?: string;
  sessionId: string;
  generation: number;
  nextBeforeSeq: string | null;
  /** Native decoded transcript rows retained for compatibility. */
  entries: NativeMessage[];
  /** Normalized messages, including createdAt and streaming. */
  messages: Message[];
}

export interface SearchInput {
  botId: string;
  query: string;
  sessionId?: string;
  limit?: number;
  pageSize?: number;
  maxPages?: number;
  beforeSeq?: string;
  since?: string | number;
  until?: string | number;
}

export interface SearchResult extends Omit<HistoryPage, 'generation'> {
  generation: number | undefined;
  query: string;
  pages: number;
  /** True only when the bounded history scan reached its end. */
  complete: boolean;
  totalMatchesInScan: number;
  matchesTruncated: boolean;
}

export interface WatchInput {
  botId: string;
  sessionId?: string;
  maxBufferEvents?: number;
}

export interface TranscriptCursor {
  agentId: string;
  sessionId: string;
  generation: number;
  afterUpdatedSeq: string;
}

export interface WatchPosition { botId: string; sessionId: string }
export interface EntryEvent extends WatchPosition, NativeMessage {
  type: 'entry';
  generation: number;
  replay: boolean;
  message: Message;
}
export interface DeleteEvent extends WatchPosition {
  type: 'delete';
  generation: number;
  seq: string;
  updatedSeq: string;
  entryId?: string;
}
export interface ConnectedEvent {
  type: 'connected';
  streamId?: string;
  serverTimeMs?: string;
  absoluteLifetimeMs?: string;
}
export interface ReconnectingEvent { type: 'reconnecting'; message: string; delayMs: number }
export interface HeartbeatEvent { type: 'heartbeat'; serverTimeMs?: string }
export interface AgentStateEvent {
  type: 'agentState';
  live?: JsonObject[];
  client?: JsonObject[];
  snapshot?: boolean;
}
export interface ComputerActionsEvent { type: 'computerActions'; actions?: JsonObject[] }
export interface AgentStateChangedEvent {
  type: 'agentStateChanged';
  botId: string;
  families?: string[];
  changedAtMs?: string;
}
export interface TurnFailedEvent extends WatchPosition {
  type: 'turnFailed';
  turnId?: string;
  code?: string | number;
  summary?: string;
  failedAtMs?: string;
  errorDetails?: JsonObject;
  account?: JsonObject;
}
export interface RosterChangedEvent {
  type: 'rosterChanged';
  botId?: string;
  kind?: string | number;
  changedAtMs?: string;
  agent?: JsonObject;
  changedFields?: (string | number)[];
}
export interface BoxStateEvent { type: 'boxState'; state?: JsonObject; snapshot?: boolean }
export interface PageTitleChangedEvent {
  type: 'pageTitleChanged';
  storeId?: string;
  canvasId?: string;
  documentId?: string;
  title?: string;
  changedAtMs?: string;
}
export interface ClearedEvent extends WatchPosition { type: 'cleared'; newGeneration: number }
export interface CursorTooOldEvent extends WatchPosition {
  type: 'cursorTooOld';
  generation?: number;
}
export interface ResyncRequiredEvent extends WatchPosition {
  type: 'resyncRequired';
  reason: string;
  message: string;
  generation: number;
  entryId: string | null;
  seq: string;
  updatedSeq: string;
  cursor: { generation: number; afterUpdatedSeq: string };
}
export type WatchEvent = EntryEvent | DeleteEvent | ConnectedEvent | ReconnectingEvent
  | ClearedEvent | CursorTooOldEvent | ResyncRequiredEvent | HeartbeatEvent | AgentStateEvent
  | ComputerActionsEvent | AgentStateChangedEvent | TurnFailedEvent | RosterChangedEvent
  | BoxStateEvent | PageTitleChangedEvent;

export interface Subscription<Event> extends AsyncIterable<Event> {
  cancel(): Promise<void>;
  readonly done: Promise<void>;
  readonly ready?: Promise<void>;
  /** Last yielded transcript position; queued events are never acknowledged early. */
  readonly cursor?: Readonly<WatchCursor>;
}

export interface WatchCursor {
  botId: string;
  sessionId: string;
  generation: number;
  afterUpdatedSeq: string;
}

export interface UploadInput {
  botId: string;
  sessionId?: string;
  path: string;
  name?: string;
  mimeType?: string;
  maxBytes?: number;
}
export interface UploadResult {
  botId: string;
  bot?: string;
  sessionId: string;
  kind: 'store';
  mode: 'single-put';
  path: string;
  alias: string;
  fileName: string;
  sizeBytes: number;
  contentType: string;
  sha256: string;
  [key: string]: unknown;
}
export type DownloadInput = {
  botId: string;
  sessionId?: string;
  path: string;
  output?: string;
  /** @deprecated Use output. If both are supplied, they must match. */
  destination?: string;
  maxBytes?: number;
  overwrite?: boolean;
} & ({ output: string } | { destination: string });
export interface DownloadResult {
  botId: string;
  bot?: string;
  sessionId: string;
  remotePath: string;
  output: string;
  /** @deprecated Use output. */
  destination: string;
  sizeBytes: number;
  contentType: string;
  via: 'store';
  sha256: string;
}

export interface ArtifactsInput {
  botId: string;
  sessionId?: string;
  maxPages?: number;
  pageSize?: number;
  beforeSeq?: string;
}
export interface ArtifactReference {
  entryId: string | null;
  seq: string;
  kind: string | null;
  timestampMs: number | null;
  source: 'path-field' | 'file-url' | 'markdown-link';
  field: string;
}
export interface Artifact extends ArtifactReference { path: string; references: ArtifactReference[] }
export interface ArtifactsResult {
  botId: string;
  bot?: string;
  sessionId: string;
  scope: 'transcript-references';
  generation: number | undefined;
  pages: number;
  complete: boolean;
  nextBeforeSeq: string | null;
  entriesScanned: number;
  inspectionComplete: boolean;
  inspectionTruncated: boolean;
  unavailableEntries: number;
  referenceCount: number;
  entries: Artifact[];
  note: string;
}

export interface Capabilities {
  readonly send: true;
  readonly history: true;
  readonly search: true;
  readonly watch: true;
  readonly upload: true;
  readonly download: true;
  readonly artifacts: true;
  readonly attachments: {
    readonly maxBytes: number;
    readonly uploadModes: readonly ['SINGLE_PUT'];
    readonly downloadOutcomes: readonly ['STORE'];
  };
  readonly verifiedAt: string;
  readonly backend: readonly string[];
}

/** SDK operations share validation, transport, and service restrictions with the CLI. */
export class BotterClient {
  constructor(options?: ClientOptions);
  readonly auth: Readonly<Auth>;
  send(input: SendInput, options?: RequestOptions): Promise<SendResult>;
  history(input: HistoryInput, options?: RequestOptions): Promise<HistoryPage>;
  search(input: SearchInput, options?: RequestOptions): Promise<SearchResult>;
  watch(input: WatchInput, options?: RequestOptions): Promise<Subscription<WatchEvent>>;
  listBots(options?: RequestOptions): Promise<Bot[]>;
  upload(input: UploadInput, options?: RequestOptions): Promise<UploadResult>;
  download(input: DownloadInput, options?: RequestOptions): Promise<DownloadResult>;
  artifacts(input: ArtifactsInput, options?: RequestOptions): Promise<ArtifactsResult>;
  capabilities(): Capabilities;
  /** Idempotent cleanup; this never logs out of the account. */
  close(): Promise<void>;
}

export function createClient(options?: ClientOptions): BotterClient;
export { createAuthManager, beginLogin, pollLogin } from './advanced.js';
