/** Native operations and transports. Prefer the managed SDK at @jethros-projects/botter. */
import type {
  AuthManager, AuthSession, AuthStatus, ClientOptions, JsonObject, JsonValue, NativeMessage,
  NativeBot, RawClient, RawRequestOptions, RequestOptions, SendResult, TranscriptCursor, WatchEvent,
} from './index.js';

export type { AuthManager, AuthSession, AuthStatus, JsonObject, JsonValue, NativeBot, RawClient, RawRequestOptions } from './index.js';
export type BotQuery = string | NativeBot;
export type NativeSendResult = Omit<SendResult, 'botId'> & { agentId: string };
export type NativeClientOptions = Pick<ClientOptions, 'tokenProvider' | 'authManager' | 'fetchImpl' | 'http2Connect' | 'version'>;

export interface NativeErrorDetails { status?: number; code?: string; requestId?: string; details?: unknown }
export class ApiError extends Error {
  constructor(message: string, options?: NativeErrorDetails);
  status?: number;
  code?: string;
  requestId?: string;
  details?: unknown;
}

/** Raw transport: no managed lifecycle or facade error normalization. */
export class GrokBotClient implements RawClient {
  constructor(options?: NativeClientOptions);
  tokenProvider?: (options?: RequestOptions) => string | Promise<string>;
  authManager: AuthManager | null;
  fetch: typeof globalThis.fetch;
  http2Connect: typeof import('node:http2').connect;
  version: string;
  baseUrl: string;
  authSession(options?: RequestOptions): Promise<AuthSession>;
  token(options?: RequestOptions): Promise<string>;
  accountFingerprint(options?: RequestOptions): Promise<string>;
  headers(contentType: string, options?: RequestOptions): Promise<Record<string, string>>;
  rpc(method: string, body?: JsonObject, options?: RawRequestOptions): Promise<JsonObject>;
  stream(method: string, body: JsonObject, options?: RawRequestOptions): AsyncGenerator<JsonObject>;
  duplex(method: string, messages: AsyncIterable<JsonObject> | Iterable<JsonObject>,
    options?: RawRequestOptions & { transport?: 'http2' | 'fetch' }): AsyncGenerator<JsonObject>;
  listBots(options?: RequestOptions): Promise<NativeBot[]>;
  resolveBot(query: BotQuery, options?: RequestOptions): Promise<NativeBot>;
  throwResponse(response: Response, result: unknown, secrets?: string[]): never;
}
/** Legacy createClient returns the raw transport. Root createClient returns BotterClient. */
export function createClient(options?: NativeClientOptions): GrokBotClient;
export function sessionFor(bot: Pick<NativeBot, 'viewerSessionId'>, override?: string): string;
export function localCredentials(): string;
export function installedVersion(): string;
export function encodeConnectFrame(value: JsonValue, options?: { maxFrameBytes?: number }): Uint8Array;
export function decodeConnectFrames(chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  options?: { encoding?: string | null; maxFrameBytes?: number; requireEndStream?: boolean;
    signal?: AbortSignal; requestId?: string | null; secrets?: string[] }): AsyncGenerator<JsonObject>;

export interface StoredSession extends AuthSession { refreshToken: string }
export interface CredentialStore {
  kind?: string;
  read(options?: { signal?: AbortSignal }): Promise<StoredSession | null>;
  write(session: StoredSession, options?: { signal?: AbortSignal }): Promise<void>;
  clear(options?: { signal?: AbortSignal }): Promise<void>;
  withLock?<T>(operation: () => Promise<T>, options?: { signal?: AbortSignal }): Promise<T>;
}
export interface ManagedAuth extends AuthManager {
  readonly store: CredentialStore;
  save(session: StoredSession, options?: { signal?: AbortSignal }): Promise<void>;
  status(options?: { signal?: AbortSignal }): Promise<AuthStatus>;
  logout(options?: RequestOptions): Promise<void>;
}
export interface LoginFlow { uuid: string; verifier: string; loginUrl: string }
export function tokenExpiry(token: string): number | null;
/** Keep verifier in the host process; show only loginUrl to the user. */
export function beginLogin(): LoginFlow;
export function pollLogin(flow: LoginFlow,
  options?: RequestOptions & { fetchImpl?: typeof globalThis.fetch; pollMs?: number }): Promise<StoredSession>;
