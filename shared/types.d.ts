/** How the global outbound proxy URL is interpreted. Per-key proxies always
 * use the traditional forward-proxy transport. */
export type ProxyMode = 'forward' | 'fetch-relay';
/** A model declared beside a custom endpoint in an import file (#382). A
 *  capability flag is present only when the paste declared it via a trailing
 *  -TOOLS / -VISION suffix. */
export interface ImportModelEntry {
    id: string;
    supportsTools?: boolean;
    supportsVision?: boolean;
}
export interface PreviewKey {
    keyName: string;
    keyValue: string;
    detectedPlatform: string | null;
    prefix: string;
    /** Custom endpoints only: the upstream URL the export file carried (#687). */
    baseUrl?: string;
    /** Custom endpoints only: models to register alongside the key (#382). */
    models?: ImportModelEntry[];
    isDuplicate?: boolean;
}
export interface ImportKey {
    keyName: string;
    keyValue: string;
    platform: string;
    baseUrl?: string;
    models?: ImportModelEntry[];
}
export interface PreviewResponse {
    keys: PreviewKey[];
    total: number;
    skipped: string[];
    duplicates: number;
}
export interface ImportSelectedRequest {
    keys: ImportKey[];
}
export interface ImportSelectedResponse {
    imported: number;
    skipped: string[];
    errors: Array<{
        key: string;
        error: string;
    }>;
    total: number;
    /** Models registered for imported custom endpoints (#382). */
    modelsRegistered: number;
}
export type Platform = 'google' | 'groq' | 'cerebras' | 'sail' | 'aclide' | 'speka' | 'kenari' | 'kiosapi' | 'beatapi' | 'apinex' | 'onomeo' | 'iteracompute' | 'typhoon' | 'plugsky' | 'inferbase' | 'simplellm' | 'llmtr' | 'gizmo' | 'blockrun' | 'moondream' | 'jamai' | 'nabh' | 'zro' | 'novai' | 'varosity' | 'rime' | 'freetts' | 'freeinference' | 'freemodel' | 'electronhub' | 'experiential' | 'router9' | 'septor' | 'clod' | 'speechify' | 'freeai' | 'blaze' | 'lucidity' | 'airforce' | 'dreamprompting' | 'waterfall' | 'logfare' | 'bai' | 'anyapi' | 'powertokens' | 'radeon' | 'nvidia' | 'mistral' | 'sambanova' | 'openrouter' | 'cohere' | 'tavily' | 'exa' | 'firecrawl' | 'linkup' | 'parallel' | 'serpsearch' | 'keenable' | 'halx' | 'aisense' | 'brave' | 'outcrawl' | 'cloudflare' | 'zhipu' | 'ollama' | 'kilo' | 'pollinations' | 'llm7' | 'huggingface' | 'opencode' | 'ovh' | 'agnes' | 'reka' | 'siliconflow' | 'routeway' | 'bazaarlink' | 'ainative' | 'aion' | 'requesty' | 'navy' | 'nara' | 'sealion' | 'orcarouter' | 'unorouter' | 'xkiro' | 'modelscope' | 'qianfan' | 'volcengine' | 'longcat' | 'xfyun' | 'aihorde' | 'custom';
/** Platforms whose keys serve web search (POST /v1/search and the agents'
 *  web_search tools), never chat. Search engine rows arrive through the
 *  catalog's `searchEngines` registry. The server keeps its own runtime copy in
 *  server/src/lib/search-platforms.ts (shared is type-only on the server). */
