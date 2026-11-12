// Claude 호출 계층. 공식 SDK(@anthropic-ai/sdk)를 늦게 불러와서, 패키지가 없어도 서버는 뜬다.
// 기록에는 용도·모델·오류 종류·걸린 시간·토큰 수만 남긴다. 요청 본문이나 사용자 글은 남기지 않는다.
import { LlmError } from './llm-error.js'

// 오류 클래스는 llm-error.js에 두고, 예전처럼 여기서도 꺼내 쓸 수 있게 다시 내보낸다
export { LlmError }

/** 거절을 다른 모델이 이어받게 하는 서버 측 대체(fallbacks: "default")용 베타 헤더 */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01'
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const DEFAULT_MAX_TOKENS = 16000
const MAX_TOKENS_LIMIT = 32000
const MAX_PROMPT_CHARS = 200_000
const PURPOSE_SHAPE = /^[a-z][a-z_-]{0,23}$/

/** SDK의 오류 클래스 → 오류 종류. 하위 클래스가 먼저 걸리도록 구체적인 것부터 둔다. */
const SDK_ERROR_KINDS = [
  ['AuthenticationError', 'auth'],
  ['PermissionDeniedError', 'auth'],
  ['RateLimitError', 'rate_limit'],
  ['BadRequestError', 'bad_request'],
  ['APIConnectionError', 'network'],
  ['APIError', 'api'],
]

/** 응답을 끝까지 받았더라도 내용을 쓸 수 없는 종료 사유 → 오류 종류 */
const STOP_REASON_KINDS = new Map([
  ['refusal', 'refusal'],
  ['max_tokens', 'max_tokens'],
])

function kindOf(err, sdk) {
  if (err instanceof LlmError) return err.kind
  const match = SDK_ERROR_KINDS.find(([name]) => typeof sdk?.[name] === 'function' && err instanceof sdk[name])
  return match ? match[1] : 'api'
}

const localDay = (ms) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

const isPrompt = (value) => typeof value === 'string' && value.length > 0 && value.length <= MAX_PROMPT_CHARS

/** 대화 턴으로 넘어온 입력은 사용자 턴의 글만 받는다 (어시스턴트 턴을 끼워 답을 미리 채우는 일은 하지 않는다). */
function userTurns(user, messages) {
  const turns = Array.isArray(messages) ? messages : [{ role: 'user', content: user }]
  const valid = turns.length > 0 && turns.every((turn) => turn?.role === 'user' && isPrompt(turn.content))
  return valid ? turns.map(({ content }) => ({ role: 'user', content })) : null
}

function readJson(response) {
  // 내용을 읽기 전에 종료 사유부터 본다. 거절이나 잘린 응답은 형식을 지키지 않을 수 있다.
  const stopped = STOP_REASON_KINDS.get(response?.stop_reason)
  if (stopped) throw new LlmError(stopped)
  const blocks = Array.isArray(response?.content) ? response.content : []
  const joined = blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
  try {
    const parsed = JSON.parse(joined)
    if (parsed !== null && typeof parsed === 'object') return parsed
  } catch {
    // 아래에서 같은 오류로 알린다
  }
  throw new LlmError('bad_json')
}

const USAGE_FIELDS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']
const tokens = (usage) => USAGE_FIELDS.map((field) => `${field}=${Number(usage?.[field]) || 0}`).join(' ')

/**
 * @param {{ config: { llm: object }, log?: { info: Function, warn: Function }, clientFactory?: ((sdk: unknown) => object)|null, now?: () => number }} deps
 *   clientFactory는 테스트에서 가짜 클라이언트를 넣을 때 쓴다. 불러온 SDK(없으면 null)를 인자로 받는다.
 */