export function createFileCredentialStore(filename: string): CredentialStore;
export function createKeychainCredentialStore(options?: { service?: string; spawnImpl?: typeof import('node:child_process').spawn }): CredentialStore;
export function defaultCredentialStore(): CredentialStore;
export function createAuthManager(options?: { store?: CredentialStore; fetchImpl?: typeof globalThis.fetch;
  now?: () => number; fallback?: (options?: { signal?: AbortSignal }) => string | Promise<string> }): ManagedAuth;
export function defaultAuthManager(options?: { fallback?: (options?: { signal?: AbortSignal }) => string | Promise<string> }): ManagedAuth;

export interface HistoryOptions {
  sessionId?: string;
  limit?: number;
  beforeSeq?: string | number;
  generation?: number;
  unreadBoundaryMs?: string | number;
  signal?: AbortSignal;
}
export interface NativeHistoryPage {
  bot?: string;
  agentId: string;
  sessionId: string;
  generation: number;
  nextBeforeSeq: string | null;
  entries: NativeMessage[];
}
export interface ScanOptions extends Omit<HistoryOptions, 'limit'> { maxPages?: number; pageSize?: number }
export interface HistoryScan extends Omit<NativeHistoryPage, 'generation'> {
  generation: number | undefined;
  pages: number;
  complete: boolean;
}
export interface ThreadSelection { found: boolean; rootEntryId?: string; entries: NativeMessage[] }
export interface NativeAttachment { path: string; name: string }
export interface SendOptions {
  sessionId?: string;
  messageId?: string;
  replyToId?: string;
  isFork?: boolean;
  richText?: JsonValue;
  attachments?: NativeAttachment[];
  taskId?: string;
  signal?: AbortSignal;
  /** Synchronous observation before status lookup; delivery is not task completion. */
  onDelivery?: (receipt: Pick<NativeSendResult, 'bot' | 'agentId' | 'sessionId' | 'messageId' | 'delivery'>) => void;
}
export interface WatchResume { version: 1; account: string; cursors: TranscriptCursor[] }
export interface WatchOptions {
  sessionId?: string;
  fromStart?: boolean;
  resume?: WatchResume;
  signal?: AbortSignal;
  reconnect?: boolean;
  onCursor?: (cursor: WatchResume) => void | Promise<void>;
  initialBackoffMs?: number;
  includeUnlistedAgents?: boolean;
  inlineBodyMaxBytes?: number;
}
/** Native events retain agentId; the root SDK additionally supplies botId. */
type NativeEvent<Event> = Event extends { type: 'entry' }
  ? Omit<Event, 'botId' | 'message'> & { agentId: string }
  : Event extends { botId: string }
    ? Omit<Event, 'botId'> & { agentId: string }
    : Event extends { type: 'rosterChanged' }
      ? Omit<Event, 'botId'> & { agentId?: string }
      : Event;
export type NativeWatchEvent = NativeEvent<WatchEvent>;
export function entryText(entry: JsonObject | null | undefined): string | null;
export function decodeEntry(row: JsonObject): NativeMessage;
export function listThreads(client: RawClient, bot: BotQuery): Promise<{
  bot?: string; agentId: string; defaultSessionId: string; sessions: JsonValue[];
}>;
export function history(client: RawClient, bot: BotQuery, options?: HistoryOptions): Promise<NativeHistoryPage>;
export function scanHistory(client: RawClient, bot: BotQuery, options?: ScanOptions): Promise<HistoryScan>;
export function selectThread(entries: NativeMessage[], rootId: string): ThreadSelection;
export function readThread(client: RawClient, bot: BotQuery, rootId: string,
  options?: ScanOptions & { gatewayClient?: GatewayClient }): Promise<HistoryScan & ThreadSelection & {
    rootId: string; note: string;
  } | { bot?: string; agentId: string; rootId: string; source: 'gateway'; thread: JsonValue }>;
export function conversationOutline(client: RawClient, bot: BotQuery,
  options?: { gatewayClient?: GatewayClient; signal?: AbortSignal }): Promise<JsonValue>;
