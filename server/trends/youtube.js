// YouTube Data API v3 인기 차트(videos.list, chart=mostPopular) 클라이언트.
// 공식 API만 쓰고, 유행어 후보를 찾는 데 필요한 메타데이터만 받는다.

const ENDPOINT = 'https://www.googleapis.com/youtube/v3/videos'
// 정책(III.E.4.h)상 API 통계로 파생 지표를 만들 수 없으므로 statistics는 아예 요청하지 않는다.
// 채널명·설명·썸네일도 받지 않는다(데이터 최소화).
const FIELDS = 'items(id,snippet(publishedAt,title,tags,categoryId))'
const WATCH_URL = 'https://www.youtube.com/watch?v='
const PAGE_MAX = 50
// videoCategoryId를 붙이지 않는 전체 차트
const ALL_CATEGORIES = '0'

const VIDEO_ID = /^[A-Za-z0-9_-]{5,20}$/
const REASON_TOKEN = /^[A-Za-z][A-Za-z0-9_]{0,59}$/
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]+/g
const TITLE_MAX = 200
const TAG_MAX = 60
const TAGS_MAX = 40

// 오류 종류별 처리. fatal은 이번 수집 전체를 멈추고, retryable은 잠시 뒤 한 번 더 해 볼 만하다는 뜻이다.
// 400 오류와 할당량 오류는 다시 보내도 결과가 같고 할당량만 깎이므로 retryable이 아니다.
const KINDS = {
  quota: { fatal: true, retryable: false, message: 'YouTube API 하루 할당량을 모두 썼습니다. 태평양 시간 자정에 다시 채워집니다.' },
  budget: { fatal: true, retryable: false, message: '오늘 쓰기로 정한 YouTube API 예산을 모두 썼습니다. 태평양 시간 자정이 지나면 다시 수집합니다.' },
  auth: { fatal: true, retryable: false, message: 'YouTube API 키가 올바르지 않거나 이 API를 쓸 권한이 없습니다.' },
  rate: { fatal: false, retryable: true, message: 'YouTube API 요청이 잠시 제한됐습니다.' },
  server: { fatal: false, retryable: true, message: 'YouTube API 서버가 일시적으로 응답하지 못했습니다.' },
  network: { fatal: false, retryable: true, message: 'YouTube API에 연결하지 못했습니다.' },
  timeout: { fatal: false, retryable: true, message: 'YouTube API 응답이 제때 오지 않았습니다.' },
  noChart: { fatal: false, retryable: false, message: '이 분류에는 인기 차트가 없습니다.' },
  request: { fatal: false, retryable: false, message: 'YouTube API가 요청을 받아들이지 않았습니다.' },
  response: { fatal: false, retryable: false, message: 'YouTube API 응답을 읽지 못했습니다.' },
}

// 응답에 담긴 reason → 오류 종류. 여기에 없는 reason은 HTTP 상태로 가른다.
const REASON_KINDS = {
  quotaExceeded: 'quota',
  dailyLimitExceeded: 'quota',
  rateLimitExceeded: 'rate',
  userRateLimitExceeded: 'rate',
  servingLimitExceeded: 'rate',
  concurrentLimitExceeded: 'rate',
  limitExceeded: 'rate',
  API_KEY_INVALID: 'auth',
  keyInvalid: 'auth',
  keyExpired: 'auth',
  accessNotConfigured: 'auth',
  videoChartNotFound: 'noChart',
}

// 알려진 reason이 없을 때 HTTP 상태로 정하는 기본값. 그 밖의 403은 키 제한·권한 문제로 본다.
const STATUS_RULES = {
  400: { reason: 'badRequest', kind: 'request' },
  401: { reason: 'unauthorized', kind: 'auth' },
  403: { reason: 'forbidden', kind: 'auth' },
  404: { reason: 'notFound', kind: 'request' },
  429: { reason: 'rateLimitExceeded', kind: 'rate' },
}
const SERVER_RULE = { reason: 'backendError', kind: 'server' }
const UNEXPECTED_RULE = { reason: 'bad_response', kind: 'response' }

function statusRule(status) {
  if (status >= 500) return SERVER_RULE
  if (status >= 400) return STATUS_RULES[status] ?? STATUS_RULES[400]
  // 성공도 오류도 아닌 응답(리다이렉트, 상태 없는 응답)
  return UNEXPECTED_RULE
}