export declare const SEARCH_PLATFORMS: readonly ["tavily", "exa", "firecrawl", "linkup", "parallel", "serpsearch", "keenable", "brave", "outcrawl"];
export type SearchPlatform = (typeof SEARCH_PLATFORMS)[number];
export declare function isSearchPlatform(platform: string): platform is SearchPlatform;
export interface Model {
    id: number;
    platform: Platform;
    modelId: string;
    displayName: string;
    intelligenceRank: number;
    speedRank: number;
    sizeLabel: string;
    rpmLimit: number | null;
    rpdLimit: number | null;
    tpmLimit: number | null;
    tpdLimit: number | null;
    monthlyTokenBudget: string;
    contextWindow: number | null;
    enabled: boolean;
    supportsVision: boolean;
    supportsTools: boolean;
    /** 'discovered': fetched from a built-in provider's own /models because the
     *  catalog carries no models for it (#1348). */
    source?: 'catalog' | 'custom' | 'discovered';
    keyId?: number | null;
    endpointScope?: string | null;
}
export type QuirkSeverity = 'info' | 'warning' | 'blocker';
export interface Quirk {
    slug: string;
    title: string;
    body: string;
    severity: QuirkSeverity;
}
export interface QuirkTarget {
    platform: Platform | null;
    modelGlob: string | null;
}
export interface ModelListRow {
    platform: string;
    model_id: string;
    display_name: string;
    context_window: number | null;
    enabled: number;
    available: number;
}
export type KeyStatus = 'healthy' | 'rate_limited' | 'invalid' | 'error' | 'unknown';
export interface ApiKeyModel {
    id: number;
    kind: 'chat' | 'embedding' | 'image' | 'audio' | 'transcription' | 'search' | 'decision';
    modelId: string;
    displayName: string;
    family?: string | null;
}
/** An active rate-limit cooldown on one model for a key. A key can be healthy
 *  and enabled yet still skipped by the router because of these. */
export interface ApiKeyCooldown {
    modelId: string;
    /** Why this route is benched; 'checkin' means APINex daily website visit required. */
    source?: 'heuristic' | 'authoritative' | 'credit' | 'tier' | 'checkin';
    expiresAtMs: number;
    remainingMs: number;
}
/** [fork 7/10] The key's caps with live usage and the provider's last word. */
export interface KeyRateSummary {
    limits: {
        rpm: number | null;
        tpm: number | null;
        rpd: number | null;
    };
    usage: {
        minute: {
            requests: number;
            tokens: number;
        };
        day: {
            requests: number;
            tokens: number;
        };
    };
    provider: {
        requestsRemaining: number | null;
        requestsLimit: number | null;
        requestsResetMs: number | null;
        tokensRemaining: number | null;
        tokensLimit: number | null;
        tokensResetMs: number | null;
        observedAtMs: number | null;
        fresh: boolean;
    } | null;
}
/** [fork 9/10] Kind of budget backing a key's credential. */
export type KeyType = 'free' | 'credits' | 'paid';
/** [fork 9/10] Operator-facing metadata attached to a key. */
export interface KeyMetadata {
    keyId: number;
    owner: string | null;
    consoleUrl: string | null;
    note: string | null;
    tags: string[];
    keyType: KeyType;
    creditsRemaining: number | null;
    expiresAt: string | null;
    expireReminderDays: number;
}
/** [fork 8/10] The key's failure-streak penalty: where it is, and how far away
 *  the trial request is. */
export interface KeyPenaltyInfo {
    keyId: number;
    streak: number;
    step: number;
    penalizedUntilMs: number | null;
    lastFailureMs: number | null;
    lastSuccessMs: number | null;
}
/** [fork 7/10] A key-wide hold (manual or Retry-After) with its reason. */
export interface KeyCooldownInfo {
    keyId: number;
    reason: string;
    note: string | null;
    source: 'manual' | 'retry_after';
    expiresAtMs: number;
    createdAt: string;
}
/** [fork 5/10] A key whose credential works but which needs a manual step on
 *  the provider's site before it can serve. */