export function searchHistory(client: RawClient, bot: BotQuery, query: string,
  options?: ScanOptions & { since?: string | number; until?: string | number; limit?: number }): Promise<HistoryScan & {
    query: string; totalMatchesInScan: number; matchesTruncated: boolean;
  }>;
export function sendMessage(client: RawClient, bot: BotQuery, text: string, options?: SendOptions): Promise<NativeSendResult>;
export function waitForReply(client: RawClient, receipt: NativeSendResult,
  options?: RequestOptions & { pollMs?: number; maxPages?: number }): Promise<NativeSendResult & {
    replies: NativeMessage[]; replyPending: boolean;
  }>;
export function readTranscriptUpdates(client: RawClient, bot: BotQuery,
  options: RequestOptions & { generation: number; afterUpdatedSeq?: string; sessionId?: string; maxEvents?: number }): Promise<{
    events: NativeWatchEvent[]; cursor: { generation: number; afterUpdatedSeq: string };
    truncated: boolean; resyncRequired: boolean;
  }>;
export function watchBots(client: RawClient, queries: BotQuery[], options?: WatchOptions): AsyncGenerator<NativeWatchEvent>;

export interface AttachmentOptions extends RequestOptions {
  sessionId?: string;
  fetchImpl?: typeof globalThis.fetch;
  maxBytes?: number;
  gatewayClient?: GatewayClient;
  allowedModes?: ('USE_BOX' | 'SINGLE_PUT' | 'MULTIPART')[];
  allowedReadOutcomes?: ('STORE' | 'NOT_IN_STORE' | 'NO_STORAGE')[];
}
export interface NativeUploadResult {
  bot?: string; agentId: string; sessionId: string; kind: 'store' | 'box';
  mode: 'single-put' | 'multipart' | 'gateway-single' | 'gateway-chunks'; path: string; alias?: string;
  fileName: string; sizeBytes: number; contentType: string; sha256: string;
  [key: string]: unknown;
}
export function uploadAttachment(client: RawClient, bot: BotQuery, path: string,
  options?: AttachmentOptions & { mimeType?: string }): Promise<NativeUploadResult>;
export function downloadAttachment(client: RawClient, bot: BotQuery, attachmentPath: string, destination: string,
  options?: AttachmentOptions & { overwrite?: boolean }): Promise<{
    bot?: string; agentId: string; sessionId: string; remotePath: string; destination: string;
    sizeBytes: number; contentType: string; via: 'store' | 'server-chunks'; sha256: string;
  }>;
export function listArtifacts(client: RawClient, bot: BotQuery,
  options?: AttachmentOptions & { maxPages?: number; pageToken?: string }): Promise<JsonObject>;
export function listArtifactReferences(client: RawClient, bot: BotQuery, options?: ScanOptions): Promise<JsonObject>;

export interface GatewayDescriptor { baseUrl: string; token: string; headers?: Record<string, string> }
export interface GatewayClient {
  readonly baseUrl: string;
  rpcGateway(method: string, args?: JsonObject, options?: RequestOptions): Promise<JsonValue>;
}
export interface GatewayMethodSchema {
  readonly name: string;
  readonly declaration: string;
  readonly offset: number;
  readonly source: string;
  readonly argumentValidation: 'plain-json-object';
  readonly typedArgumentValidation: false;
}
export const gatewayMethodSchemas: readonly GatewayMethodSchema[];
export const gatewayMethods: readonly string[];
export function getGatewayMethodSchema(method: string): GatewayMethodSchema;
export function validateGatewayArguments(args: JsonObject): string;
export function createGatewayClient(options: GatewayDescriptor & {
  fetchImpl?: typeof globalThis.fetch; timeoutMs?: number;
}): GatewayClient;
export const gatewayCapabilities: Readonly<{
  implemented: readonly string[]; methodCount: number; argumentValidation: 'plain-json-object';
  typedArgumentValidation: false; requiresExistingConnection: true; autoStartsComputer: false;
  liveVerified: false; liveVerifiedMethods: readonly string[]; note: string;
}>;
export function resolveGatewayDescriptor(client: RawClient,
  options?: RequestOptions & { wake?: boolean }): Promise<GatewayDescriptor>;