export class YouTubeError extends Error {
  /**
   * @param {string} reason 문서에 나온 reason 문자열, 또는 'network' | 'timeout' | 'bad_response' | 'budgetExceeded'
   * @param {{ message: string, status?: number, retryable?: boolean, fatal?: boolean }} info
   */
  constructor(reason, { message, status = 0, retryable = false, fatal = false }) {
    super(message)
    this.name = 'YouTubeError'
    this.reason = reason
    this.status = status
    this.retryable = retryable
    this.fatal = fatal
  }
}

/** 오류 문구에는 우리가 정한 설명과 reason만 싣는다. 키, 요청 주소, API가 보낸 문장은 넣지 않는다. */
function failure(reason, kind, status = 0) {
  const { message, retryable, fatal } = KINDS[kind]
  return new YouTubeError(reason, { message: `${message} (${reason})`, status, retryable, fatal })
}

const isReasonToken = (value) => typeof value === 'string' && REASON_TOKEN.test(value)
const isTimeout = (err) => err?.name === 'TimeoutError' || err?.name === 'AbortError'

/** 인프라 오류(키 누락·무효 등)에만 붙어 오는 google.rpc.ErrorInfo의 reason */
function errorInfoReason(error) {
  const details = Array.isArray(error?.details) ? error.details : []
  return details.find((detail) => String(detail?.['@type'] ?? '').endsWith('ErrorInfo'))?.reason
}

/**
 * 오류 응답을 분류한다. 봉투가 두 가지(errors[]만 있는 옛 형식, status·details가 붙는 형식)라서
 * errors[0].reason → ErrorInfo reason → HTTP 상태 순으로 본다.
 */
function classify(status, body) {
  const error = body?.error
  const reasons = [error?.errors?.[0]?.reason, errorInfoReason(error)].filter(isReasonToken)
  const known = reasons.find((reason) => Object.hasOwn(REASON_KINDS, reason))
  if (known) return { reason: known, kind: REASON_KINDS[known] }
  const rule = statusRule(status)
  return { reason: reasons[0] ?? rule.reason, kind: rule.kind }
}

function cleanText(value, max) {
  if (typeof value !== 'string') return ''
  return Array.from(value.replace(CONTROL_CHARS, ' ').trim()).slice(0, max).join('')
}

/** 응답 항목에서 필요한 값만 옮긴다. 형식이 어긋난 항목은 버린다. rank는 응답 안에서의 순서(차트 순서)다. */
function toVideoMeta(item, index) {
  const id = typeof item?.id === 'string' ? item.id : ''
  const title = cleanText(item?.snippet?.title, TITLE_MAX)
  if (!VIDEO_ID.test(id) || !title) return null
  const { tags, categoryId, publishedAt } = item.snippet
  const published = typeof publishedAt === 'string' ? Date.parse(publishedAt) : NaN
  return {
    id,
    title,
    // 문서에 tags가 항상 온다는 말이 없으므로, 빠져 온 경우에도 대비한다
    tags: (Array.isArray(tags) ? tags : []).map((tag) => cleanText(tag, TAG_MAX)).filter(Boolean).slice(0, TAGS_MAX),
    categoryId: /^\d{1,4}$/.test(String(categoryId ?? '')) ? String(categoryId) : '',
    publishedAt: Number.isNaN(published) ? null : new Date(published).toISOString(),
    rank: index + 1,
    url: WATCH_URL + id,
  }
}

function readChartOptions({ regionCode = 'KR', categoryId = '0', maxResults = PAGE_MAX }) {
  const region = String(regionCode ?? '').trim().toUpperCase()
  if (!/^[A-Z]{2}$/.test(region)) throw new TypeError('regionCode는 두 글자 국가 코드여야 합니다.')
  const category = String(categoryId ?? '').trim()
  if (!/^\d{1,4}$/.test(category)) throw new TypeError('categoryId는 숫자로 된 분류 번호여야 합니다.')
  const size = Number.isFinite(maxResults) ? Math.min(PAGE_MAX, Math.max(1, Math.trunc(maxResults))) : PAGE_MAX
  // '010'과 '10'을 같은 분류로 다루도록 앞자리 0을 뗀다
  return { region, category: String(Number(category)), size }
}

const chartKeyOf = ({ region, category }) => `${region}:${category}`