export interface KeyActionNeeded {
    id: number;
    reason: 'verify_phone' | 'accept_tos' | 'add_card' | 'captcha' | 'trial_expired' | 'daily_claim' | 'rotate_key' | 'other';
    url: string | null;
    note: string | null;
    /** exclude_from_rotation = the router skips this key until it is done. */
    policy: 'inform_only' | 'exclude_from_rotation';
    source: 'manual' | 'auto';
    createdAt: string;
    snoozeUntilMs: number | null;
    recurrenceKind: 'none' | 'interval' | 'daily';
    recurrenceHours: number | null;
    recurrenceHour: number | null;
    timezone: string;
}
/** [fork 4/10] One windowed cap with its current usage. */
export interface KeyCapStatus {
    id: number;
    scope: 'key' | 'account' | 'model';
    accountKey: string | null;
    modelId: string | null;
    window: 'hour' | 'day' | 'week' | 'month';
    unit: 'requests' | 'tokens';
    cap: number;
    used: number;
    softPercent: number;
    softReached: boolean;
    hardReached: boolean;
    /** Epoch ms of the next reset (sliding windows roll continuously). */
    resetAt: number;
    resetType: 'calendar' | 'sliding';
    timezone: string;
    resetHour: number;
    resetDayOfMonth: number | null;
}
export interface ApiKey {
    id: number;
    platform: Platform;
    label: string;
    maskedKey: string;
    baseUrl: string | null;
    /** Optional custom-endpoint group label (#1176); null = legacy single
     *  "Custom" group. Only set on platform='custom' rows. */
    groupLabel?: string | null;
    status: KeyStatus;
    enabled: boolean;
    /** This row is the anonymous sentinel of a key-optional platform: there is
     *  no credential to copy, scope or reveal. */
    keyless: boolean;
    /** The platform works with or without a key (Kilo, OVH, AI Horde), so a key
     *  can be added to or left off this row (#1331). */
    keyOptional?: boolean;
    /** Whether an export file would actually contain this row. The server decides
     *  it so the dialog's "will export N keys" cannot drift from the export. */
    exportable: boolean;
    createdAt: string;
    lastCheckedAt: string | null;
    /** Last time the key was proven to work — a valid probe verdict or a served
     *  live request (#1493). Unlike lastCheckedAt, a transport error does not
     *  refresh it, so "checked recently but never worked" is visible. */
    lastHealthyAt?: string | null;
    lastHealthError: string | null;
    /** Model ids this key is limited to; null = serves every model of its
     *  platform (#657). */
    modelScope?: string[] | null;
    /** Per-key monthly request cap (0 = unlimited, #1158). */
    monthlyRequestCap?: number;
    /** Per-key monthly token cap (0 = unlimited, #1158). */
    monthlyTokenCap?: number;
    /** Per-key in-flight cap ([fork 2/10]): null = inherit, 0 = unlimited. */
    maxConcurrent?: number | null;
    /** [fork 6/10] Rotation share inside the key's order group (default 1). */
    weight?: number;
    /** [fork 6/10] Rotation group (default 0). Keys of a lower group are tried
     *  first; a higher group only sees traffic when the lower ones are unusable. */
    order?: number;
    /** [fork 7/10] Per-key requests-per-minute cap (null/0 = unlimited). */
    rpm?: number | null;
    /** [fork 7/10] Per-key tokens-per-minute cap (null/0 = unlimited). */
    tpm?: number | null;
    /** [fork 7/10] Per-key requests-per-day cap (null/0 = unlimited). */
    rpd?: number | null;
    /** [fork 7/10] Live usage against the caps + the provider's last reported
     *  remaining/reset, for the "12 of 50 remaining" line on the card. */
    rate?: KeyRateSummary;
    /** [fork 7/10] Active key-wide cooldown (manual park or Retry-After 429). */
    keyCooldown?: KeyCooldownInfo | null;
    /** [fork 8/10] Failure-streak penalty state (in memory; absent = clean). */
    penalty?: KeyPenaltyInfo | null;
    /** The cap actually enforced after key → platform → global → setting. */
    effectiveMaxConcurrent?: number | null;
    /** Current UTC month's successful usage against the caps above, with the
     *  ISO time of the next monthly reset. */
    monthlyUsage?: {
        requests: number;
        tokens: number;
        resetsAt: string;
    };
    /** [fork 4/10] Account tag: every key sharing it draws from one account
     *  budget. null = this key is not part of a shared group. */
    accountKey?: string | null;
    /** [fork 4/10] Windowed caps visible on this key (its own + account-wide),
     *  with live usage and the next reset. */
    caps?: KeyCapStatus[];
    /** [fork 5/10] The provider is waiting for something a human must do (verify
     *  a phone, accept terms, claim the daily bonus). null = nothing to do, or the
     *  flag is snoozed. */
    actionNeeded?: KeyActionNeeded | null;
    /** Set when a flag exists but is snoozed until this epoch ms (so the row can
     *  say "snoozed" instead of looking clean). */
    actionNeededSnoozedUntilMs?: number | null;
    /** The per-key proxy override with its password masked (#590); '' = none. */
    maskedProxyUrl?: string;
    models?: ApiKeyModel[];
    cooldowns?: ApiKeyCooldown[];
    /** True for a built-in provider key whose platform the catalog carries no
     *  models for, so the dashboard offers Fetch models on it (#1348). */
    modelDiscovery?: boolean;
    /** False for a provider that forbids automated key checks (LLMTR, #1459):
     *  its keys turn healthy on their first served request, not on a probe. */
    autoHealthCheck?: boolean;
    /** Only sent when autoHealthCheck is false: how many of the provider's
     *  models this install can route to (0 = nothing to serve yet). */
    modelsAvailable?: number;
}
export interface ApiKeyCreate {
    platform: Platform;
    key: string;
    label?: string;
}
export interface FallbackEntry {
    modelId: number;
    platform: Platform;
    displayName: string;
    intelligenceRank: number;
    speedRank: number;
    priority: number;
    enabled: boolean;
    groupKey?: string;
    canonicalId?: string;
    groupLabel?: string;
}
export interface ModelGroupInfo {
    groupKey: string;
    canonicalId: string;
    groupLabel: string;
}
export interface UnifyOverrides {
    merges: {
        into: string;
        keys: string[];
    }[];
    splits: {
        member: string;
        groupKey?: string;
    }[];
}
export interface UnifySettings {
    enabled: boolean;
    overrides: UnifyOverrides;
}
export interface ChatToolCallFunction {
    name: string;
    arguments: string;
}
export interface ChatToolCall {
    id: string;
    type: 'function';
    function: ChatToolCallFunction;
    thought_signature?: string;
}
export interface ChatToolFunctionDefinition {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
    strict?: boolean;
}
export interface ChatToolDefinition {
    type: 'function';
    function: ChatToolFunctionDefinition;
}
export type ChatToolChoice = 'none' | 'auto' | 'required' | {
    type: 'function';
    function: {
        name: string;
    };
};
export type ChatContentBlock = string | {
    type?: string;
    text?: string;
    [key: string]: unknown;
};
export type ChatContent = string | null | ChatContentBlock[];
export interface ChatMessage {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: ChatContent;
    name?: string;
    tool_call_id?: string;
    tool_calls?: ChatToolCall[];
    reasoning_content?: string;
    partial?: boolean;
}
export interface ChatCompletionRequest {
    model?: string;
    messages: ChatMessage[];
    temperature?: number;
    max_tokens?: number;
    stream?: boolean;
    stream_options?: {
        include_usage?: boolean;
    };
    top_p?: number;
    stop?: string | string[];
    tools?: ChatToolDefinition[];
    tool_choice?: ChatToolChoice;
    parallel_tool_calls?: boolean;
}
export interface ChatCompletionChoice {
    index: number;
    message: ChatMessage;
    finish_reason: string | null;
    logprobs?: unknown;
}
export interface TokenUsage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    completion_tokens_details?: {
        reasoning_tokens?: number;
    };
    prompt_tokens_details?: {
        cached_tokens?: number;
    };
    estimated?: boolean;
}
export interface ChatCompletionResponse {
    id: string;
    object: 'chat.completion';
    created: number;
    model: string;
    choices: ChatCompletionChoice[];
    usage: TokenUsage;
    _routed_via?: {
        platform: Platform;
        model: string;
    };
    safeguard_results?: unknown;
}
export interface ChatCompletionChunk {
    id: string;
    object: 'chat.completion.chunk';
    created: number;
    model: string;
    choices: {
        index: number;
        delta: {
            role?: 'assistant';
            content?: string;
            reasoning_content?: string;
            tool_calls?: ChatToolCall[];
        };
        finish_reason: string | null;
    }[];
    usage?: TokenUsage;
    safeguard_results?: unknown;
}
export interface AnalyticsSummary {
    totalRequests: number;
    successRate: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    avgLatencyMs: number;
    estimatedCostSavings: number;
}
export interface PlatformStats {
    platform: Platform;
    requests: number;
    successRate: number;
    avgLatencyMs: number;
    totalInputTokens: number;
    totalOutputTokens: number;
}
export interface TimelinePoint {
    timestamp: string;
    requests: number;
    successCount: number;
    failureCount: number;
}
export interface RequestLog {
    id: number;
    platform: Platform;
    modelId: string;
    status: 'success' | 'error';
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
    error: string | null;
    createdAt: string;
}
export interface RateLimitStatus {
    platform: Platform;
    modelId: string;
    rpm: {
        used: number;
        limit: number | null;
    };
    rpd: {
        used: number;
        limit: number | null;
    };
    tpm: {
        used: number;
        limit: number | null;
    };
    available: boolean;
    nextResetAt: string | null;
}
export type QuotaMetric = 'requests' | 'tokens' | 'credits' | 'neurons';
export type QuotaResetStrategy = 'fixed_calendar' | 'rolling_window' | 'token_bucket' | 'provider_reported' | 'unknown';
export type QuotaObservationSource = 'header' | 'quota_api' | 'error_body' | 'local_usage' | 'documentation' | 'probe';
export interface ProviderQuotaState {
    platform: Platform;
    keyId: number;
    /** The key's operator-facing label, when the row still names a live key. */
    keyLabel?: string | null;
    quotaPoolKey: string;
    metric: QuotaMetric;
    limit: number | null;
    remaining: number | null;
    resetAt: string | null;
    resetStrategy: QuotaResetStrategy;
    source: QuotaObservationSource;
    confidence: number;
    notes: string | null;
    observedAt: string;
    updatedAt: string;
}
export interface ProviderQuotaObservation extends ProviderQuotaState {
    id: string;
    statusCode: number | null;
    retryAfterMs: number | null;
    providerAccountId: string | null;
    modelId: string | null;
    endpoint: string | null;
    rawJson: string | null;
    createdAt: string;
}
export interface QuotaOutlookPool {
    platform: Platform;
    pool: string;
    limit: number | null;
    remaining: number | null;
    remainingPct: number | null;
    observedAt: string | null;
    resetAt: string | null;
    /** Successful requests through this instance during the observation window. */
    recentRequestCount: number;
    ratePerMin: number;
    unavailableReason: 'quota_not_reported' | 'stale_observation' | 'reset_not_reported' | 'low_confidence' | null;
    estimatedExhaustionAt: string | null;
    status: 'unknown' | 'stale' | 'unavailable' | 'insufficient_data' | 'resets_first' | 'forecast' | 'exhausted';
    warning: 'low_balance' | 'exhausting_soon' | null;
}
export interface QuotaOutlookResponse {
    generatedAt: string;
    observationWindowMinutes: number;
    minimumRequests: number;
    pools: QuotaOutlookPool[];
}
export type ProviderHealthStatus = 'healthy' | 'issues' | 'rate_limited' | 'unknown' | 'unconfigured';
export interface ProviderSummary {
    platform: Platform;
    name: string;
    totalKeys: number;
    enabledKeys: number;
    healthyKeys: number;
    totalModels: number;
    activeModels: number;
    status: ProviderHealthStatus;
    isConfigured: boolean;
}
export interface GroupedProvider {
    id: string;
    platform: Platform;
    name: string;
    url?: string;
    baseUrl?: string | null;
    endpointScope?: string | null;
    keyless?: boolean;
    keys: ApiKey[];
    models: Model[];
    summary: ProviderSummary;
}
export interface CustomModelCreate {
    platform: Platform;
    modelId: string;
    displayName?: string;
    contextWindow?: number | null;
    rpmLimit?: number | null;
    rpdLimit?: number | null;
    tpmLimit?: number | null;
    tpdLimit?: number | null;
    supportsVision?: boolean;
    supportsTools?: boolean;
}
export interface ModelTestResult {
    success: boolean;
    modelId: string;
    latencyMs: number;
    error?: string;
}
//# sourceMappingURL=types.d.ts.map