export function connectGateway(client: RawClient,
  options?: RequestOptions & { wake?: boolean }): Promise<GatewayClient>;
export function gatewayStatus(client: RawClient,
  options?: RequestOptions & { wake?: boolean; fetchImpl?: typeof globalThis.fetch }): Promise<{
    connected: boolean; status: number; host: string; networkRoutingHeader: boolean;
  }>;

export interface ApiMethod {
  name: string; jsName: string; service: string; serviceName: string;
  path: string; kind: number; streaming: string; inputType: string; outputType: string;
  [key: string]: unknown;
}
export class ApiSchemaError extends TypeError { constructor(path: string, detail: string); path: string }
export function getSchema(): JsonObject;
export function listApiMethods(options?: { service?: string; search?: string }): ApiMethod[];
export function resolveApiMethod(name: string, options?: { service?: string }): ApiMethod;
export function validateApiRequest(method: string | ApiMethod, input?: JsonObject): JsonObject;

export interface ToolOptions extends RequestOptions {
  agent?: BotQuery; agentId?: string; mcpConfigJson?: string;
  grokBotPluginScope?: { agentId: string; sessionKind: string };
}
export function listTools(client: RawClient, options?: ToolOptions & {
  server?: string; serverIdentifiers?: string[];
}): Promise<JsonObject>;
export function callTool(client: RawClient, server: string, tool: string, args: JsonObject,
  options?: ToolOptions & { toolCallId?: string; turnId?: string; modelName?: string;
    eventSequence?: string | number; mcpAnalyticsReportedByCaller?: boolean }): Promise<JsonObject>;
export function readToolResource(client: RawClient, server: string, uri: string, options?: ToolOptions): Promise<JsonObject>;

export function isRoom(bot: NativeBot): boolean;
export function sendBotMessage(client: RawClient, fromBot: BotQuery, toBot: BotQuery, text: string,
  options?: RequestOptions & { messageId?: string; sentAtMs?: string | number; replyToId?: string }): Promise<JsonObject>;
export function listRooms(client: RawClient): Promise<NativeBot[]>;
export function createRoom(client: RawClient, options: RequestOptions & {
  name: string; description?: string; agentId?: string; clientNonce?: string;
  members?: BotQuery[]; memberAgentIds?: BotQuery[]; humanMemberUserIds?: (number | string)[];
}): Promise<NativeBot>;
export function setRoomMembers(client: RawClient, room: BotQuery, members: BotQuery[], options?: RequestOptions): Promise<NativeBot>;

export interface RoutineSpec { name: string; prompt: string; trigger: JsonObject; isEnabled?: boolean }
export interface Routine {
  id: string; name: string; prompt: string; trigger: JsonObject; isEnabled: boolean;
  agentId: string; botName: string; serverAutomationId?: string; createdAt: number;
  nextRunAt?: number; [key: string]: unknown;
}
export interface RoutineUnavailable { agentId: string; botName: string; unavailable: true }
export interface RoutineOptions extends RequestOptions {
  timeZone?: string; gatewayClient?: GatewayClient; sessionId?: string;
}
export function listRoutines(client: RawClient, options?: RoutineOptions & { bot?: BotQuery }): Promise<(Routine | RoutineUnavailable)[]>;
export function setRoutineEnabled(client: RawClient, bot: BotQuery, id: string, enabled: boolean, options?: RoutineOptions): Promise<Routine[]>;
/** Provisions a new secret. This is an explicit mutation, never a listing operation. */
export function getWebhookCredential(client: RawClient, bot: BotQuery, id: string,
  options?: RoutineOptions & { backendUrl?: string; provisionAttempts?: number; provisionPollMs?: number }): Promise<{
    agentId: string; automationId: string; serverAutomationId?: string; url: string; key: string; source?: 'gateway';
  }>;