export function createLlm({ config, log = console, clientFactory = null, now = () => Date.now() } = {}) {
  const settings = config?.llm ?? {}
  const enabled = settings.enabled === true
  const dailyCap = Number.isInteger(settings.dailyCallCap) && settings.dailyCallCap >= 0 ? settings.dailyCallCap : 0
  const state = { sdk: null, client: null, loading: enabled, authFailed: false, day: '', calls: 0 }

  async function load() {
    try {
      state.sdk = (await import('@anthropic-ai/sdk')).default
    } catch {
      state.sdk = null
    }
    try {
      // 인자 없이 만들면 SDK가 ANTHROPIC_API_KEY · ANTHROPIC_AUTH_TOKEN · 저장된 프로필에서 자격 증명을 찾는다
      state.client = clientFactory ? clientFactory(state.sdk) : state.sdk ? new state.sdk() : null
    } catch {
      state.client = null
    }
    state.loading = false
  }
  const ready = enabled ? load() : Promise.resolve()

  function callsToday() {
    const today = localDay(now())
    if (state.day !== today) {
      state.day = today
      state.calls = 0
    }
    return state.calls
  }

  /** 지금 호출할 수 없는 까닭. 호출할 수 있으면 null. */
  function blocker() {
    if (!enabled) return { kind: 'disabled', reason: '사용 안 함' }
    if (state.loading) return { kind: 'unavailable', reason: '준비 중' }
    if (!state.client) return { kind: 'unavailable', reason: 'AI 엔진을 불러오지 못함' }
    if (state.authFailed) return { kind: 'auth', reason: '인증 실패' }
    if (callsToday() >= dailyCap) return { kind: 'daily_cap', reason: '일일 호출 한도 도달' }
    return null
  }

  function requestBody({ system, user, messages, schema, effort, model, maxTokens }) {
    const turns = userTurns(user, messages)
    if (!isPrompt(system) || !turns || schema === null || typeof schema !== 'object' || !isPrompt(model)) throw new LlmError('bad_request')
    return {
      model,
      max_tokens: Number.isInteger(maxTokens) && maxTokens > 0 ? Math.min(maxTokens, MAX_TOKENS_LIMIT) : DEFAULT_MAX_TOKENS,
      thinking: { type: 'adaptive' },
      output_config: { effort: EFFORTS.includes(effort) ? effort : 'medium', format: { type: 'json_schema', schema } },
      // 시스템 프롬프트는 요청마다 같으므로 캐시 지점을 둔다
      system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages: turns,
    }
  }

  function send(body) {
    const options = { timeout: settings.timeoutMs, maxRetries: 1 }
    if (!settings.fallbacks) return state.client.messages.create(body, options)
    return state.client.beta.messages.create({ ...body, betas: [FALLBACK_BETA], fallbacks: 'default' }, options)
  }

  /**
   * JSON 스키마에 맞는 응답을 받아 객체로 돌려준다. 실패하면 LlmError를 던진다.
   * @param {{ system: string, user?: string, messages?: {role:'user', content:string}[], schema: object,
   *           effort?: string, model?: string, maxTokens?: number, purpose?: string }} request
   *   user 대신 사용자 턴 목록(messages)을 줄 수도 있다. purpose는 기록에 남길 용도 이름이다.
   */
  async function generateJson(request) {
    const { effort = settings.effort, model = settings.model, maxTokens = DEFAULT_MAX_TOKENS, purpose = 'generate', ...prompt } = request ?? {}
    await ready
    const blocked = blocker()
    if (blocked) throw new LlmError(blocked.kind)
    const body = requestBody({ ...prompt, effort, model, maxTokens })
    const label = `${PURPOSE_SHAPE.test(purpose) ? purpose : 'other'} ${body.model}`
    const started = now()
    state.calls++
    try {
      const response = await send(body)
      const parsed = readJson(response)
      log.info(`[llm] ${label} 완료 ${now() - started}ms ${tokens(response.usage)}`)
      return parsed
    } catch (err) {
      const kind = kindOf(err, state.sdk)
      // 인증이 틀리면 다시 불러도 같은 결과이므로, 서버를 다시 띄울 때까지 쓰지 않는다
      if (kind === 'auth') state.authFailed = true
      log.warn(`[llm] ${label} 실패(${kind}) ${now() - started}ms`)
      throw err instanceof LlmError ? err : new LlmError(kind)
    }
  }

  /** 상태 요약 — 비밀값은 담지 않는다. reason은 쓸 수 없는 까닭(쓸 수 있으면 null). */
  function status() {
    const blocked = blocker()
    return { enabled, available: blocked === null, model: settings.model ?? null, reason: blocked?.reason ?? null, callsToday: callsToday(), dailyCap }
  }

  return {
    /** 지금 LLM을 부를 수 있는지 */
    available: () => blocker() === null,
    status,
    generateJson,
    /** SDK를 다 불러올 때까지 기다린다 (서버 시작 직후나 테스트에서) */
    ready: () => ready,
  }
}