function chartUrl({ region, category, size }) {
  // hl은 보내지 않는다: snippet.localized에만 영향을 주는데 그 값은 받지 않고, 400 오류의 원인만 될 수 있다
  const query = new URLSearchParams({ part: 'snippet', chart: 'mostPopular', regionCode: region, maxResults: String(size), fields: FIELDS })
  if (category !== ALL_CATEGORIES) query.set('videoCategoryId', category)
  return `${ENDPOINT}?${query}`
}

/**
 * @param {{ apiKey: string, fetchImpl?: typeof fetch, ledger?: ReturnType<import('./quota.js').createQuotaLedger>|null, timeoutMs?: number }} opts
 */
export function createYouTubeClient({ apiKey, fetchImpl = fetch, ledger = null, timeoutMs = 10_000 } = {}) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : ''
  if (!key) throw new TypeError('YouTube API 키(apiKey)가 필요합니다.')
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl은 함수여야 합니다.')
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.ceil(timeoutMs) : 10_000
  let requestCount = 0

  /** 키는 주소가 아니라 헤더로 보낸다(주소는 로그·프록시에 남기 쉽다). */
  async function send(url) {
    let res
    try {
      res = await fetchImpl(url, { method: 'GET', headers: { 'X-goog-api-key': key, Accept: 'application/json' }, signal: AbortSignal.timeout(timeout) })
    } catch (err) {
      throw isTimeout(err) ? failure('timeout', 'timeout') : failure('network', 'network')
    }
    const status = Number(res?.status) || 0
    let body = null
    try {
      body = await res.json()
    } catch (err) {
      if (isTimeout(err)) throw failure('timeout', 'timeout')
    }
    return { status, ok: status >= 200 && status < 300, body }
  }

  /**
   * 차트가 없는 분류를 오늘 하루 기억해 둔다(물을 때마다 할당량이 든다).
   * 전체 차트는 기억하지 않는다 — 빈 응답이 한 번 왔다고 하루 내내 수집을 멈출 수는 없다.
   */
  async function rememberNoChart(chart) {
    if (ledger && chart.category !== ALL_CATEGORIES) await ledger.markNoChart(chartKeyOf(chart))
  }

  /** 오류 응답을 예외로 바꾸면서, 오늘 다시 물어도 소용없는 결과는 장부에 적어 둔다. */
  async function rejection(status, body, chart) {
    const { reason, kind } = classify(status, body)
    if (kind === 'quota') await ledger?.markExhausted()
    if (kind === 'noChart') await rememberNoChart(chart)
    return failure(reason, kind, status)
  }

  return {
    /** 지금까지 실제로 보낸 요청 수. 요청 하나가 할당량 1단위다(실패해도 차감된다). */
    get requestCount() {
      return requestCount
    },

    /** @returns {{ day: string, used: number, budget: number }|null} */
    quota() {
      return ledger ? ledger.status() : null
    },

    /**
     * 인기 차트 한 쪽을 차트 순서대로 가져온다. categoryId '0'은 분류를 가리지 않는 전체 차트다.
     * @param {{ regionCode?: string, categoryId?: string, maxResults?: number }} [options]
     * @returns {Promise<{ id: string, title: string, tags: string[], categoryId: string, publishedAt: string|null, rank: number, url: string }[]>}
     */
    async mostPopular(options) {
      const chart = readChartOptions(options ?? {})
      if (ledger) {
        await ledger.load()
        if (ledger.hasNoChart(chartKeyOf(chart))) return []
        // 확인과 기록을 한 번에 한다: 같은 장부를 쓰는 다른 프로세스(수집 CLI)와 겹쳐도 예산을 넘지 않는다
        if (!(await ledger.trySpend(1))) throw failure('budgetExceeded', 'budget')
      }
      requestCount++
      const { status, ok, body } = await send(chartUrl(chart))
      if (!ok) throw await rejection(status, body, chart)
      if (!Array.isArray(body?.items)) throw failure('bad_response', 'response', status)
      // 어떤 분류에 차트가 있는지는 문서에 없다: 빈 응답도 "차트 없음"으로 보고 오늘은 다시 묻지 않는다
      if (body.items.length === 0) await rememberNoChart(chart)
      return body.items.slice(0, PAGE_MAX).map(toVideoMeta).filter(Boolean)
    },
  }
}