export function deleteRoutine(client: RawClient, bot: BotQuery, id: string, options?: RoutineOptions): Promise<Routine[]>;
export function fireWebhook(options: RequestOptions & {
  url: string; key: string; payload?: JsonValue; fetchImpl?: typeof globalThis.fetch;
}): Promise<{ status: number; result: JsonValue }>;
export function validateRoutineSpec(spec: RoutineSpec): RoutineSpec;
export function createRoutine(client: RawClient, bot: BotQuery, spec: RoutineSpec, options?: RoutineOptions): Promise<Routine[]>;
export function requestRoutineCreation(client: RawClient, bot: BotQuery, spec: RoutineSpec,
  options?: RoutineOptions & { pollMs?: number; messageId?: string }): Promise<{
    source: 'bot'; routine: Routine; receipt: NativeSendResult;
  }>;
export function updateRoutine(client: RawClient, bot: BotQuery, id: string, spec: RoutineSpec, options?: RoutineOptions): Promise<Routine[]>;
export function runRoutineNow(client: RawClient, bot: BotQuery, id: string, options?: RoutineOptions): Promise<JsonValue>;
export const routineCapabilities: Readonly<{
  list: true; setEnabled: true; delete: true; provisionWebhookCredential: true; fireWebhook: true;
  create: true; requestServerCreation: true; update: true; runNow: true;
  gatewayRequired: string[]; gatewayLiveVerified: false; limitation: string;
}>;

export function stopRun(client: RawClient, bot: BotQuery,
  options?: RequestOptions & { reason?: string; sessionId?: string }): Promise<JsonObject>;
export function getSendStatus(client: RawClient, bot: BotQuery, messageId: string,
  options?: RequestOptions & { sessionId?: string }): Promise<JsonObject>;
export function getBotStatuses(client: RawClient, bot?: BotQuery, options?: RequestOptions): Promise<JsonObject>;
export function listBotTasks(client: RawClient, bot: BotQuery,
  options?: RequestOptions & { includeRecentlyDone?: boolean; sessionId?: string }): Promise<JsonObject>;
export function listBotTodos(client: RawClient, bot: BotQuery, options?: RequestOptions): Promise<JsonObject>;
export function listBotSubagents(client: RawClient, bot: BotQuery, options?: RequestOptions): Promise<JsonObject>;
export function markTaskDone(client: RawClient, bot: BotQuery, taskId: string, options?: RequestOptions): Promise<JsonObject>;
export function markTaskRead(client: RawClient, bot: BotQuery, taskId: string, entryId: string, options?: RequestOptions): Promise<JsonObject>;
export function setTaskPinned(client: RawClient, bot: BotQuery, taskId: string, pinned: boolean, options?: RequestOptions): Promise<JsonObject>;
export function dismissTask(client: RawClient, bot: BotQuery, taskId: string,
  options?: RequestOptions & { sessionId?: string }): Promise<JsonObject>;
export function markTasksSeen(client: RawClient, bot: BotQuery, taskIds: string[],
  options?: RequestOptions & { sessionId?: string }): Promise<JsonObject>;
export function setBotClientState(client: RawClient, bot: BotQuery, state: JsonObject, options?: RequestOptions): Promise<JsonObject>;
export function createBot(client: RawClient, spec: JsonObject & { name: string }, options?: RequestOptions): Promise<JsonObject>;
export function updateBot(client: RawClient, bot: BotQuery, patch: JsonObject, options?: RequestOptions): Promise<JsonObject>;
export function deleteBot(client: RawClient, bot: BotQuery, options?: RequestOptions): Promise<JsonObject>;
export function setMainBot(client: RawClient, bot: BotQuery, options?: RequestOptions): Promise<JsonObject>;
export function getRuntimeSettings(client: RawClient, options?: RequestOptions): Promise<JsonObject>;
export function updateRuntimeSettings(client: RawClient, patch: JsonObject, options?: RequestOptions): Promise<JsonObject>;
export function listBotSkills(client: RawClient, bot: BotQuery, options?: RequestOptions): Promise<JsonObject>;
export function writeBotSkill(client: RawClient, bot: BotQuery, skill: JsonObject & { name: string; content: string },
  options?: RequestOptions & { update?: boolean }): Promise<JsonObject>;
export function removeBotSkill(client: RawClient, bot: BotQuery, name: string, options?: RequestOptions): Promise<JsonObject>;
export function changeRoomPeople(client: RawClient, room: BotQuery, userIds: number[],
  options?: RequestOptions & { remove?: boolean }): Promise<JsonObject>;
