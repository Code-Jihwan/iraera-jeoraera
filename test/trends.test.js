// 트렌드 수집(server/trends/*) 테스트: 할당량 장부, YouTube 클라이언트, 저장소, 추출, 인스타그램 장부, 파이프라인.
// 네트워크는 쓰지 않는다(fetchImpl 주입). 파일은 임시 폴더에만 쓰고, 시각은 주입한 시계를 따른다.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { TREND_CATEGORIES } from '../shared/constants.js'
import { flushWrites } from '../server/store.js'
import { createQuotaLedger, quotaDay } from '../server/trends/quota.js'
import { createYouTubeClient, YouTubeError } from '../server/trends/youtube.js'
import { createTrendStore, normalizeKeyword, TrendStoreError } from '../server/trends/trend-store.js'
import { extractKeywordTrends } from '../server/trends/extract.js'
import { extractMemeTrends, MEME_TREND_SCHEMA, SYSTEM_PROMPT } from '../server/trends/extract-llm.js'
import { createInstagramClient, normalizeTag } from '../server/trends/instagram.js'
import { createTrendPipeline } from '../server/trends/pipeline.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SEED_PATH = path.join(ROOT, 'server', 'trends', 'seed-trends.json')

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
// 2026-11-11 12:00 KST = 태평양 시간 2026-11-10 19:00
const T0 = Date.parse('2026-11-11T03:00:00.000Z')
const T0_QUOTA_DAY = '2026-11-10'
const API_KEY = 'AIzaSy-TEST-key_0123456789'
const NO_KEY_MESSAGE = 'YOUTUBE_API_KEY가 없어 수집을 건너뜁니다.'

const iso = (ms) => new Date(ms).toISOString()
const quiet = { info() {}, warn() {}, error() {} }

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'trends-test-'))
  t.after(async () => {
    await flushWrites()
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })
  return dir
}

/** 손으로 돌리는 시계 */
function clock(start = T0) {
  let ms = start
  const now = () => ms
  now.advance = (delta) => {
    ms += delta
  }
  now.set = (value) => {
    ms = value
  }
  return now
}

const jsonResponse = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body })

/** 부른 내용을 적어 두는 가짜 fetch */
function fakeFetch(handler) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const call = { url: new URL(url), init }
    calls.push(call)
    return handler(call, calls.length)
  }
  fetchImpl.calls = calls
  return fetchImpl
}

const readJsonFile = async (file) => JSON.parse(await readFile(file, 'utf8'))

// ── 차트 예시 (가상의 영상 제목·태그) ──────────────────────────────────────────

const videoId = (n) => `vid${String(n).padStart(8, '0')}`
const watchUrl = (n) => `https://www.youtube.com/watch?v=${videoId(n)}`
const item = (n, title, tags) => ({ id: videoId(n), snippet: { publishedAt: '2026-11-10T09:00:01Z', title, tags, categoryId: '24' } })
const video = (n, title, tags = []) => ({ id: videoId(n), title, tags, categoryId: '24', publishedAt: '2026-11-10T09:00:01.000Z', rank: n, url: watchUrl(n) })

const CHART = [
  ['[MV] 달빛소녀(MOONGIRLS) - "첫눈처럼" Official Music Video', ['달빛소녀', 'MOONGIRLS', '첫눈처럼', 'MV', 'kpop']],
  ['얼죽아 챌린지 해봤습니다 ㅋㅋㅋ #얼죽아챌린지 #shorts', ['얼죽아', '챌린지', '아이스 아메리카노']],
  ['"이게 되네?" 탕후루 다음은 두바이 초콜릿 | 편의점 신상 리뷰', ['두바이 초콜릿', '편의점', '신상', '리뷰']],
  ['두바이 초콜릿 직접 만들어 봤습니다 (실패 주의)', ['두바이초콜릿', '디저트', '홈베이킹']],
  ['[4K] 달빛소녀 - 첫눈처럼 직캠 | 뮤직캠프 241109', ['달빛소녀', '직캠', '뮤직캠프']],
  ['한겨울에도 얼죽아? 얼죽아 회원 모집합니다 🧊', ['얼죽아', '겨울', '카페']],
  ['「별의 정원」 시즌2 공식 예고편', ['별의 정원', '예고편', '드라마']],
  ['KSL 결승 하이라이트 | 2026 서머 결승전 3세트', ['KSL', '결승']],
  ['퇴근길 붕어빵 먹방 🐟 붕어빵 시즌 시작! #붕어빵', ['붕어빵', '먹방', '겨울간식']],
  ['붕어빵 시즌 왔다... 팥 vs 슈크림 당신의 선택은?', ['붕어빵', '팥붕', '슈붕']],
]
const chartItems = CHART.map(([title, tags], i) => item(i + 1, title, tags))
const chartVideos = CHART.map(([title, tags], i) => video(i + 1, title, tags))

// 위 차트에서 규칙 기반 추출이 내놓아야 하는 결과: [키워드, 점수, 근거 영상 수, 출처 영상 번호]
const CHART_KEYWORDS = [
  ['달빛소녀', 2.5, 2, 1],
  ['얼죽아', 2.3333, 2, 2],
  ['두바이 초콜릿', 2.25, 2, 3],
  ['붕어빵', 2.1, 2, 9],
  ['첫눈처럼', 1.5, 1, 1],
  ['이게 되네', 1.25, 1, 3],
  ['별의 정원', 1.125, 1, 7],
]

// ── 할당량 장부 ──────────────────────────────────────────

describe('할당량 장부', () => {
  test('할당량 날짜는 태평양 시간 자정에 바뀐다(서머타임 포함)', () => {
    // 겨울(PST, UTC-8): 한국 시간 17시가 경계
    assert.equal(quotaDay(Date.parse('2026-11-11T07:59:59Z')), '2026-11-10')
    assert.equal(quotaDay(Date.parse('2026-11-11T08:00:00Z')), '2026-11-11')
    // 여름(PDT, UTC-7): 한국 시간 16시가 경계
    assert.equal(quotaDay(Date.parse('2026-07-01T06:59:59Z')), '2026-06-30')
    assert.equal(quotaDay(Date.parse('2026-07-01T07:00:00Z')), '2026-07-01')
    assert.equal(quotaDay(T0), T0_QUOTA_DAY)
    for (const bad of [NaN, Infinity, '2026-11-11', null, undefined]) assert.throws(() => quotaDay(bad), TypeError)
  })

  test('쓴 만큼 세고, 예산을 넘는지 알려 주고, 다시 띄워도 이어서 센다', async (t) => {
    const file = path.join(await tempDir(t), 'quota.json')
    const now = clock()
    const ledger = createQuotaLedger({ file, dailyBudget: 3, now })
    await ledger.load()
    assert.deepEqual(ledger.status(), { day: T0_QUOTA_DAY, used: 0, budget: 3 })
    assert.equal(ledger.canSpend(3), true)
    assert.equal(ledger.canSpend(4), false)

    await ledger.spend(2)
    assert.equal(ledger.canSpend(), true)
    assert.equal(ledger.canSpend(2), false)
    assert.deepEqual(ledger.status(), { day: T0_QUOTA_DAY, used: 2, budget: 3 })

    const reopened = createQuotaLedger({ file, dailyBudget: 3, now })
    assert.equal(reopened.status().used, 0)
    await reopened.load()
    assert.equal(reopened.status().used, 2)

    for (const bad of [-1, 0.5, NaN, '1', null]) {
      assert.equal(ledger.canSpend(bad), false)
      await assert.rejects(() => ledger.spend(bad), TypeError)
    }
    assert.equal(ledger.status().used, 2)
  })

  test('날짜가 바뀌면 사용량과 "차트 없음" 기억을 새로 시작한다', async (t) => {
    const file = path.join(await tempDir(t), 'quota.json')
    const now = clock()
    const ledger = createQuotaLedger({ file, dailyBudget: 10, now })
    await ledger.spend(5)
    await ledger.markNoChart('KR:23')
    assert.equal(ledger.hasNoChart('KR:23'), true)
    assert.equal(ledger.hasNoChart('KR:24'), false)

    now.set(Date.parse('2026-11-11T07:59:59Z'))
    assert.equal(ledger.status().used, 5)
    assert.equal(ledger.hasNoChart('KR:23'), true)

    now.set(Date.parse('2026-11-11T08:00:00Z'))
    assert.deepEqual(ledger.status(), { day: '2026-11-11', used: 0, budget: 10 })
    assert.equal(ledger.hasNoChart('KR:23'), false)
    assert.equal(ledger.canSpend(10), true)
    // 어제 장부 파일은 오늘 장부에 섞이지 않는다
    await ledger.load()
    assert.equal(ledger.status().used, 0)
    assert.equal(ledger.hasNoChart('KR:23'), false)
  })

  test('소진 표시, 다른 프로세스가 쓴 만큼 합치기, 잘못된 설정', async (t) => {
    const file = path.join(await tempDir(t), 'quota.json')
    const now = clock()
    const server = createQuotaLedger({ file, dailyBudget: 10, now })
    const cli = createQuotaLedger({ file, dailyBudget: 10, now })
    await server.spend(3)
    await cli.load()
    await cli.spend(4)
    await cli.markNoChart('KR:27')
    await server.load()
    assert.equal(server.status().used, 7)
    assert.equal(server.hasNoChart('KR:27'), true)

    await server.markExhausted()
    assert.equal(server.canSpend(1), false)
    assert.equal(server.status().used, 10)
    assert.deepEqual(await readJsonFile(file), { day: T0_QUOTA_DAY, used: 10, noChart: ['KR:27'] })

    await assert.rejects(() => server.markNoChart(''), TypeError)
    assert.throws(() => createQuotaLedger({ dailyBudget: 10 }), TypeError)
    assert.throws(() => createQuotaLedger({ file, dailyBudget: 0 }), TypeError)
    assert.throws(() => createQuotaLedger({ file, dailyBudget: '500' }), TypeError)
    assert.throws(() => createQuotaLedger(), TypeError)
  })
})

// ── YouTube 클라이언트 ──────────────────────────────────────────

describe('YouTube 클라이언트', () => {
  // 옛 형식의 오류 봉투: status·details 없이 errors[]만 온다
  const legacyError = (code, reason) => ({ error: { code, message: `upstream text about ${reason}`, errors: [{ domain: 'youtube.something', reason, message: 'upstream detail' }] } })
  const errorInfo = (reason) => ({ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, domain: 'googleapis.com', metadata: { service: 'youtube.googleapis.com' } })

  function assertNoSecrets(err) {
    const text = `${err.message}\n${err.stack}\n${JSON.stringify(err)}\n${String(err.cause ?? '')}`
    assert.ok(!text.includes(API_KEY), '키가 오류에 담기면 안 된다')
    assert.ok(!text.includes('googleapis.com'), '요청 주소가 오류에 담기면 안 된다')
    assert.ok(!text.includes('upstream'), 'API가 보낸 문장을 그대로 옮기지 않는다')
  }

  test('인기 차트 요청: 키는 헤더로만 보내고, snippet만 받아 필요한 값만 남긴다', async () => {
    const fetchImpl = fakeFetch(() =>
      jsonResponse(200, {
        items: [
          {
            id: videoId(1),
            snippet: { publishedAt: '2026-11-10T09:00:01Z', title: '  얼죽아 챌린지 해봤습니다\u0007 ', tags: ['얼죽아', '  ', 7, '챌린지'], categoryId: '24', channelTitle: '어느 채널', description: '설명', thumbnails: {} },
            statistics: { viewCount: '123456', likeCount: '789' },
          },
          { id: videoId(2), snippet: { title: '태그 없는 영상', categoryId: 10 } },
          { id: 'bad id!', snippet: { title: '형식이 어긋난 항목' } },
          { id: videoId(4), snippet: {} },
          null,
          { id: videoId(6), snippet: { publishedAt: 'not a date', title: '여섯 번째', tags: 'not-an-array', categoryId: 'abc' } },
        ],
      }),
    )
    const client = createYouTubeClient({ apiKey: API_KEY, fetchImpl })
    const videos = await client.mostPopular()

    assert.deepEqual(videos, [
      { id: videoId(1), title: '얼죽아 챌린지 해봤습니다', tags: ['얼죽아', '챌린지'], categoryId: '24', publishedAt: '2026-11-10T09:00:01.000Z', rank: 1, url: watchUrl(1) },
      { id: videoId(2), title: '태그 없는 영상', tags: [], categoryId: '10', publishedAt: null, rank: 2, url: watchUrl(2) },
      { id: videoId(6), title: '여섯 번째', tags: [], categoryId: '', publishedAt: null, rank: 6, url: watchUrl(6) },
    ])

    assert.equal(fetchImpl.calls.length, 1)
    const [{ url, init }] = fetchImpl.calls
    assert.equal(url.origin + url.pathname, 'https://www.googleapis.com/youtube/v3/videos')
    // statistics, hl, key는 보내지 않는다. regionCode는 항상 보낸다.
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      part: 'snippet',
      chart: 'mostPopular',
      regionCode: 'KR',
      maxResults: '50',
      fields: 'items(id,snippet(publishedAt,title,tags,categoryId))',
    })
    assert.equal(init.method, 'GET')
    assert.equal(init.headers['X-goog-api-key'], API_KEY)
    assert.ok(!url.href.includes(API_KEY))
    assert.ok(init.signal instanceof AbortSignal, '시간 제한 신호를 함께 보낸다')
    assert.equal(client.requestCount, 1)
    assert.equal(client.quota(), null)
  })

  test('분류 차트는 videoCategoryId를 붙이고, 잘못된 인자는 요청 없이 TypeError', async () => {
    const fetchImpl = fakeFetch(() => jsonResponse(200, { items: [] }))
    const client = createYouTubeClient({ apiKey: `  ${API_KEY}  `, fetchImpl })
    assert.deepEqual(await client.mostPopular({ regionCode: 'us', categoryId: '10', maxResults: 500 }), [])
    const params = fetchImpl.calls[0].url.searchParams
    assert.equal(params.get('videoCategoryId'), '10')
    assert.equal(params.get('regionCode'), 'US')
    assert.equal(params.get('maxResults'), '50')
    assert.equal(fetchImpl.calls[0].init.headers['X-goog-api-key'], API_KEY)

    for (const bad of [{ regionCode: 'KOR' }, { regionCode: null }, { regionCode: 82 }, { categoryId: 'music' }, { categoryId: '10&key=x' }, { categoryId: null }]) {
      await assert.rejects(() => client.mostPopular(bad), TypeError)
    }
    assert.equal(fetchImpl.calls.length, 1)
    assert.equal(client.requestCount, 1)

    assert.throws(() => createYouTubeClient({ apiKey: '' }), TypeError)
    assert.throws(() => createYouTubeClient({ apiKey: null }), TypeError)
    assert.throws(() => createYouTubeClient(), TypeError)
    assert.throws(() => createYouTubeClient({ apiKey: API_KEY, fetchImpl: 'fetch' }), TypeError)
  })

  const ERROR_CASES = [
    { name: '할당량 소진', status: 403, body: legacyError(403, 'quotaExceeded'), reason: 'quotaExceeded', fatal: true, retryable: false },
    { name: '일일 한도', status: 403, body: legacyError(403, 'dailyLimitExceeded'), reason: 'dailyLimitExceeded', fatal: true, retryable: false },
    { name: '요청 제한(403)', status: 403, body: legacyError(403, 'rateLimitExceeded'), reason: 'rateLimitExceeded', fatal: false, retryable: true },
    { name: '사용자별 요청 제한', status: 403, body: legacyError(403, 'userRateLimitExceeded'), reason: 'userRateLimitExceeded', fatal: false, retryable: true },
    { name: '요청 제한(429, 본문 없음)', status: 429, body: null, reason: 'rateLimitExceeded', fatal: false, retryable: true },
    { name: '차트 없음', status: 400, body: legacyError(400, 'videoChartNotFound'), reason: 'videoChartNotFound', fatal: false, retryable: false },
    {
      name: '잘못된 키(errors[0].reason은 badRequest, ErrorInfo에 진짜 이유)',
      status: 400,
      body: {
        error: {
          code: 400,
          message: 'upstream: API key not valid.',
          errors: [{ domain: 'global', reason: 'badRequest', message: 'upstream' }],
          status: 'INVALID_ARGUMENT',
          details: [{ '@type': 'type.googleapis.com/google.rpc.LocalizedMessage', locale: 'en-US', message: 'upstream' }, errorInfo('API_KEY_INVALID')],
        },
      },
      reason: 'API_KEY_INVALID',
      fatal: true,
      retryable: false,
    },
    {
      name: '키 없음·권한 없음',
      status: 403,
      body: { error: { code: 403, message: 'upstream: Permission denied.', errors: [{ domain: 'global', reason: 'forbidden', message: 'upstream' }], status: 'PERMISSION_DENIED', details: [errorInfo('ACCESS_DENIED')] } },
      reason: 'forbidden',
      fatal: true,
      retryable: false,
    },
    { name: 'API 사용 설정 안 됨', status: 403, body: legacyError(403, 'accessNotConfigured'), reason: 'accessNotConfigured', fatal: true, retryable: false },
    { name: '처음 보는 403(키 제한 등)', status: 403, body: { error: { code: 403, details: [errorInfo('API_KEY_IP_ADDRESS_BLOCKED')] } }, reason: 'API_KEY_IP_ADDRESS_BLOCKED', fatal: true, retryable: false },
    { name: '잘못된 매개변수', status: 400, body: legacyError(400, 'invalidParameter'), reason: 'invalidParameter', fatal: false, retryable: false },
    { name: '지원하지 않는 지역', status: 400, body: legacyError(400, 'unsupportedRegionCode'), reason: 'unsupportedRegionCode', fatal: false, retryable: false },
    { name: '본문 없는 400', status: 400, body: null, reason: 'badRequest', fatal: false, retryable: false },
    { name: 'reason이 문자열이 아님', status: 400, body: { error: { errors: [{ reason: { toString: () => 'constructor' } }], details: 'nope' } }, reason: 'badRequest', fatal: false, retryable: false },
    { name: 'reason이 객체의 기본 속성 이름', status: 400, body: legacyError(400, 'constructor'), reason: 'constructor', fatal: false, retryable: false },
    { name: '찾을 수 없음', status: 404, body: legacyError(404, 'videoNotFound'), reason: 'videoNotFound', fatal: false, retryable: false },
    { name: '서버 오류', status: 503, body: legacyError(503, 'backendError'), reason: 'backendError', fatal: false, retryable: true },
    { name: '본문이 이상한 500', status: 500, body: 'oops', reason: 'backendError', fatal: false, retryable: true },
  ]

  for (const c of ERROR_CASES) {
    test(`오류 분류: ${c.name}`, async () => {
      const fetchImpl = fakeFetch(() => jsonResponse(c.status, c.body))
      const client = createYouTubeClient({ apiKey: API_KEY, fetchImpl })
      const err = await client.mostPopular({ categoryId: '23' }).then(
        () => null,
        (e) => e,
      )
      assert.ok(err instanceof YouTubeError)
      assert.equal(err.name, 'YouTubeError')
      assert.deepEqual({ reason: err.reason, status: err.status, fatal: err.fatal, retryable: err.retryable }, { reason: c.reason, status: c.status, fatal: c.fatal, retryable: c.retryable })
      assert.match(err.message, /[가-힣]/)
      assertNoSecrets(err)
      assert.equal(fetchImpl.calls.length, 1, '클라이언트는 스스로 다시 보내지 않는다')
    })
  }

  test('연결 실패와 시간 초과는 다시 해 볼 수 있는 오류다', async () => {
    const failWith = (error) =>
      createYouTubeClient({
        apiKey: API_KEY,
        fetchImpl: async (url) => {
          throw error(url)
        },
      })
    const cases = [
      [(url) => new TypeError(`fetch failed for ${url} with key ${API_KEY}`), 'network'],
      [() => new DOMException('The operation was aborted due to timeout', 'TimeoutError'), 'timeout'],
      [() => new DOMException('This operation was aborted', 'AbortError'), 'timeout'],
    ]
    for (const [error, reason] of cases) {
      const err = await failWith(error)
        .mostPopular()
        .catch((e) => e)
      assert.ok(err instanceof YouTubeError)
      assert.deepEqual({ reason: err.reason, status: err.status, fatal: err.fatal, retryable: err.retryable }, { reason, status: 0, fatal: false, retryable: true })
      assertNoSecrets(err)
    }

    // 본문을 읽다가 시간이 다 된 경우
    const slowBody = createYouTubeClient({
      apiKey: API_KEY,
      fetchImpl: async () => ({
        status: 200,
        json: async () => {
          throw new DOMException('timeout', 'TimeoutError')
        },
      }),
    })
    assert.equal((await slowBody.mostPopular().catch((e) => e)).reason, 'timeout')
  })

  test('성공 응답인데 형식이 다르면 bad_response', async () => {
    const bodies = [null, {}, { items: 'nope' }, [], 'text']
    for (const body of bodies) {
      const client = createYouTubeClient({ apiKey: API_KEY, fetchImpl: fakeFetch(() => jsonResponse(200, body)) })
      const err = await client.mostPopular().catch((e) => e)
      assert.deepEqual({ reason: err.reason, status: err.status, fatal: err.fatal, retryable: err.retryable }, { reason: 'bad_response', status: 200, fatal: false, retryable: false })
    }
    const notJson = createYouTubeClient({
      apiKey: API_KEY,
      fetchImpl: async () => ({
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token <')
        },
      }),
    })
    assert.equal((await notJson.mostPopular().catch((e) => e)).reason, 'bad_response')

    // 응답 객체 자체가 이상한 경우(상태 없음, 리다이렉트 등)
    for (const res of [undefined, {}, { status: 'weird' }, { status: 304, json: async () => null }]) {
      const client = createYouTubeClient({ apiKey: API_KEY, fetchImpl: async () => res })
      const err = await client.mostPopular().catch((e) => e)
      assert.deepEqual({ reason: err.reason, fatal: err.fatal, retryable: err.retryable }, { reason: 'bad_response', fatal: false, retryable: false })
    }
  })

  test('장부: 실패한 요청도 1단위로 세고, 예산이 없으면 보내지 않는다', async (t) => {
    const now = clock()
    const ledger = createQuotaLedger({ file: path.join(await tempDir(t), 'quota.json'), dailyBudget: 3, now })
    const answers = [jsonResponse(200, { items: [item(1, '첫 영상')] }), jsonResponse(400, legacyError(400, 'invalidParameter')), jsonResponse(503, null), jsonResponse(200, { items: [item(2, '다음 날 영상')] })]
    const fetchImpl = fakeFetch((call, n) => answers[n - 1])
    const client = createYouTubeClient({ apiKey: API_KEY, fetchImpl, ledger })

    assert.equal((await client.mostPopular()).length, 1)
    await assert.rejects(() => client.mostPopular({ categoryId: '10' }), YouTubeError)
    await assert.rejects(() => client.mostPopular({ categoryId: '20' }), YouTubeError)
    assert.deepEqual(client.quota(), { day: T0_QUOTA_DAY, used: 3, budget: 3 })

    const err = await client.mostPopular({ categoryId: '22' }).catch((e) => e)
    assert.deepEqual({ reason: err.reason, status: err.status, fatal: err.fatal, retryable: err.retryable }, { reason: 'budgetExceeded', status: 0, fatal: true, retryable: false })
    assert.equal(fetchImpl.calls.length, 3)
    assert.equal(client.requestCount, 3)

    // 다음 할당량 날짜에는 다시 보낸다
    now.advance(DAY)
    assert.equal((await client.mostPopular({ categoryId: '22' })).length, 1)
    assert.deepEqual(client.quota(), { day: '2026-11-11', used: 1, budget: 3 })
  })

  test('장부: API가 할당량 소진을 알리면 그날은 더 보내지 않는다', async (t) => {
    const file = path.join(await tempDir(t), 'quota.json')
    const now = clock()
    const fetchImpl = fakeFetch(() => jsonResponse(403, legacyError(403, 'quotaExceeded')))
    const client = createYouTubeClient({ apiKey: API_KEY, fetchImpl, ledger: createQuotaLedger({ file, dailyBudget: 100, now }) })
    assert.equal((await client.mostPopular().catch((e) => e)).reason, 'quotaExceeded')
    assert.equal((await client.mostPopular().catch((e) => e)).reason, 'budgetExceeded')
    assert.equal(fetchImpl.calls.length, 1)
    assert.deepEqual(client.quota(), { day: T0_QUOTA_DAY, used: 100, budget: 100 })

    // 다시 띄워도 마찬가지다
    const restarted = createYouTubeClient({ apiKey: API_KEY, fetchImpl, ledger: createQuotaLedger({ file, dailyBudget: 100, now }) })
    assert.equal((await restarted.mostPopular().catch((e) => e)).reason, 'budgetExceeded')
    assert.equal(fetchImpl.calls.length, 1)
  })

  test('장부: 차트가 없는 분류(400 videoChartNotFound, 빈 응답)는 그날 다시 묻지 않는다', async (t) => {
    const file = path.join(await tempDir(t), 'quota.json')
    const now = clock()
    const answers = { 23: jsonResponse(400, legacyError(400, 'videoChartNotFound')), 24: jsonResponse(200, { items: [] }) }
    const fetchImpl = fakeFetch(({ url }) => answers[url.searchParams.get('videoCategoryId')] ?? jsonResponse(200, { items: chartItems }))
    const open = () => createYouTubeClient({ apiKey: API_KEY, fetchImpl, ledger: createQuotaLedger({ file, dailyBudget: 100, now }) })
    const client = open()

    const missing = await client.mostPopular({ categoryId: '23' }).catch((e) => e)
    assert.deepEqual({ reason: missing.reason, fatal: missing.fatal, retryable: missing.retryable }, { reason: 'videoChartNotFound', fatal: false, retryable: false })
    assert.deepEqual(await client.mostPopular({ categoryId: '24' }), [])
    assert.equal(fetchImpl.calls.length, 2)

    // 같은 날: 요청 없이 빈 목록, 할당량도 쓰지 않는다
    assert.deepEqual(await client.mostPopular({ categoryId: '23' }), [])
    assert.deepEqual(await client.mostPopular({ categoryId: '24' }), [])
    assert.deepEqual(await open().mostPopular({ categoryId: '23' }), [])
    assert.equal(fetchImpl.calls.length, 2)
    assert.equal(client.quota().used, 2)

    // 차트가 있는 분류와 다른 지역은 그대로 묻는다
    assert.equal((await client.mostPopular()).length, chartItems.length)
    assert.deepEqual(await client.mostPopular({ regionCode: 'US', categoryId: '24' }), [])
    assert.equal(fetchImpl.calls.length, 4)

    // 다음 날에는 다시 물어본다
    now.advance(DAY)
    await assert.rejects(() => client.mostPopular({ categoryId: '023' }), (e) => e.reason === 'videoChartNotFound')
    assert.equal(fetchImpl.calls.length, 5)
    assert.equal(fetchImpl.calls[4].url.searchParams.get('videoCategoryId'), '23')

    // 전체 차트는 비어 있어도 기억하지 않는다(빈 응답 한 번에 하루 내내 수집이 멈추지 않게)
    const emptyMain = fakeFetch(() => jsonResponse(200, { items: [] }))
    const main = createYouTubeClient({ apiKey: API_KEY, fetchImpl: emptyMain, ledger: createQuotaLedger({ file, dailyBudget: 100, now }) })
    assert.deepEqual(await main.mostPopular(), [])
    assert.deepEqual(await main.mostPopular({ categoryId: '00' }), [])
    assert.equal(emptyMain.calls.length, 2)
    assert.equal(emptyMain.calls[1].url.searchParams.has('videoCategoryId'), false)
  })
})

// ── 트렌드 저장소 ──────────────────────────────────────────

describe('트렌드 저장소', () => {
  const draft = (keyword, overrides = {}) => ({
    key: normalizeKeyword(keyword),
    keyword,
    kind: 'keyword',
    pattern: null,
    meaning: '',
    origin: '',
    caution: '',
    category: '일상',
    source: { type: 'youtube', label: 'YouTube 인기 차트', url: watchUrl(1), title: null },
    stats: { videoCount: 2 },
    collectedAt: iso(T0),
    score: 2.5,
    meaningVerified: false,
    ...overrides,
  })

  async function openStore(t, { dir, now = clock(), ttlDays = 7 } = {}) {
    const dataDir = dir ?? (await tempDir(t))
    const store = createTrendStore({ dataDir, seedPath: SEED_PATH, ttlDays, now })
    await store.init()
    return { store, dir: dataDir, now }
  }

  const pendingOf = (store) => store.list({ status: 'pending', includeSeed: false })

  test('init: 예시 데이터는 노출 중인 샘플로 읽힌다', async (t) => {
    const { store } = await openStore(t)
    const seedFile = await readJsonFile(SEED_PATH)
    const list = store.list()
    assert.ok(list.length >= 20)
    assert.deepEqual(
      list.map((trend) => trend.id),
      seedFile.trends.map((trend) => trend.id),
      '파일에 적힌 순서 그대로',
    )
    for (const trend of list) {
      assert.deepEqual(
        { status: trend.status, sample: trend.sample, collectedAt: trend.collectedAt, publishedAt: trend.publishedAt, type: trend.source.type },
        { status: 'approved', sample: true, collectedAt: null, publishedAt: null, type: 'seed' },
      )
    }
    assert.deepEqual(store.stats(), { seed: seedFile.trends.length, live: 0, approved: 0, pending: 0, rejected: 0, lastCollectedAt: null })
    assert.deepEqual(store.list({ status: 'pending' }), [])
    assert.deepEqual(store.list({ status: 'rejected' }), [])
    assert.deepEqual(store.list({ includeSeed: false }), [])
    assert.deepEqual(store.list({ status: 'everything' }), [])
    assert.deepEqual(store.latencyHours(), [])

    const frames = store.frames()
    assert.deepEqual(
      frames.map((trend) => trend.id),
      seedFile.trends.filter((trend) => trend.engine?.asFrame === true).map((trend) => trend.id),
    )
    assert.ok(frames.length >= 5)
    assert.ok(frames.every((trend) => trend.engine.asFrame === true && trend.engine.forms))

    assert.equal(store.get('seed-ohiryeo-joa').keyword, '오히려 좋아')
    for (const missing of ['nope', '', undefined, null, 42, {}]) assert.equal(store.get(missing), null)

    // 돌려받은 객체를 고쳐도 저장소 안의 값은 그대로다
    const got = store.get('seed-ohiryeo-joa')
    got.keyword = '바뀐 말'
    delete got.engine
    list[0].keyword = '바뀐 말'
    frames[0].engine.asFrame = false
    assert.equal(store.get('seed-ohiryeo-joa').keyword, '오히려 좋아')
    assert.ok(store.get('seed-ohiryeo-joa').engine.forms)
    assert.equal(store.list()[0].keyword, seedFile.trends[0].keyword)
    assert.equal(store.frames().length, frames.length)
  })

  test('예시 파일이 없거나 인자가 이상해도 죽지 않는다', async (t) => {
    const dir = await tempDir(t)
    const store = createTrendStore({ dataDir: dir, seedPath: path.join(dir, 'missing.json') })
    assert.deepEqual(store.list(), [], 'init 전에는 비어 있다')
    await store.init()
    assert.deepEqual(store.list(), [])
    assert.deepEqual(store.list(null), [])
    assert.deepEqual(store.frames(), [])
    assert.deepEqual(await store.upsertDrafts(null), { added: 0, updated: 0 })
    assert.deepEqual(await store.upsertDrafts('drafts', { reviewMode: 'auto' }), { added: 0, updated: 0 })
    assert.deepEqual(await store.upsertDrafts([null, 1, 'x', [], {}, { keyword: '   ' }, { keyword: '!!!' }, { keyword: 42 }], null), { added: 0, updated: 0 })
    await flushWrites()
    await assert.rejects(access(path.join(dir, 'trends.json')), '바뀐 것이 없으면 파일도 만들지 않는다')

    const seedless = createTrendStore({ dataDir: dir })
    await seedless.init()
    assert.deepEqual(seedless.list(), [])

    assert.throws(() => createTrendStore({}), TypeError)
    assert.throws(() => createTrendStore({ dataDir: 42 }), TypeError)
    assert.throws(() => createTrendStore(), TypeError)
  })

  test('upsert(manual): 새 키워드는 검수 대기로 들어가고, 같은 말은 갱신만 한다', async (t) => {
    const { store, dir, now } = await openStore(t)
    assert.deepEqual(await store.upsertDrafts([draft('두바이 초콜릿'), draft('얼죽아', { score: 2.3333 })], { reviewMode: 'manual' }), { added: 2, updated: 0 })

    assert.ok(
      store.list().every((trend) => trend.sample),
      '검수 전에는 사용자 목록에 나오지 않는다',
    )
    const pending = pendingOf(store)
    assert.deepEqual(
      pending.map((trend) => trend.keyword),
      ['두바이 초콜릿', '얼죽아'],
    )
    const [trend] = pending
    assert.match(trend.id, /^yt-[0-9a-f]{10}$/)
    assert.deepEqual(trend, {
      id: trend.id,
      keyword: '두바이 초콜릿',
      kind: 'keyword',
      pattern: null,
      meaning: '',
      origin: '',
      caution: '',
      category: '일상',
      source: { type: 'youtube', label: 'YouTube 인기 차트', url: watchUrl(1), title: null },
      stats: { videoCount: 2 },
      instagram: null,
      collectedAt: iso(T0),
      publishedAt: null,
      status: 'pending',
      sample: false,
      meaningVerified: false,
      lastSeenAt: iso(T0),
      score: 2.5,
    })

    // 띄어쓰기·대소문자·기호가 달라도 같은 말이다. 한 묶음 안에서 겹친 것은 한 번만 센다.
    now.advance(3 * HOUR)
    const second = await store.upsertDrafts(
      [
        draft('두바이초콜릿', { stats: { videoCount: 5 }, score: 5.5, source: { url: watchUrl(9) }, collectedAt: iso(now()) }),
        draft('#두바이  초콜릿!'),
        draft('새로 뜬 말', { collectedAt: iso(now()) }),
      ],
      { reviewMode: 'manual' },
    )
    assert.deepEqual(second, { added: 1, updated: 1 })
    const refreshed = store.get(trend.id)
    assert.deepEqual(refreshed, {
      ...trend,
      source: { type: 'youtube', label: 'YouTube 인기 차트', url: watchUrl(9), title: null },
      stats: { videoCount: 5 },
      score: 5.5,
      lastSeenAt: iso(T0 + 3 * HOUR),
    })
    assert.deepEqual(store.stats(), { seed: store.stats().seed, live: 3, approved: 0, pending: 3, rejected: 0, lastCollectedAt: iso(T0 + 3 * HOUR) })

    // 파일에 남고, 다시 띄워도 그대로다
    await flushWrites()
    const saved = await readJsonFile(path.join(dir, 'trends.json'))
    assert.equal(saved.trends.length, 3)
    const { store: reopened } = await openStore(t, { dir, now })
    assert.deepEqual(reopened.get(trend.id), refreshed)
    assert.deepEqual(
      pendingOf(reopened).map((x) => x.keyword),
      ['두바이 초콜릿', '새로 뜬 말', '얼죽아'],
    )
  })

  test('upsert: 예시와 같은 말은 건너뛰고, 초안의 값은 그대로 믿지 않는다', async (t) => {
    const { store } = await openStore(t)
    const result = await store.upsertDrafts(
      [
        draft('오히려 좋아'),
        draft('  갓생  '),
        draft('검증 대상', {
          kind: 'weird',
          category: '없는 분류',
          pattern: '   ',
          meaning: '뜻'.repeat(500),
          score: 'NaN',
          stats: { videoCount: -3, viewCount: 99999 },
          meaningVerified: true,
          status: 'approved',
          publishedAt: iso(T0),
          sample: true,
          lastSeenAt: iso(T0 - DAY),
          source: { type: 'seed', label: '', url: 'javascript:alert(1)', title: '영상 제목은 저장하지 않는다' },
          collectedAt: 'garbage',
          instagram: { tag: '검증대상', mediaCount: '50', checkedAt: iso(T0) },
          engine: { asFrame: true },
        }),
      ],
      { reviewMode: 'manual' },
    )
    assert.deepEqual(result, { added: 1, updated: 0 })
    const [trend] = pendingOf(store)
    assert.deepEqual(trend, {
      id: trend.id,
      keyword: '검증 대상',
      kind: 'keyword',
      pattern: null,
      meaning: '뜻'.repeat(300),
      origin: '',
      caution: '',
      category: '일상',
      source: { type: 'youtube', label: 'YouTube 인기 차트', url: null, title: null },
      stats: { videoCount: 0 },
      instagram: null,
      collectedAt: iso(T0),
      publishedAt: null,
      status: 'pending',
      sample: false,
      meaningVerified: false,
      lastSeenAt: iso(T0),
      score: 0,
    })
    assert.equal(store.frames().some((frame) => frame.id === trend.id), false)
  })

  test('upsert(auto): 새 키워드를 바로 노출하고, 수집 트렌드를 예시보다 앞에 둔다', async (t) => {
    const { store, now } = await openStore(t)
    now.advance(2 * HOUR)
    await store.upsertDrafts([draft('얼죽아', { score: 2.3333 }), draft('두바이 초콜릿', { score: 2.5 }), draft('가나다', { score: 2.5 })], { reviewMode: 'auto' })
    const list = store.list()
    assert.deepEqual(
      list.slice(0, 3).map((trend) => trend.keyword),
      ['가나다', '두바이 초콜릿', '얼죽아'],
      '점수 높은 순, 같으면 가나다순',
    )
    assert.ok(list.slice(3).every((trend) => trend.sample))
    assert.deepEqual(
      { status: list[0].status, publishedAt: list[0].publishedAt, meaningVerified: list[0].meaningVerified },
      { status: 'approved', publishedAt: iso(T0 + 2 * HOUR), meaningVerified: false },
    )
    assert.deepEqual(store.list({ includeSeed: false }).length, 3)
    // 수집(T0) → 노출(T0+2시간)
    assert.deepEqual(store.latencyHours(), [2, 2, 2])
  })

  test('인스타그램 반응은 점수와 섞지 않고 따로 저장한다', async (t) => {
    const { store, dir, now } = await openStore(t)
    const reaction = { tag: '얼죽아', mediaCount: 42, checkedAt: iso(T0) }
    await store.upsertDrafts([draft('얼죽아', { score: 2.3333, instagram: { ...reaction, hashtagId: '17843857450040591', likes: 9999 } })], { reviewMode: 'auto' })
    const [trend] = store.list({ includeSeed: false })
    assert.deepEqual(trend.instagram, reaction)
    assert.equal(trend.score, 2.3333)

    // 다음 수집에서 반응을 확인하지 못해도 지난 결과는 남는다
    await store.upsertDrafts([draft('얼죽아', { score: 3.5 })], { reviewMode: 'auto' })
    assert.deepEqual(store.get(trend.id).instagram, reaction)
    const { store: reopened } = await openStore(t, { dir, now })
    assert.deepEqual(reopened.get(trend.id).instagram, reaction)
    assert.equal(reopened.get(trend.id).score, 3.5)
  })

  test('setStatus: 승인·수정·숨김, 그리고 바꿀 수 없는 것들', async (t) => {
    const { store, now } = await openStore(t)
    await store.upsertDrafts([draft('얼죽아')], { reviewMode: 'manual' })
    const [{ id }] = pendingOf(store)

    now.advance(5 * HOUR)
    const approved = await store.setStatus(id, 'approved', {
      meaning: '  얼어 죽어도\n아이스 아메리카노  ',
      origin: '',
      caution: '주'.repeat(400),
      category: '자조·푸념',
      pattern: '{X}도 얼죽아',
      keyword: '바꾸려는 키워드',
      score: 99,
      status: 'rejected',
      sample: true,
    })
    assert.deepEqual(
      { ...approved, caution: approved.caution.length },
      {
        id,
        keyword: '얼죽아',
        kind: 'keyword',
        pattern: '{X}도 얼죽아',
        meaning: '얼어 죽어도 아이스 아메리카노',
        origin: '',
        caution: 300,
        category: '자조·푸념',
        source: { type: 'youtube', label: 'YouTube 인기 차트', url: watchUrl(1), title: null },
        stats: { videoCount: 2 },
        instagram: null,
        collectedAt: iso(T0),
        publishedAt: iso(T0 + 5 * HOUR),
        status: 'approved',
        sample: false,
        meaningVerified: true,
        lastSeenAt: iso(T0),
        score: 2.5,
      },
    )
    assert.equal(store.list()[0].id, id)
    assert.deepEqual(store.latencyHours(), [5])

    // 숨겼다가 다시 승인해도 첫 노출 시각은 그대로다
    now.advance(HOUR)
    const hidden = await store.setStatus(id, 'rejected')
    assert.deepEqual({ status: hidden.status, publishedAt: hidden.publishedAt }, { status: 'rejected', publishedAt: iso(T0 + 5 * HOUR) })
    assert.equal(store.list().some((trend) => trend.id === id), false)
    assert.deepEqual(store.latencyHours(), [])
    now.advance(HOUR)
    const again = await store.setStatus(id, 'approved', { category: '없는 분류', pattern: '', meaning: 42, origin: null })
    assert.deepEqual(
      { publishedAt: again.publishedAt, category: again.category, pattern: again.pattern, meaning: again.meaning },
      { publishedAt: iso(T0 + 5 * HOUR), category: '자조·푸념', pattern: null, meaning: '얼어 죽어도 아이스 아메리카노' },
    )

    // 대기 상태로 두고 내용만 고쳐도 뜻을 확인한 것으로 본다
    await store.upsertDrafts([draft('두바이 초콜릿'), draft('새로 뜬 말')], { reviewMode: 'manual' })
    const [first, second] = pendingOf(store)
    const edited = await store.setStatus(first.id, 'pending', { meaning: '두바이식 초콜릿 디저트' })
    assert.deepEqual({ status: edited.status, publishedAt: edited.publishedAt, meaningVerified: edited.meaningVerified }, { status: 'pending', publishedAt: null, meaningVerified: true })
    // 고치지 않고 숨기기만 하면 확인한 것으로 치지 않는다
    const rejected = await store.setStatus(second.id, 'rejected', {})
    assert.deepEqual({ status: rejected.status, meaningVerified: rejected.meaningVerified }, { status: 'rejected', meaningVerified: false })
    assert.deepEqual(store.stats(), { seed: store.stats().seed, live: 3, approved: 1, pending: 1, rejected: 1, lastCollectedAt: iso(T0 + 7 * HOUR) })

    const codeOf = (code) => (err) => err instanceof TrendStoreError && err.code === code && /[가-힣]/.test(err.message)
    await assert.rejects(() => store.setStatus('seed-ohiryeo-joa', 'rejected'), codeOf('seed_readonly'))
    await assert.rejects(() => store.setStatus('yt-0000000000', 'approved'), codeOf('not_found'))
    await assert.rejects(() => store.setStatus(undefined, 'approved'), codeOf('not_found'))
    await assert.rejects(() => store.setStatus(id, 'published'), codeOf('bad_status'))
    await assert.rejects(() => store.setStatus(id), codeOf('bad_status'))
    assert.equal(store.get('seed-ohiryeo-joa').status, 'approved')
    assert.equal(store.get(id).status, 'approved')
  })

  test('뜻이 비어 있던 미검수 항목은 나중에 온 설명을 받고, 사람이 확인한 항목은 그대로 둔다', async (t) => {
    const { store } = await openStore(t)
    await store.upsertDrafts([draft('이게 되네', { score: 3 }), draft('얼죽아', { score: 2 })], { reviewMode: 'manual' })
    const [open, reviewed] = pendingOf(store)
    await store.setStatus(reviewed.id, 'approved', { meaning: '사람이 적은 뜻' })

    const described = { kind: 'phrase', meaning: 'AI가 제안한 뜻', origin: '쓰이는 맥락', caution: '', category: '놀람' }
    await store.upsertDrafts([draft('이게 되네', described), draft('얼죽아', { ...described, kind: 'word', pattern: '{X}도 얼죽아' })], { reviewMode: 'manual' })
    const adopted = store.get(open.id)
    assert.deepEqual(
      { kind: adopted.kind, meaning: adopted.meaning, origin: adopted.origin, category: adopted.category, status: adopted.status, meaningVerified: adopted.meaningVerified },
      { kind: 'phrase', meaning: 'AI가 제안한 뜻', origin: '쓰이는 맥락', category: '놀람', status: 'pending', meaningVerified: false },
    )
    const kept = store.get(reviewed.id)
    assert.deepEqual({ kind: kept.kind, pattern: kept.pattern, meaning: kept.meaning, category: kept.category }, { kind: 'keyword', pattern: null, meaning: '사람이 적은 뜻', category: '일상' })

    // 한 번 받은 설명을 다음 수집이 다시 덮어쓰지 않는다
    await store.upsertDrafts([draft('이게 되네', { ...described, meaning: '다른 뜻' })], { reviewMode: 'manual' })
    assert.equal(store.get(open.id).meaning, 'AI가 제안한 뜻')
  })

  test('purge: 마지막으로 본 지 ttlDays가 지난 수집 트렌드를 지운다', async (t) => {
    const { store, dir, now } = await openStore(t)
    await store.upsertDrafts([draft('지나간 말'), draft('계속 뜨는 말')], { reviewMode: 'auto' })
    const gone = store.list({ includeSeed: false }).find((trend) => trend.keyword === '지나간 말')

    now.advance(4 * DAY)
    await store.upsertDrafts([draft('계속 뜨는 말')], { reviewMode: 'auto' })
    assert.equal(await store.purgeExpired(), 0)
    now.advance(3 * DAY)
    assert.equal(await store.purgeExpired(), 0, '정확히 7일째에는 아직 남는다')
    assert.equal(store.get(gone.id).keyword, '지나간 말')

    now.advance(1)
    // 정리 작업이 돌기 전이라도 기한이 지난 항목은 내보내지 않는다
    assert.deepEqual(
      store.list({ includeSeed: false }).map((trend) => trend.keyword),
      ['계속 뜨는 말'],
    )
    assert.equal(store.get(gone.id), null)
    assert.equal(store.stats().live, 1)
    await assert.rejects(() => store.setStatus(gone.id, 'approved'), (err) => err.code === 'not_found')

    assert.equal(await store.purgeExpired(), 1)
    assert.equal(await store.purgeExpired(), 0)
    await flushWrites()
    assert.deepEqual(
      (await readJsonFile(path.join(dir, 'trends.json'))).trends.map((trend) => trend.keyword),
      ['계속 뜨는 말'],
    )

    // 예시 데이터는 지우지 않는다
    now.advance(365 * DAY)
    assert.equal(await store.purgeExpired(), 1)
    assert.ok(store.list().length >= 20)
    assert.equal(store.stats().live, 0)
  })

  test('보관 기간은 설정이 어떻든 30일을 넘지 않는다', async (t) => {
    const { store, now } = await openStore(t, { ttlDays: 365 })
    await store.upsertDrafts([draft('얼죽아')], { reviewMode: 'auto' })
    now.advance(30 * DAY)
    assert.equal(store.list({ includeSeed: false }).length, 1)
    now.advance(1)
    assert.equal(store.list({ includeSeed: false }).length, 0)
    assert.equal(await store.purgeExpired(), 1)
  })

  test('init: 다시 띄울 때 기한이 지난 항목과 손상된 줄을 버린다', async (t) => {
    const dir = await tempDir(t)
    const stored = (keyword, overrides = {}) => ({
      ...draft(keyword),
      id: 'yt-손댄-id',
      kind: 'word',
      meaning: '저장돼 있던 뜻',
      instagram: null,
      collectedAt: iso(T0 - DAY),
      publishedAt: iso(T0 - DAY + HOUR),
      status: 'approved',
      sample: false,
      meaningVerified: true,
      lastSeenAt: iso(T0 - HOUR),
      score: 3.5,
      ...overrides,
    })
    const trends = [
      stored('살아 있는 말'),
      stored('기한 지난 말', { lastSeenAt: iso(T0 - 8 * DAY) }),
      stored('상태가 이상한 말', { status: 'published' }),
      stored('시각이 없는 말', { lastSeenAt: undefined }),
      { status: 'approved', lastSeenAt: iso(T0) },
      'garbage',
      null,
    ]
    await writeFile(path.join(dir, 'trends.json'), JSON.stringify({ version: 1, trends }), 'utf8')

    const { store } = await openStore(t, { dir })
    const live = store.list({ includeSeed: false })
    assert.equal(live.length, 1)
    const [trend] = live
    assert.match(trend.id, /^yt-[0-9a-f]{10}$/, 'ID는 키워드에서 다시 만든다')
    assert.deepEqual(
      { keyword: trend.keyword, kind: trend.kind, meaning: trend.meaning, status: trend.status, meaningVerified: trend.meaningVerified, publishedAt: trend.publishedAt, lastSeenAt: trend.lastSeenAt, score: trend.score },
      { keyword: '살아 있는 말', kind: 'word', meaning: '저장돼 있던 뜻', status: 'approved', meaningVerified: true, publishedAt: iso(T0 - DAY + HOUR), lastSeenAt: iso(T0 - HOUR), score: 3.5 },
    )
    assert.deepEqual(store.latencyHours(), [1])
    await flushWrites()
    assert.deepEqual(
      (await readJsonFile(path.join(dir, 'trends.json'))).trends.map((x) => x.keyword),
      ['살아 있는 말'],
      '기한이 지난 항목과 손상된 줄은 파일에서도 지운다',
    )
  })
})

// ── 규칙 기반 추출 ──────────────────────────────────────────

describe('규칙 기반 추출', () => {
  test('차트 예시: 해시태그·겹치는 태그·따옴표·되풀이되는 두 어절에서 키워드를 뽑는다', () => {
    const drafts = extractKeywordTrends(chartVideos, { now: T0 })
    assert.deepEqual(
      drafts.map((d) => [d.keyword, d.score, d.stats.videoCount, d.source.url]),
      CHART_KEYWORDS.map(([keyword, score, count, n]) => [keyword, score, count, watchUrl(n)]),
    )
    for (const d of drafts) {
      assert.deepEqual(d, {
        key: normalizeKeyword(d.keyword),
        keyword: d.keyword,
        kind: 'keyword',
        pattern: null,
        meaning: '',
        origin: '',
        caution: '',
        category: '일상',
        source: { type: 'youtube', label: 'YouTube 인기 차트', url: d.source.url, title: null },
        stats: { videoCount: d.stats.videoCount },
        collectedAt: iso(T0),
        score: d.score,
        meaningVerified: false,
      })
    }
    assert.equal(drafts.find((d) => d.keyword === '두바이 초콜릿').key, '두바이초콜릿')
    // Date도 받는다
    assert.equal(extractKeywordTrends(chartVideos, { now: new Date(T0) })[0].collectedAt, iso(T0))
  })

  test('형식 문구·숫자·날짜·짧은 영문·자모는 후보가 되지 못한다', () => {
    const tags = ['official', 'Teaser', '1080p', 'vs', '오늘', 'youtube']
    const videos = [
      video(1, '#shorts #MV #4K #2026 #ab', tags),
      video(2, '#ㅋㅋㅋ #진짜 #제3회 #EP12 #먹방', tags),
      video(3, "'Official Teaser' “EP.3 하이라이트” 「12화 예고」 『2026.11.11』", tags),
    ]
    assert.deepEqual(extractKeywordTrends(videos, { now: T0 }), [])

    // 해시태그를 줄줄이 단 제목은 앞쪽 다섯 개만 본다
    const spam = [video(1, '#하나요 #둘이요 #셋이요 #넷이요 #다섯이요 #여섯이요 #일곱이요', [])]
    assert.deepEqual(
      extractKeywordTrends(spam, { now: T0 }).map((d) => d.keyword),
      ['넷이요', '다섯이요', '둘이요', '셋이요', '하나요'],
    )
  })

  test('길이(2~20자)를 벗어나면 버리고, 띄어 쓴 표기를 고른다', () => {
    const videos = [video(1, `#${'가'.repeat(21)} #가 #갓생살기`, ['갓생 살기']), video(2, '갓생 살기 3일 차', ['갓생살기']), video(3, '오늘도 갓생 살기 도전', [])]
    assert.deepEqual(
      extractKeywordTrends(videos, { now: T0 }).map((d) => [d.keyword, d.key, d.stats.videoCount, d.score]),
      [['갓생 살기', '갓생살기', 3, 3.5]],
    )
  })

  test('따옴표 안의 말은 그대로 두고, 낱말 속 아포스트로피는 따옴표로 보지 않는다', () => {
    const videos = [video(1, '"오늘 뭐 먹지?" 고민 끝', []), video(2, "Don't Stop 'Til You Get Enough 커버", []), video(3, '‘진짜 미쳤다’ 반응 모음', [])]
    assert.deepEqual(
      extractKeywordTrends(videos, { now: T0 }).map((d) => d.keyword),
      ['오늘 뭐 먹지', '진짜 미쳤다'],
    )
  })

  test('두세 어절 묶음: 더 긴 말의 토막은 버리고, 흔한 말은 묶인 말 안에서만 살린다', () => {
    const videos = [
      video(1, '1시간 집중 플레이리스트 🎧 비 오는 날 카페 재즈', ['재즈', '뉴스']),
      video(2, '비 오는 날 듣기 좋은 노래 모음 [Playlist]', ['비 오는 날', '뉴스']),
      video(3, '＜별의 노래＞ 메인 예고편 ｜ 12월 대개봉', ['별의 노래', '예고편', '영화']),
      video(4, '별의 노래 무대인사 현장 스케치', ['별의 노래', '무대인사', '영화']),
    ]
    // '비 오는', '오는 날'은 '비 오는 날'의 토막이라 버린다. '뉴스'·'영화'는 혼자서는 후보가 못 되지만 '별의 노래'의 '노래'는 그대로 둔다.
    assert.deepEqual(
      extractKeywordTrends(videos, { now: T0 }).map((d) => [d.keyword, d.stats.videoCount, d.score]),
      [
        ['비 오는 날', 2, 2.5],
        ['별의 노래', 2, 2.25],
      ],
    )

    const song = [video(1, '한울 - 밤편지를 쓰는 밤 (Night Letter)', []), video(2, "한울 '밤편지를 쓰는 밤' Live Clip", [])]
    assert.deepEqual(
      extractKeywordTrends(song, { now: T0 }).map((d) => [d.keyword, d.stats.videoCount]),
      [['밤편지를 쓰는 밤', 2]],
    )
  })

  test('전각 기호와 풀어 쓴 한글도 같은 말로 읽고, ㅋㅋ 같은 자모는 건드리지 않는다', () => {
    const decomposed = '얼죽아'.normalize('NFD')
    const videos = [video(1, '오늘의 간식ㅣ＃얼죽아 ｜ “얼죽아” 인증ㅋㅋㅋ', []), video(2, `${decomposed} 모임 후기 ㅠㅠ`, [decomposed])]
    const drafts = extractKeywordTrends(videos, { now: T0 })
    assert.deepEqual(
      drafts.map((d) => [d.keyword, d.key, d.stats.videoCount, d.score]),
      [['얼죽아', '얼죽아', 2, 2.5]],
    )
    assert.equal(normalizeKeyword('ＯＯＴＤ　２０２６！'), 'ootd2026')
    assert.equal(normalizeKeyword('ㅇㅈ ㅋㅋ'), 'ㅇㅈㅋㅋ')
    assert.equal(normalizeKeyword(decomposed), '얼죽아')
    for (const bad of [null, undefined, 42, {}, ['얼죽아']]) assert.equal(normalizeKeyword(bad), '')
  })

  test('거의 같은 말은 짧은 쪽으로 합치고, 절반만 겹치는 말은 따로 둔다', () => {
    const videos = [
      video(1, '영상 하나', ['두바이 초콜릿', '두바이']),
      video(2, '영상 둘', ['두바이 초콜릿', '두바이']),
      video(3, '영상 셋', ['두바이 초콜릿 케이크', '초콜릿케이크먹방']),
      video(4, '영상 넷', ['두바이 초콜릿 케이크', '초콜릿 케이크']),
    ]
    assert.deepEqual(
      extractKeywordTrends(videos, { now: T0 }).map((d) => [d.keyword, d.stats.videoCount, d.score]),
      [
        ['두바이 초콜릿', 4, 4.5],
        ['두바이', 2, 2.5],
        ['초콜릿 케이크', 2, 2.25],
      ],
    )
  })

  test('max와 이상한 입력', () => {
    assert.deepEqual(
      extractKeywordTrends(chartVideos, { now: T0, max: 3 }).map((d) => d.keyword),
      CHART_KEYWORDS.slice(0, 3).map(([keyword]) => keyword),
    )
    assert.equal(extractKeywordTrends(chartVideos, { now: T0, max: 'many' }).length, CHART_KEYWORDS.length)
    assert.equal(extractKeywordTrends(chartVideos, { now: T0, max: 0 }).length, CHART_KEYWORDS.length)

    const junk = [null, 1, 'x', {}, { title: 5, url: watchUrl(1) }, { title: '주소 없는 영상 #키워드' }, { title: '#키워드', url: 'https://evil.example/watch?v=abc' }, { title: '#키워드', url: `${watchUrl(1)}&list=x` }]
    for (const bad of [null, undefined, 'videos', 42, {}, junk]) assert.deepEqual(extractKeywordTrends(bad, { now: T0 }), [])
    // 순위를 모르는 영상은 차트 맨 끝으로 친다
    const [unranked] = extractKeywordTrends([{ title: '#얼죽아', tags: 'none', url: watchUrl(1) }], { now: T0 })
    assert.deepEqual([unranked.keyword, unranked.score], ['얼죽아', 1.001])

    for (const bad of ['yesterday', NaN, null, {}]) assert.throws(() => extractKeywordTrends(chartVideos, { now: bad }), TypeError)
  })
})

// ── LLM 추출 ──────────────────────────────────────────

describe('LLM 추출', () => {
  const answer = (overrides) => ({ keyword: '', kind: 'phrase', pattern: '', meaning: '', origin: '', caution: '', category: '일상', videoIndexes: [], isPersonOrBrand: false, sensitive: false, ...overrides })

  test('시스템 프롬프트와 스키마', () => {
    for (const rule of [/자료로만 다루세요/, /지어내지 않/, /실존 인물/, /브랜드/, /정치/, /사고·재난·범죄·죽음/, /빈 문자열/, /\{X\}/, /JSON으로만/]) assert.match(SYSTEM_PROMPT, rule)
    for (const category of TREND_CATEGORIES) assert.ok(SYSTEM_PROMPT.includes(category))

    const itemSchema = MEME_TREND_SCHEMA.properties.items.items
    for (const schema of [MEME_TREND_SCHEMA, itemSchema]) {
      assert.equal(schema.type, 'object')
      assert.equal(schema.additionalProperties, false)
      assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort())
    }
    assert.deepEqual(Object.keys(itemSchema.properties), ['keyword', 'kind', 'pattern', 'meaning', 'origin', 'caution', 'category', 'videoIndexes', 'isPersonOrBrand', 'sensitive'])
    assert.deepEqual(itemSchema.properties.category.enum, [...TREND_CATEGORIES])
    assert.deepEqual(itemSchema.properties.kind.enum, ['pattern', 'phrase', 'word', 'keyword'])
    assert.deepEqual(itemSchema.properties.videoIndexes, { type: 'array', items: { type: 'integer' } })
  })

  test('요약한 메타데이터만 보내고, 응답은 검증해서 초안으로 만든다', async () => {
    const requests = []
    const llm = {
      async generateJson(request) {
        requests.push(request)
        return {
          items: [
            answer({ keyword: '이게 되네', meaning: '안 될 줄 알았던 일이 돼서 놀랐을 때 하는 말', origin: '  먹거리 영상 제목에서 감탄사로 쓰임 ', category: '놀람', videoIndexes: [2] }),
            answer({ keyword: '얼죽아', kind: 'word', pattern: '{X} 얼죽아', videoIndexes: [5, 1, 5, 999, -1, 1.5, '1'] }),
            answer({ keyword: '붕어빵 시즌', kind: 'pattern', pattern: '{X} 시즌', category: '없는 분류', videoIndexes: [8, 9] }),
            answer({ keyword: '달빛소녀', kind: 'word', videoIndexes: [0, 4], isPersonOrBrand: true }),
            answer({ keyword: '결승', kind: 'keyword', videoIndexes: [7], sensitive: true }),
            answer({ keyword: '중꺾마', kind: 'word', meaning: '자료에 없는 말을 지어낸 항목', videoIndexes: [0, 1] }),
            answer({ keyword: '두바이 초콜릿', kind: 'word', videoIndexes: [] }),
            answer({ keyword: '얼죽아', kind: 'keyword', videoIndexes: [1] }),
            answer({ keyword: '첫눈처럼', kind: 'pattern', pattern: '{Y}처럼 {X}', videoIndexes: [0] }),
            { keyword: '별의 정원', kind: 'phrase', pattern: '', meaning: '', origin: '', caution: '', category: '일상', videoIndexes: [6] },
            answer({ keyword: 'ㅋ', videoIndexes: [1] }),
            answer({ keyword: '가'.repeat(31), videoIndexes: [1] }),
            answer({ keyword: 42, videoIndexes: [1] }),
            answer({ keyword: 'evil.example 가입', videoIndexes: [1] }),
            answer({ keyword: '얼죽아🔥', videoIndexes: [1] }),
            answer({ keyword: '붕어빵', pattern: '<b>{X}</b> 붕어빵', videoIndexes: [8] }),
            null,
            'x',
          ],
        }
      },
    }
    const filler = Array.from({ length: 150 }, (_, i) => ({
      ...video(100 + i, `채우기 영상 ${i}`, Array.from({ length: 12 }, (_, k) => `태그${k}`)),
      description: '보내면 안 되는 값',
      channelTitle: '보내면 안 되는 값',
    }))
    const drafts = await extractMemeTrends([...chartVideos, ...filler], llm, { now: T0 })

    const [request] = requests
    assert.equal(requests.length, 1)
    assert.equal(request.system, SYSTEM_PROMPT)
    assert.equal(request.schema, MEME_TREND_SCHEMA)
    assert.equal(request.purpose, 'trends')
    assert.deepEqual(Object.keys(request).sort(), ['effort', 'purpose', 'schema', 'system', 'user'])
    const payload = JSON.parse(request.user)
    assert.equal(payload.max, 20)
    assert.equal(payload.videos.length, 120)
    assert.deepEqual(payload.videos[1], { index: 1, title: CHART[1][0], tags: CHART[1][1], categoryId: '24', rank: 2 })
    assert.equal(payload.videos[10].tags.length, 8)
    assert.ok(!request.user.includes('보내면 안 되는 값'))
    assert.ok(!request.user.includes('youtube.com'))

    assert.deepEqual(
      drafts.map((d) => [d.keyword, d.kind, d.pattern, d.category, d.score, d.stats.videoCount, d.source.url]),
      [
        // 근거 영상은 모델이 든 순서(6번, 2번 영상)대로이고 출처는 그 첫 영상, 점수는 가장 높은 순위(2위) 기준
        ['얼죽아', 'word', '{X} 얼죽아', '일상', 2.3333, 2, watchUrl(6)],
        ['붕어빵 시즌', 'pattern', '{X} 시즌', '일상', 2.1, 2, watchUrl(9)],
        // {X} 말고 다른 빈칸이 섞인 문형은 버리고, 문형이 없으면 문구로 본다
        ['첫눈처럼', 'phrase', null, '일상', 1.5, 1, watchUrl(1)],
        ['이게 되네', 'phrase', null, '놀람', 1.25, 1, watchUrl(3)],
        // 마크업이 섞인 문형도 버린다(키워드는 살린다). 주소나 이모지가 섞인 키워드는 항목째 버린다.
        ['붕어빵', 'phrase', null, '일상', 1.1, 1, watchUrl(9)],
      ],
    )
    const described = drafts.find((d) => d.keyword === '이게 되네')
    assert.deepEqual(described, {
      key: '이게되네',
      keyword: '이게 되네',
      kind: 'phrase',
      pattern: null,
      meaning: '안 될 줄 알았던 일이 돼서 놀랐을 때 하는 말',
      origin: '먹거리 영상 제목에서 감탄사로 쓰임',
      caution: '',
      category: '놀람',
      source: { type: 'youtube', label: 'YouTube 인기 차트', url: watchUrl(3), title: null },
      stats: { videoCount: 1 },
      collectedAt: iso(T0),
      score: 1.25,
      meaningVerified: false,
    })

    assert.deepEqual(
      (await extractMemeTrends(chartVideos, llm, { now: T0, max: 2 })).map((d) => d.keyword),
      ['얼죽아', '붕어빵 시즌'],
    )
    assert.equal(JSON.parse(requests[1].user).max, 2)
  })

  test('LLM이 실패하거나 형식이 어긋나면 예외를 던진다', async () => {
    const failing = {
      async generateJson() {
        throw Object.assign(new Error('rate limited'), { kind: 'rate_limit' })
      },
    }
    await assert.rejects(() => extractMemeTrends(chartVideos, failing, { now: T0 }), (err) => err.kind === 'rate_limit')
    for (const result of [null, undefined, {}, { items: 'none' }, { items: {} }, 'text', []]) {
      await assert.rejects(() => extractMemeTrends(chartVideos, { generateJson: async () => result }, { now: T0 }), TypeError)
    }
    for (const llm of [null, undefined, {}, { generateJson: 'nope' }]) await assert.rejects(() => extractMemeTrends(chartVideos, llm, { now: T0 }), TypeError)
    await assert.rejects(() => extractMemeTrends(chartVideos, failing, { now: 'soon' }), TypeError)
  })

  test('영상이 없으면 모델을 부르지 않고, 고를 것이 없다는 답은 빈 목록이다', async () => {
    let calls = 0
    const llm = {
      async generateJson() {
        calls++
        return { items: [] }
      },
    }
    assert.deepEqual(await extractMemeTrends([], llm, { now: T0 }), [])
    assert.deepEqual(await extractMemeTrends(null, llm, { now: T0 }), [])
    assert.equal(calls, 0)
    assert.deepEqual(await extractMemeTrends(chartVideos, llm, { now: T0 }), [])
    assert.equal(calls, 1)
  })
})

// ── 인스타그램 반응 확인 ──────────────────────────────────────────

describe('인스타그램 반응 확인', () => {
  const TOKEN = 'EAAG-secret-token-0123456789'
  const USER_ID = '17841400000000001'

  /** 해시태그 검색과 인기 게시물 조회에 답하는 가짜 Graph API */
  function graphApi({ media = 50 } = {}) {
    const ids = new Map()
    const idFor = (tag) => {
      if (!ids.has(tag)) ids.set(tag, `1784385745${String(ids.size).padStart(6, '0')}`)
      return ids.get(tag)
    }
    const fetchImpl = fakeFetch(({ url }) => {
      if (url.pathname.endsWith('/ig_hashtag_search')) return jsonResponse(200, { data: [{ id: idFor(url.searchParams.get('q')) }] })
      if (url.pathname.endsWith('/top_media')) {
        const data = Array.from({ length: media }, (_, i) => ({ id: `1790000000${String(i).padStart(6, '0')}`, media_type: 'IMAGE', comments_count: 3, like_count: 10, timestamp: '2026-11-10T22:36:43+0000' }))
        return jsonResponse(200, { data, paging: { cursors: { after: 'NTAy' }, next: `https://graph.facebook.com/v27.0/next?access_token=${TOKEN}&after=NTAy` } })
      }
      return jsonResponse(404, { error: { message: 'unknown path', code: 100 } })
    })
    return { fetchImpl, idFor }
  }

  const fullBudget = { used: 0, limit: 30, windowDays: 7, remaining: 30 }

  test('normalizeTag: 조회할 수 있는 이름만 통과한다', () => {
    assert.equal(normalizeTag('#먹방'), '먹방')
    assert.equal(normalizeTag('  ##두바이 초콜릿 '), '두바이초콜릿')
    assert.equal(normalizeTag('OOTD_Daily2026'), 'ootd_daily2026')
    assert.equal(normalizeTag('먹방'.normalize('NFD')), '먹방')
    assert.equal(normalizeTag('가'.repeat(100)), '가'.repeat(100))
    for (const bad of ['', '   ', '#', '먹방🔥', '1️⃣등', '🇰🇷', '얼죽아!', 'a-b', 'a.b', '태그/이름', '~는 못 참지', '가'.repeat(101), 'x'.repeat(5000), null, undefined, 42, {}, ['먹방']]) {
      assert.equal(normalizeTag(bad), null)
    }
  })

  test('토큰·계정 ID·장부 파일이 없으면 꺼져 있고, 아무 요청도 보내지 않는다', async (t) => {
    const ledgerFile = path.join(await tempDir(t), 'ig.json')
    const { fetchImpl } = graphApi()
    const incomplete = [{ accessToken: '' }, { accessToken: undefined }, { userId: '' }, { userId: 'not-a-number' }, { userId: `${USER_ID}/../me` }, { ledgerFile: undefined }]
    for (const overrides of incomplete) {
      const client = createInstagramClient({ accessToken: TOKEN, userId: USER_ID, ledgerFile, fetchImpl, ...overrides })
      assert.equal(client.enabled, false)
      assert.equal(await client.checkHashtag('먹방'), null)
      assert.deepEqual(await client.budget(), fullBudget)
    }
    assert.equal(fetchImpl.calls.length, 0)
    assert.throws(() => createInstagramClient({ accessToken: TOKEN, userId: USER_ID, ledgerFile, fetchImpl: null }), TypeError)
    assert.equal(createInstagramClient().enabled, false)
  })

  test('해시태그 확인: 검색 → 인기 게시물 한 쪽, 개수만 남긴다', async (t) => {
    const ledgerFile = path.join(await tempDir(t), 'ig.json')
    const { fetchImpl, idFor } = graphApi({ media: 37 })
    const client = createInstagramClient({ accessToken: TOKEN, userId: USER_ID, apiVersion: 'v27.0', fetchImpl, ledgerFile, now: clock() })
    assert.equal(client.enabled, true)
    assert.deepEqual(await client.budget(), fullBudget)

    const result = await client.checkHashtag('#두바이 초콜릿')
    assert.deepEqual(result, { tag: '두바이초콜릿', hashtagId: idFor('두바이초콜릿'), mediaCount: 37, checkedAt: iso(T0) })

    assert.equal(fetchImpl.calls.length, 2, 'paging.next는 따라가지 않는다')
    const [search, top] = fetchImpl.calls
    assert.equal(search.url.origin + search.url.pathname, 'https://graph.facebook.com/v27.0/ig_hashtag_search')
    assert.deepEqual(Object.fromEntries(search.url.searchParams), { user_id: USER_ID, q: '두바이초콜릿', access_token: TOKEN })
    assert.equal(top.url.origin + top.url.pathname, `https://graph.facebook.com/v27.0/${idFor('두바이초콜릿')}/top_media`)
    // 캡션·미디어 주소·퍼머링크는 요청하지 않는다
    assert.deepEqual(Object.fromEntries(top.url.searchParams), { user_id: USER_ID, fields: 'id,media_type,comments_count,like_count,timestamp', limit: '50', access_token: TOKEN })
    assert.ok(search.init.signal instanceof AbortSignal)

    await flushWrites()
    const ledgerText = await readFile(ledgerFile, 'utf8')
    assert.ok(!ledgerText.includes(TOKEN), '장부에 토큰을 적지 않는다')
    assert.ok(!JSON.stringify(result).includes(TOKEN))
    assert.deepEqual(await client.budget(), { used: 1, limit: 30, windowDays: 7, remaining: 29 })
    assert.equal(client.lastError, null)
  })

  test('API 버전은 항상 적어 보내고, 형식이 이상하면 기본 버전을 쓴다', async (t) => {
    const dir = await tempDir(t)
    const versions = [
      ['v26.0', '/v26.0/'],
      ['latest', '/v27.0/'],
      [undefined, '/v27.0/'],
      ['v27.0/../v1.0', '/v27.0/'],
    ]
    for (const [apiVersion, prefix] of versions) {
      const { fetchImpl } = graphApi()
      const client = createInstagramClient({ accessToken: TOKEN, userId: USER_ID, apiVersion, fetchImpl, ledgerFile: path.join(dir, `ig-${prefix.length}-${String(apiVersion).length}.json`), now: clock() })
      assert.ok(await client.checkHashtag('먹방'))
      assert.ok(fetchImpl.calls.every((call) => call.url.pathname.startsWith(prefix)))
    }
  })

  test('7일 동안 서로 다른 해시태그 30개를 넘기지 않는다(재시작·창 만료 포함)', async (t) => {
    const ledgerFile = path.join(await tempDir(t), 'ig.json')
    const now = clock()
    const { fetchImpl } = graphApi()
    const open = () => createInstagramClient({ accessToken: TOKEN, userId: USER_ID, fetchImpl, ledgerFile, now })
    let client = open()

    // 태그 i는 T0 + (i+1)분에 처음 조회한다
    for (let i = 0; i < 30; i++) {
      now.advance(MINUTE)
      assert.ok(await client.checkHashtag(`태그${i}`), `태그${i}`)
    }
    assert.deepEqual(await client.budget(), { used: 30, limit: 30, windowDays: 7, remaining: 0 })
    assert.equal(fetchImpl.calls.length, 60)

    // 31번째 새 태그는 요청을 보내지 않고 null
    assert.equal(await client.checkHashtag('새태그'), null)
    assert.equal(fetchImpl.calls.length, 60)

    // 프로세스를 다시 띄워도 장부는 이어진다
    await flushWrites()
    client = open()
    assert.equal((await client.budget()).used, 30)
    assert.equal(await client.checkHashtag('또다른태그'), null)
    assert.equal(fetchImpl.calls.length, 60)

    // 이미 조회한 태그를 다시 묻는 것은 칸을 쓰지 않는다: 한 시간 안에는 적어 둔 결과를 돌려주고,
    const cached = await client.checkHashtag('태그0')
    assert.equal(cached.checkedAt, iso(T0 + MINUTE))
    assert.equal(fetchImpl.calls.length, 60)
    // 그 뒤에는 인기 게시물만 다시 센다(해시태그 ID는 다시 찾지 않는다)
    now.advance(2 * HOUR)
    const fresh = await client.checkHashtag('#태그0')
    assert.equal(fresh.checkedAt, iso(now()))
    assert.equal(fetchImpl.calls.length, 61)
    assert.ok(fetchImpl.calls.at(-1).url.pathname.endsWith('/top_media'))
    assert.equal((await client.budget()).used, 30)

    // 다시 물어도 기한은 늘지 않는다: 태그0의 칸은 처음 조회한 때부터 7일(+시계 오차 여유 5분) 뒤에 풀린다
    now.set(T0 + MINUTE + 7 * DAY + 5 * MINUTE - 1)
    assert.equal((await client.budget()).used, 30)
    assert.equal(await client.checkHashtag('새태그'), null)
    now.advance(1)
    assert.equal((await client.budget()).used, 29)
    assert.ok(await client.checkHashtag('새태그'))
    assert.equal((await client.budget()).used, 30)
    assert.equal(await client.checkHashtag('하나더'), null)
    // 1분 뒤에는 태그1의 칸이 풀린다
    now.advance(MINUTE)
    assert.deepEqual(await client.budget(), { used: 29, limit: 30, windowDays: 7, remaining: 1 })
    // 한참 뒤에는 모두 풀린다
    now.advance(8 * DAY)
    assert.deepEqual(await client.budget(), fullBudget)
  })

  test('창이 끝나 갈 때 다시 조회하면 새 조회로 센다(시계 오차 대비)', async (t) => {
    const ledgerFile = path.join(await tempDir(t), 'ig.json')
    const now = clock()
    const { fetchImpl } = graphApi()
    const client = createInstagramClient({ accessToken: TOKEN, userId: USER_ID, fetchImpl, ledgerFile, now })
    assert.ok(await client.checkHashtag('먹방'))
    now.set(T0 + 7 * DAY - MINUTE)
    assert.ok(await client.checkHashtag('먹방'))
    assert.equal(fetchImpl.calls.length, 3, 'ID는 그대로 쓰고 인기 게시물만 다시 센다')
    // 처음 잡은 칸의 기한은 지났지만, 끝나기 직전의 조회가 Meta 쪽에서 새 창으로 잡혔을 수 있으므로 칸을 유지한다
    now.set(T0 + 7 * DAY + 10 * MINUTE)
    assert.equal((await client.budget()).used, 1)
    now.set(T0 + 14 * DAY + 5 * MINUTE)
    assert.equal((await client.budget()).used, 0)
  })

  test('동시에 몰려도 30칸을 넘지 않고, 한도는 계정마다 따로 센다', async (t) => {
    const ledgerFile = path.join(await tempDir(t), 'ig.json')
    const now = clock()
    const { fetchImpl } = graphApi()
    const client = createInstagramClient({ accessToken: TOKEN, userId: USER_ID, fetchImpl, ledgerFile, now })
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => client.checkHashtag(`동시${i}`)))
    assert.equal(results.filter(Boolean).length, 30)
    assert.deepEqual(results.slice(30), Array(10).fill(null))
    assert.equal(fetchImpl.calls.length, 60)
    assert.equal((await client.budget()).remaining, 0)

    const other = createInstagramClient({ accessToken: TOKEN, userId: '17841400000000002', fetchImpl, ledgerFile, now })
    assert.deepEqual(await other.budget(), fullBudget)
    assert.ok(await other.checkHashtag('동시0'))
    assert.equal((await other.budget()).used, 1)
    assert.equal((await client.budget()).used, 30)
  })

  test('토큰·권한 문제면 null을 돌려주고 스스로 꺼진다', async (t) => {
    const ledgerFile = path.join(await tempDir(t), 'ig.json')
    const fetchImpl = fakeFetch(() => jsonResponse(400, { error: { message: `Error validating access token ${TOKEN}`, type: 'OAuthException', code: 190, error_subcode: 463, fbtrace_id: 'trace' } }))
    const client = createInstagramClient({ accessToken: TOKEN, userId: USER_ID, fetchImpl, ledgerFile, now: clock() })
    assert.equal(await client.checkHashtag('먹방'), null)
    assert.equal(client.enabled, false)
    assert.deepEqual(client.lastError, { kind: 'auth', code: 190, subcode: 463, at: iso(T0) })
    assert.equal(await client.checkHashtag('다른태그'), null)
    assert.equal(fetchImpl.calls.length, 1, '꺼진 뒤에는 보내지 않는다')
    // 실패한 조회가 한도에 드는지는 문서에 없어, 쓴 것으로 센다
    assert.equal((await client.budget()).used, 1)

    for (const code of [10, 102, 200, 299, 368]) {
      const denied = createInstagramClient({ accessToken: TOKEN, userId: USER_ID, fetchImpl: fakeFetch(() => jsonResponse(403, { error: { code } })), ledgerFile, now: clock() })
      assert.equal(await denied.checkHashtag(`권한${code}`), null)
      assert.equal(denied.enabled, false, `code ${code}`)
      assert.deepEqual(denied.lastError, { kind: 'auth', code, subcode: null, at: iso(T0) })
    }
  })

  test('호출 한도에 걸리면 한 시간 쉰다', async (t) => {
    const ledgerFile = path.join(await tempDir(t), 'ig.json')
    const now = clock()
    const { fetchImpl: working } = graphApi()
    let limited = true
    const fetchImpl = fakeFetch(({ url }) => (limited ? jsonResponse(400, { error: { code: 4, error_subcode: 2207051 } }) : working(url.href)))
    const client = createInstagramClient({ accessToken: TOKEN, userId: USER_ID, fetchImpl, ledgerFile, now })

    assert.equal(await client.checkHashtag('먹방'), null)
    assert.equal(client.enabled, true)
    assert.deepEqual(client.lastError, { kind: 'rate_limited', code: 4, subcode: 2207051, at: iso(T0) })
    limited = false
    now.advance(59 * MINUTE)
    assert.equal(await client.checkHashtag('다른태그'), null)
    assert.equal(fetchImpl.calls.length, 1, '쉬는 동안에는 보내지 않는다')
    now.advance(MINUTE)
    assert.ok(await client.checkHashtag('다른태그'))
    assert.ok(await client.checkHashtag('먹방'), '실패했던 태그도 한 시간 뒤에는 다시 묻는다')
    assert.equal((await client.budget()).used, 2)

    const tooMany = createInstagramClient({ accessToken: TOKEN, userId: USER_ID, fetchImpl: fakeFetch(() => jsonResponse(429, {})), ledgerFile, now })
    assert.equal(await tooMany.checkHashtag('세번째'), null)
    assert.equal(tooMany.lastError.kind, 'rate_limited')
  })

  test('연결 실패·이상한 응답·없는 태그에도 예외를 던지지 않고, 어디에도 토큰을 남기지 않는다', async (t) => {
    const dir = await tempDir(t)
    const now = clock()
    const leak = `https://graph.facebook.com/v27.0/ig_hashtag_search?access_token=${TOKEN}`
    const notFound = { error: { message: `no hashtag (${leak})`, code: 24, error_user_title: 'Could not find a matching hashtag' } }
    const cases = [
      ['network', null, async () => Promise.reject(new TypeError(`fetch failed: ${leak}`))],
      ['network', null, async () => Promise.reject(new DOMException('timeout', 'TimeoutError'))],
      ['bad_response', null, async () => ({ status: 200, json: async () => Promise.reject(new SyntaxError('Unexpected token <')) })],
      ['unavailable', 24, async () => jsonResponse(400, notFound)],
      ['unavailable', null, async () => jsonResponse(500, null)],
      ['unavailable', null, async () => jsonResponse(200, { data: [] })],
      ['unavailable', null, async () => jsonResponse(200, { data: [{ id: 'not-a-number' }] })],
    ]
    for (const [index, [kind, code, respond]] of cases.entries()) {
      const fetchImpl = fakeFetch(respond)
      const ledgerFile = path.join(dir, `ig-${index}.json`)
      const client = createInstagramClient({ accessToken: TOKEN, userId: USER_ID, fetchImpl, ledgerFile, now })
      assert.equal(await client.checkHashtag('먹방'), null)
      assert.deepEqual(client.lastError, { kind, code, subcode: null, at: iso(T0) })
      assert.equal(client.enabled, true)
      // 실패한 태그는 한 시간 동안 다시 묻지 않는다
      assert.equal(await client.checkHashtag('먹방'), null)
      assert.equal(fetchImpl.calls.length, 1)
      await flushWrites()
      assert.ok(!`${JSON.stringify(client.lastError)}${await readFile(ledgerFile, 'utf8')}`.includes(TOKEN))
    }

    // 검색 응답이 { id } 꼴이어도 읽고, 인기 게시물 응답이 이상하면 null
    const bare = fakeFetch(({ url }) => (url.pathname.endsWith('/ig_hashtag_search') ? jsonResponse(200, { id: '17873440459141021' }) : jsonResponse(200, { data: 'nope' })))
    const client = createInstagramClient({ accessToken: TOKEN, userId: USER_ID, fetchImpl: bare, ledgerFile: path.join(dir, 'ig-bare.json'), now })
    assert.equal(await client.checkHashtag('먹방'), null)
    assert.equal(bare.calls.length, 2)
    assert.equal(bare.calls[1].url.pathname, '/v27.0/17873440459141021/top_media')
    assert.equal(client.lastError.kind, 'bad_response')

    // 게시물이 하나도 없는 태그는 0개로 확인된 것이다
    const { fetchImpl: empty } = graphApi({ media: 0 })
    const quietTag = createInstagramClient({ accessToken: TOKEN, userId: USER_ID, fetchImpl: empty, ledgerFile: path.join(dir, 'ig-empty.json'), now })
    assert.equal((await quietTag.checkHashtag('조용한태그')).mediaCount, 0)

    for (const bad of [null, undefined, 42, {}, '', '먹방🔥']) assert.equal(await quietTag.checkHashtag(bad), null)
    assert.equal(empty.calls.length, 2)
  })

  test('장부를 읽을 수 없으면 조회하지 않는다', async (t) => {
    const dir = await tempDir(t)
    const broken = ['not json', '{"slots": "nope"}', '{"slots": [{"bogus": true}]}', 'null']
    for (const [index, content] of broken.entries()) {
      const ledgerFile = path.join(dir, `ig-${index}.json`)
      await writeFile(ledgerFile, content, 'utf8')
      const { fetchImpl } = graphApi()
      const client = createInstagramClient({ accessToken: TOKEN, userId: USER_ID, fetchImpl, ledgerFile, now: clock() })
      assert.equal(await client.checkHashtag('먹방'), null)
      assert.equal(fetchImpl.calls.length, 0)
      assert.equal(client.lastError.kind, 'ledger')
      assert.deepEqual(await client.budget(), { used: 30, limit: 30, windowDays: 7, remaining: 0 })
      assert.equal(await readFile(ledgerFile, 'utf8'), content, '읽지 못한 장부를 덮어쓰지 않는다')
    }
  })
})

// ── 파이프라인 ──────────────────────────────────────────

describe('수집 파이프라인', () => {
  const allowAll = { checkTrend: () => ({ ok: true, level: 'ok', categories: [] }) }
  const legacyError = (code, reason) => ({ error: { code, message: 'upstream', errors: [{ domain: 'global', reason, message: 'upstream' }] } })
  const chartPage = jsonResponse(200, { items: chartItems })

  function testConfig(dir, { youtube = {}, trends = {}, instagram = {} } = {}) {
    return {
      dataDir: dir,
      youtube: { apiKey: API_KEY, regionCode: 'KR', categoryIds: ['0'], maxResults: 50, ...youtube },
      trends: { refreshMinutes: 30, reviewMode: 'manual', ttlDays: 7, maxPerRun: 30, ...trends },
      instagram: { maxHashtagsPerRun: 3, ...instagram },
    }
  }

  /** 분류 번호('0' = 전체 차트)별로 답을 정해 두는 가짜 YouTube API. 답이 배열이면 부를 때마다 하나씩 꺼낸다. */
  function chartApi(byCategory) {
    return fakeFetch(({ url }) => {
      const answer = byCategory[url.searchParams.get('videoCategoryId') ?? '0']
      return Array.isArray(answer) ? answer.shift() : answer
    })
  }

  const requestedCategories = (fetchImpl) => fetchImpl.calls.map((call) => call.url.searchParams.get('videoCategoryId') ?? '0')

  /** 임시 폴더에 저장소·YouTube 클라이언트·파이프라인을 조립한다 */
  async function setup(t, { byCategory = { 0: chartPage }, config = {}, ledger = false, ...deps } = {}) {
    const dir = await tempDir(t)
    const now = clock()
    const store = createTrendStore({ dataDir: dir, seedPath: SEED_PATH, now })
    await store.init()
    const fetchImpl = chartApi(byCategory)
    const quotaLedger = ledger ? createQuotaLedger({ file: path.join(dir, 'youtube-quota.json'), dailyBudget: 100, now }) : null
    const youtube = createYouTubeClient({ apiKey: API_KEY, fetchImpl, ledger: quotaLedger })
    const settings = testConfig(dir, config)
    const pipeline = createTrendPipeline({ config: settings, store, youtube, safety: allowAll, log: quiet, now, retryDelayMs: 0, ...deps })
    return { dir, now, store, fetchImpl, youtube, pipeline, config: settings }
  }

  const liveKeywords = (store, status = 'pending') => store.list({ status, includeSeed: false }).map((trend) => trend.keyword)
  // 예시 데이터에 이미 있는 '붕어빵'은 저장하지 않는다
  const STORED_KEYWORDS = CHART_KEYWORDS.map(([keyword]) => keyword).filter((keyword) => keyword !== '붕어빵')

  test('수집 한 번: 차트 → 추출 → 필터 → 저장, 그리고 실행 기록', async (t) => {
    const logs = []
    const record = (...args) => logs.push(args.map(String).join(' '))
    const { dir, now, store, fetchImpl, pipeline } = await setup(t, {
      ledger: true,
      config: { youtube: { categoryIds: ['0', '10'] } },
      // 음악 차트에는 전체 차트의 1위·5위 영상이 1·2위로 다시 나오고, 새 영상이 하나 있다
      byCategory: { 0: chartPage, 10: jsonResponse(200, { items: [chartItems[0], chartItems[4], item(11, '새 영상 #얼죽아', ['얼죽아'])] }) },
      log: { info: record, warn: record, error: record },
    })
    assert.deepEqual(pipeline.status(), { enabled: true, running: false, lastRun: null, nextRunAt: null, quota: { day: T0_QUOTA_DAY, used: 0, budget: 100 } })

    const report = await pipeline.runOnce()
    assert.deepEqual(report, {
      startedAt: iso(T0),
      finishedAt: iso(T0),
      trigger: 'manual',
      ok: true,
      videos: 11,
      drafts: 7,
      blocked: 0,
      added: 6,
      updated: 0,
      purged: 0,
      extractor: 'rules',
      igChecked: 0,
      errors: [],
      unitsUsed: 2,
    })
    assert.deepEqual(requestedCategories(fetchImpl), ['0', '10'])

    // 검수 방식이 manual이면 대기 목록에만 들어간다
    assert.ok(store.list().every((trend) => trend.sample))
    const pending = store.list({ status: 'pending', includeSeed: false })
    assert.deepEqual(
      pending.map((trend) => [trend.keyword, trend.score, trend.stats.videoCount]),
      [
        ['얼죽아', 3.3333, 3],
        ['달빛소녀', 2.5, 2],
        ['두바이 초콜릿', 2.25, 2],
        ['첫눈처럼', 1.5, 1],
        ['이게 되네', 1.25, 1],
        ['별의 정원', 1.125, 1],
      ],
    )
    // 통계(조회수 등)는 어디에도 없다
    for (const trend of pending) assert.deepEqual(Object.keys(trend.stats), ['videoCount'])

    const status = pipeline.status()
    assert.deepEqual(status, { enabled: true, running: false, lastRun: report, nextRunAt: null, quota: { day: T0_QUOTA_DAY, used: 2, budget: 100 } })
    await flushWrites()
    assert.deepEqual(await readJsonFile(path.join(dir, 'trend-runs.json')), { runs: [report] })

    // 로그에는 개수만 남긴다
    assert.ok(logs.length > 0)
    for (const line of logs) {
      assert.ok(!line.includes(API_KEY))
      for (const keyword of STORED_KEYWORDS) assert.ok(!line.includes(keyword), line)
    }

    // 다음 수집에서 같은 키워드는 갱신만 한다
    now.advance(3 * HOUR)
    const second = await pipeline.runOnce({ trigger: 'schedule' })
    assert.deepEqual(
      { startedAt: second.startedAt, trigger: second.trigger, ok: second.ok, added: second.added, updated: second.updated, unitsUsed: second.unitsUsed },
      { startedAt: iso(T0 + 3 * HOUR), trigger: 'schedule', ok: true, added: 0, updated: 6, unitsUsed: 2 },
    )
    assert.equal(store.get(pending[0].id).lastSeenAt, iso(T0 + 3 * HOUR))
    assert.equal(pipeline.status().quota.used, 4)
    assert.equal((await pipeline.runOnce({ trigger: 'DROP TABLE' })).trigger, 'manual')
  })

  test('검수 방식이 auto면 필터를 통과한 키워드를 바로 노출한다', async (t) => {
    const { store, pipeline } = await setup(t, { config: { trends: { reviewMode: 'auto' } } })
    const report = await pipeline.runOnce()
    assert.equal(report.added, 6)
    assert.deepEqual(liveKeywords(store, 'approved'), STORED_KEYWORDS)
    assert.deepEqual(
      store
        .list()
        .slice(0, 6)
        .map((trend) => trend.keyword),
      STORED_KEYWORDS,
    )
    assert.deepEqual(store.latencyHours(), [0, 0, 0, 0, 0, 0])
  })

  test('YouTube 키가 없으면 아무것도 하지 않고 이유만 알려 준다', async (t) => {
    const dir = await tempDir(t)
    const now = clock()
    const store = createTrendStore({ dataDir: dir, seedPath: SEED_PATH, now })
    await store.init()
    const untouchable = {
      mostPopular: async () => {
        throw new Error('호출되면 안 된다')
      },
    }
    const cases = [
      { config: testConfig(dir, { youtube: { apiKey: '' } }), youtube: null },
      { config: testConfig(dir), youtube: null },
      { config: testConfig(dir, { youtube: { apiKey: '' } }), youtube: untouchable },
      { config: { dataDir: dir }, youtube: untouchable },
    ]
    for (const { config, youtube } of cases) {
      const pipeline = createTrendPipeline({ config, store, youtube, safety: allowAll, log: quiet, now })
      const report = await pipeline.runOnce({ trigger: 'manual' })
      assert.deepEqual(report, {
        startedAt: iso(T0),
        finishedAt: iso(T0),
        trigger: 'manual',
        ok: false,
        videos: 0,
        drafts: 0,
        blocked: 0,
        added: 0,
        updated: 0,
        purged: 0,
        extractor: 'none',
        igChecked: 0,
        errors: [NO_KEY_MESSAGE],
        unitsUsed: 0,
      })
      pipeline.start()
      assert.deepEqual(pipeline.status(), { enabled: false, running: false, lastRun: null, nextRunAt: null, quota: null })
      pipeline.stop()
    }
    await flushWrites()
    await assert.rejects(access(path.join(dir, 'trend-runs.json')), '실행 기록도 남기지 않는다')
    await assert.rejects(access(path.join(dir, 'trends.json')))
  })

  test('필수 의존성이 없으면 만들 때 알려 준다', async (t) => {
    const dir = await tempDir(t)
    const store = createTrendStore({ dataDir: dir })
    assert.throws(() => createTrendPipeline(), TypeError)
    assert.throws(() => createTrendPipeline({ config: {}, store, safety: allowAll }), TypeError)
    assert.throws(() => createTrendPipeline({ config: testConfig(dir), store: null, safety: allowAll }), TypeError)
    assert.throws(() => createTrendPipeline({ config: testConfig(dir), store: {}, safety: allowAll }), TypeError)
    assert.throws(() => createTrendPipeline({ config: testConfig(dir), store }), TypeError)
    assert.throws(() => createTrendPipeline({ config: testConfig(dir), store, safety: {} }), TypeError)
  })

  test('LLM이 준비돼 있으면 LLM 추출을 쓰고, 실패하면 규칙 기반으로 되돌아간다', async (t) => {
    const item0 = { keyword: '이게 되네', kind: 'phrase', pattern: '', meaning: '안 될 줄 알았던 일이 됐을 때 하는 말', origin: '', caution: '', category: '놀람', videoIndexes: [2], isPersonOrBrand: false, sensitive: false }
    const requests = []
    const working = {
      available: () => true,
      async generateJson(request) {
        requests.push(request)
        return { items: [item0] }
      },
    }
    const first = await setup(t, { llm: working })
    const report = await first.pipeline.runOnce()
    assert.deepEqual(
      { ok: report.ok, extractor: report.extractor, drafts: report.drafts, added: report.added, errors: report.errors },
      { ok: true, extractor: 'llm', drafts: 1, added: 1, errors: [] },
    )
    assert.equal(JSON.parse(requests[0].user).max, 30)
    const [trend] = first.store.list({ status: 'pending', includeSeed: false })
    assert.deepEqual(
      { keyword: trend.keyword, kind: trend.kind, meaning: trend.meaning, category: trend.category, meaningVerified: trend.meaningVerified, url: trend.source.url },
      { keyword: '이게 되네', kind: 'phrase', meaning: item0.meaning, category: '놀람', meaningVerified: false, url: watchUrl(3) },
    )

    const warnings = []
    const broken = {
      available: () => true,
      async generateJson() {
        throw Object.assign(new Error('비밀이 섞였을지 모르는 오류 문구'), { kind: 'rate_limit' })
      },
    }
    const second = await setup(t, { llm: broken, log: { ...quiet, warn: (...args) => warnings.push(args.join(' ')) } })
    const fallback = await second.pipeline.runOnce()
    assert.deepEqual(
      { ok: fallback.ok, extractor: fallback.extractor, drafts: fallback.drafts, added: fallback.added, errors: fallback.errors },
      { ok: true, extractor: 'rules', drafts: 7, added: 6, errors: ['AI 추출에 실패해 규칙 기반 추출로 대신했습니다.'] },
    )
    assert.deepEqual(liveKeywords(second.store), STORED_KEYWORDS)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /rate_limit/)
    assert.ok(!warnings[0].includes('비밀'), '오류 문구는 로그에 옮기지 않는다')

    // 준비되지 않은 LLM은 부르지 않는다
    const idle = {
      available: () => false,
      async generateJson() {
        throw new Error('호출되면 안 된다')
      },
    }
    const third = await setup(t, { llm: idle })
    const quietRun = await third.pipeline.runOnce()
    assert.deepEqual({ extractor: quietRun.extractor, errors: quietRun.errors }, { extractor: 'rules', errors: [] })
  })

  test('금칙어 필터에 걸린 초안은 저장하지 않고 개수만 센다', async (t) => {
    const blockedKeywords = new Set(['달빛소녀', '이게 되네'])
    const seen = []
    const safety = {
      checkTrend(draft) {
        seen.push(draft.keyword)
        return blockedKeywords.has(draft.keyword) ? { ok: false, level: 'block', categories: ['real_person'] } : { ok: true, level: 'caution', categories: ['other'] }
      },
    }
    const { store, pipeline } = await setup(t, { safety })
    const report = await pipeline.runOnce()
    assert.deepEqual({ ok: report.ok, drafts: report.drafts, blocked: report.blocked, added: report.added }, { ok: true, drafts: 7, blocked: 2, added: 4 })
    assert.deepEqual(
      seen,
      CHART_KEYWORDS.map(([keyword]) => keyword),
    )
    assert.deepEqual(
      liveKeywords(store),
      STORED_KEYWORDS.filter((keyword) => !blockedKeywords.has(keyword)),
    )
    assert.ok(!JSON.stringify(report).includes('달빛소녀'), '걸린 말은 보고서에 싣지 않는다')

    // 판정을 제대로 돌려주지 않는 필터는 통과로 치지 않는다
    for (const verdict of [undefined, null, {}, { ok: 'yes' }, true]) {
      const unclear = await setup(t, { safety: { checkTrend: () => verdict } })
      const blocked = await unclear.pipeline.runOnce()
      assert.deepEqual({ drafts: blocked.drafts, blocked: blocked.blocked, added: blocked.added }, { drafts: 7, blocked: 7, added: 0 })
      assert.deepEqual(liveKeywords(unclear.store), [])
    }
  })

  test('필터가 고장 나면 아무것도 저장하지 않고 실패로 끝낸다(예외는 던지지 않는다)', async (t) => {
    const errors = []
    const safety = {
      checkTrend() {
        throw new Error('filter bug')
      },
    }
    const { store, pipeline, dir } = await setup(t, { safety, log: { ...quiet, error: (...args) => errors.push(args) } })
    const report = await pipeline.runOnce()
    assert.deepEqual(
      { ok: report.ok, videos: report.videos, added: report.added, errors: report.errors, unitsUsed: report.unitsUsed },
      { ok: false, videos: 10, added: 0, errors: ['수집 중 예상하지 못한 오류가 났습니다. 서버 로그를 확인해 주세요.'], unitsUsed: 1 },
    )
    assert.equal(store.stats().live, 0)
    assert.equal(errors.length, 1)
    await flushWrites()
    assert.equal((await readJsonFile(path.join(dir, 'trend-runs.json'))).runs.length, 1)
  })

  test('maxPerRun: 필터를 통과한 것 가운데 점수 높은 순으로 자른다', async (t) => {
    const safety = { checkTrend: (draft) => ({ ok: draft.keyword !== '달빛소녀', level: 'ok', categories: [] }) }
    const { store, pipeline } = await setup(t, { safety, config: { trends: { maxPerRun: 2 } } })
    const report = await pipeline.runOnce()
    // 필터에서 빠질 몫을 감안해 두 배(4개)를 뽑은 뒤 2개만 남긴다
    assert.deepEqual({ drafts: report.drafts, blocked: report.blocked, added: report.added }, { drafts: 4, blocked: 1, added: 2 })
    assert.deepEqual(liveKeywords(store), ['얼죽아', '두바이 초콜릿'])
  })

  test('동시에 두 번 불러도 한 번만 돈다', async (t) => {
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const { fetchImpl, pipeline } = await setup(t, { byCategory: { 0: [gate.then(() => chartPage), chartPage] } })
    const first = pipeline.runOnce({ trigger: 'manual' })
    const second = pipeline.runOnce({ trigger: 'schedule' })
    assert.equal(first, second, '돌고 있는 실행의 프라미스를 그대로 돌려준다')
    assert.equal(pipeline.status().running, true)
    release()
    const [a, b] = await Promise.all([first, second])
    assert.equal(a, b)
    assert.equal(a.trigger, 'manual')
    assert.equal(fetchImpl.calls.length, 1)
    assert.equal(pipeline.status().running, false)

    // 끝난 뒤에는 새로 돈다
    const third = await pipeline.runOnce()
    assert.notEqual(third, a)
    assert.equal(fetchImpl.calls.length, 2)
    assert.deepEqual({ added: a.added, updated: a.updated }, { added: 6, updated: 0 })
    assert.deepEqual({ added: third.added, updated: third.updated }, { added: 0, updated: 6 })
  })

  test('할당량·키 오류는 수집을 멈추고, 그 밖의 오류는 그 분류만 건너뛴다', async (t) => {
    const { store, fetchImpl, pipeline } = await setup(t, {
      ledger: true,
      config: { youtube: { categoryIds: ['0', '10', '20', '22'] } },
      byCategory: { 0: chartPage, 10: jsonResponse(400, legacyError(400, 'invalidParameter')), 20: jsonResponse(403, legacyError(403, 'quotaExceeded')), 22: chartPage },
    })
    const report = await pipeline.runOnce()
    assert.deepEqual(requestedCategories(fetchImpl), ['0', '10', '20'], '할당량이 떨어지면 남은 분류는 묻지 않는다')
    assert.deepEqual(
      { ok: report.ok, videos: report.videos, extractor: report.extractor, added: report.added, unitsUsed: report.unitsUsed },
      // 멈추기 전에 받아 둔 차트는 버리지 않고 반영한다
      { ok: false, videos: 10, extractor: 'rules', added: 6, unitsUsed: 3 },
    )
    assert.deepEqual(report.errors, [
      '분류 10 차트: YouTube API가 요청을 받아들이지 않았습니다. (invalidParameter)',
      '분류 20 차트: YouTube API 하루 할당량을 모두 썼습니다. 태평양 시간 자정에 다시 채워집니다. (quotaExceeded)',
    ])
    assert.deepEqual(liveKeywords(store), STORED_KEYWORDS)

    // 같은 날 다시 돌리면 요청을 보내지 않고 바로 멈춘다
    const again = await pipeline.runOnce()
    assert.equal(fetchImpl.calls.length, 3)
    assert.deepEqual(
      { ok: again.ok, videos: again.videos, extractor: again.extractor, unitsUsed: again.unitsUsed, errors: again.errors },
      { ok: false, videos: 0, extractor: 'none', unitsUsed: 0, errors: ['전체 차트: 오늘 쓰기로 정한 YouTube API 예산을 모두 썼습니다. 태평양 시간 자정이 지나면 다시 수집합니다. (budgetExceeded)'] },
    )
  })

  test('잘못된 키면 첫 요청에서 멈춘다', async (t) => {
    const invalidKey = { error: { code: 400, message: 'upstream', errors: [{ reason: 'badRequest' }], details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }] } }
    const { fetchImpl, pipeline } = await setup(t, { config: { youtube: { categoryIds: ['0', '10'] } }, byCategory: { 0: jsonResponse(400, invalidKey), 10: chartPage } })
    const report = await pipeline.runOnce()
    assert.equal(fetchImpl.calls.length, 1)
    assert.deepEqual(
      { ok: report.ok, videos: report.videos, extractor: report.extractor, errors: report.errors },
      { ok: false, videos: 0, extractor: 'none', errors: ['전체 차트: YouTube API 키가 올바르지 않거나 이 API를 쓸 권한이 없습니다. (API_KEY_INVALID)'] },
    )
    assert.ok(!JSON.stringify(report).includes(API_KEY))
  })

  test('차트가 없는 분류는 오류가 아니고, 그날은 다시 묻지 않는다', async (t) => {
    const { fetchImpl, pipeline } = await setup(t, {
      ledger: true,
      config: { youtube: { categoryIds: ['0', '23', '24'] } },
      byCategory: { 0: [chartPage, chartPage], 23: [jsonResponse(400, legacyError(400, 'videoChartNotFound'))], 24: [jsonResponse(200, { items: [] })] },
    })
    const report = await pipeline.runOnce()
    assert.deepEqual({ ok: report.ok, videos: report.videos, errors: report.errors, unitsUsed: report.unitsUsed }, { ok: true, videos: 10, errors: [], unitsUsed: 3 })
    const second = await pipeline.runOnce()
    assert.deepEqual({ ok: second.ok, errors: second.errors, unitsUsed: second.unitsUsed }, { ok: true, errors: [], unitsUsed: 1 })
    assert.deepEqual(requestedCategories(fetchImpl), ['0', '23', '24', '0'])
  })

  test('일시적인 오류는 한 번만 다시 시도한다', async (t) => {
    // 한 번 실패한 뒤 성공
    const recovered = await setup(t, { byCategory: { 0: [jsonResponse(503, null), chartPage] } })
    const ok = await recovered.pipeline.runOnce()
    assert.deepEqual({ ok: ok.ok, videos: ok.videos, errors: ok.errors, unitsUsed: ok.unitsUsed }, { ok: true, videos: 10, errors: [], unitsUsed: 2 })

    // 두 번 다 실패: 더는 보내지 않는다. 모든 분류가 실패했으므로 실패한 수집이다.
    const down = await setup(t, { byCategory: { 0: [jsonResponse(429, null), jsonResponse(429, null), chartPage] } })
    const failed = await down.pipeline.runOnce()
    assert.equal(down.fetchImpl.calls.length, 2)
    assert.deepEqual(
      { ok: failed.ok, videos: failed.videos, extractor: failed.extractor, unitsUsed: failed.unitsUsed, errors: failed.errors },
      { ok: false, videos: 0, extractor: 'none', unitsUsed: 2, errors: ['전체 차트: YouTube API 요청이 잠시 제한됐습니다. (rateLimitExceeded)'] },
    )

    // 400 오류는 다시 보내지 않는다. 다른 분류가 성공했으면 수집은 성공이다.
    const partial = await setup(t, { config: { youtube: { categoryIds: ['0', '10'] } }, byCategory: { 0: chartPage, 10: [jsonResponse(400, legacyError(400, 'invalidParameter')), chartPage] } })
    const partly = await partial.pipeline.runOnce()
    assert.equal(partial.fetchImpl.calls.length, 2)
    assert.deepEqual({ ok: partly.ok, errors: partly.errors.length, added: partly.added }, { ok: true, errors: 1, added: 6 })

    // 설정이 잘못된 분류 번호는 요청 없이 건너뛴다
    const misconfigured = await setup(t, { config: { youtube: { categoryIds: ['music', '0', '0', ' '] } } })
    const skipped = await misconfigured.pipeline.runOnce()
    assert.deepEqual(requestedCategories(misconfigured.fetchImpl), ['0'])
    assert.deepEqual({ ok: skipped.ok, errors: skipped.errors }, { ok: true, errors: ['분류 music 차트: categoryId는 숫자로 된 분류 번호여야 합니다.'] })
  })

  test('수집이 실패해도 보관 기간이 지난 트렌드는 정리한다', async (t) => {
    const { now, store, pipeline } = await setup(t, { byCategory: { 0: [chartPage, jsonResponse(403, legacyError(403, 'quotaExceeded'))] }, config: { trends: { reviewMode: 'auto' } } })
    await pipeline.runOnce()
    assert.equal(store.stats().live, 6)
    now.advance(8 * DAY)
    const report = await pipeline.runOnce()
    assert.deepEqual({ ok: report.ok, purged: report.purged, added: report.added }, { ok: false, purged: 6, added: 0 })
    assert.equal(store.stats().live, 0)
  })

  test('인스타그램 반응은 위쪽 몇 개만 확인해 따로 붙인다', async (t) => {
    const asked = []
    const instagram = {
      enabled: true,
      async checkHashtag(tag) {
        asked.push(tag)
        if (tag === '달빛소녀') return null
        if (tag === '두바이 초콜릿') throw new Error('graph down')
        return { tag: tag.replace(/\s+/g, ''), hashtagId: '17843857450040591', mediaCount: 42, checkedAt: iso(T0) }
      },
    }
    const { store, pipeline } = await setup(t, { instagram, config: { trends: { reviewMode: 'auto' } } })
    const report = await pipeline.runOnce()
    assert.deepEqual(asked, ['달빛소녀', '얼죽아', '두바이 초콜릿'])
    assert.deepEqual({ ok: report.ok, igChecked: report.igChecked, errors: report.errors, added: report.added }, { ok: true, igChecked: 1, errors: [], added: 6 })
    const checked = store.list({ includeSeed: false }).filter((trend) => trend.instagram)
    assert.deepEqual(
      checked.map((trend) => [trend.keyword, trend.instagram, trend.score]),
      [['얼죽아', { tag: '얼죽아', mediaCount: 42, checkedAt: iso(T0) }, 2.3333]],
    )

    const never = {
      async checkHashtag() {
        throw new Error('호출되면 안 된다')
      },
    }
    const off = await setup(t, { instagram: { ...never, enabled: false } })
    assert.equal((await off.pipeline.runOnce()).igChecked, 0)
    const zero = await setup(t, { instagram: { ...never, enabled: true }, config: { instagram: { maxHashtagsPerRun: 0 } } })
    assert.equal((await zero.pipeline.runOnce()).igChecked, 0)
  })

  test('실제 인스타그램 클라이언트와 함께: 장부에 칸을 쓰고 결과를 트렌드에 붙인다', async (t) => {
    const dir = await tempDir(t)
    const now = clock()
    const graph = fakeFetch(({ url }) =>
      url.pathname.endsWith('/ig_hashtag_search') ? jsonResponse(200, { data: [{ id: '17843857450040591' }] }) : jsonResponse(200, { data: [{ id: '1' }, { id: '2' }, { id: '3' }] }),
    )
    const instagram = createInstagramClient({ accessToken: 'ig-token', userId: '17841400000000001', fetchImpl: graph, ledgerFile: path.join(dir, 'instagram-hashtags.json'), now })
    const { store, pipeline } = await setup(t, { instagram, config: { trends: { reviewMode: 'auto' }, instagram: { maxHashtagsPerRun: 2 } } })
    const report = await pipeline.runOnce()
    assert.equal(report.igChecked, 2)
    assert.deepEqual(
      store
        .list({ includeSeed: false })
        .filter((trend) => trend.instagram)
        .map((trend) => [trend.keyword, trend.instagram.tag, trend.instagram.mediaCount]),
      [
        ['달빛소녀', '달빛소녀', 3],
        ['얼죽아', '얼죽아', 3],
      ],
    )
    assert.equal((await instagram.budget()).used, 2)
  })

  test('인스타그램 토큰이 만료돼도 수집은 그대로 하고, 손써야 할 일만 보고서에 알린다', async (t) => {
    const dir = await tempDir(t)
    const graph = fakeFetch(() => jsonResponse(400, { error: { message: 'Error validating access token ig-token', code: 190 } }))
    const instagram = createInstagramClient({ accessToken: 'ig-token', userId: '17841400000000001', fetchImpl: graph, ledgerFile: path.join(dir, 'instagram-hashtags.json'), now: clock() })
    const { pipeline } = await setup(t, { instagram })
    const report = await pipeline.runOnce()
    assert.deepEqual(
      { ok: report.ok, igChecked: report.igChecked, added: report.added, errors: report.errors },
      { ok: true, igChecked: 0, added: 6, errors: ['인스타그램 토큰이 만료됐거나 권한이 없어 반응 확인을 껐습니다. 토큰을 새로 넣고 서버를 다시 띄워 주세요.'] },
    )
    assert.equal(graph.calls.length, 1, '토큰이 틀린 것을 안 뒤에는 더 보내지 않는다')
    assert.ok(!JSON.stringify(report).includes('ig-token'))

    // 다음 수집부터는 조용히 건너뛴다
    const next = await pipeline.runOnce()
    assert.deepEqual({ ok: next.ok, igChecked: next.igChecked, errors: next.errors }, { ok: true, igChecked: 0, errors: [] })
    assert.equal(graph.calls.length, 1)
  })

  test('실행 기록은 최근 20건만 남긴다', async (t) => {
    const { dir, now, pipeline } = await setup(t, { byCategory: { 0: jsonResponse(200, { items: [item(1, '키워드가 없는 영상')] }) } })
    for (let i = 0; i < 23; i++) {
      now.advance(MINUTE)
      await pipeline.runOnce()
    }
    await flushWrites()
    const { runs } = await readJsonFile(path.join(dir, 'trend-runs.json'))
    assert.equal(runs.length, 20)
    assert.equal(runs[0].startedAt, iso(T0 + 4 * MINUTE))
    assert.equal(runs.at(-1).startedAt, iso(T0 + 23 * MINUTE))
    assert.deepEqual(pipeline.status().lastRun, runs.at(-1))
  })

  describe('주기 수집', () => {
    /** setTimeout만 가짜로 바꾼다. 임시 폴더를 지우기 전에 되돌리도록 정리 훅을 먼저 걸어 둔다. */
    function mockTimers(t) {
      t.mock.timers.enable({ apis: ['setTimeout'] })
      t.after(() => t.mock.timers.reset())
    }

    const untilScheduled = async (pipeline) => {
      while (pipeline.status().nextRunAt === null) await new Promise((resolve) => setImmediate(resolve))
    }

    /** 요청 시각만 적어 두는 가짜 YouTube 클라이언트 */
    function idleYouTube(now) {
      const calls = []
      return {
        calls,
        get requestCount() {
          return calls.length
        },
        quota: () => null,
        async mostPopular() {
          calls.push(now())
          return []
        },
      }
    }

    async function setupScheduled(t, { dir, now = clock(), trends = {}, startupDelayMs = 2_000 } = {}) {
      const dataDir = dir ?? (await tempDir(t))
      const store = createTrendStore({ dataDir, now })
      await store.init()
      const youtube = idleYouTube(now)
      const pipeline = createTrendPipeline({ config: testConfig(dataDir, { trends }), store, youtube, safety: allowAll, log: quiet, now, startupDelayMs })
      t.after(() => pipeline.stop())
      return { dir: dataDir, now, youtube, pipeline }
    }

    test('start: 수집한 적이 없으면 곧 한 번 돌고, 그 뒤로는 주기마다 돈다', async (t) => {
      mockTimers(t)
      const { now, youtube, pipeline } = await setupScheduled(t)
      pipeline.start()
      pipeline.start()
      await untilScheduled(pipeline)
      assert.equal(pipeline.status().nextRunAt, iso(T0 + 2_000))
      assert.equal(youtube.calls.length, 0)

      now.advance(2_000)
      t.mock.timers.tick(2_000)
      // 예약된 실행이 돌고 있으므로 그 실행의 결과를 받는다
      const first = await pipeline.runOnce()
      assert.equal(first.trigger, 'schedule')
      assert.deepEqual(youtube.calls, [T0 + 2_000])
      assert.equal(pipeline.status().nextRunAt, iso(T0 + 2_000 + 30 * MINUTE))

      now.advance(30 * MINUTE)
      t.mock.timers.tick(30 * MINUTE)
      const second = await pipeline.runOnce()
      assert.equal(second.trigger, 'schedule')
      assert.notEqual(second, first)
      assert.equal(youtube.calls.length, 2)

      pipeline.stop()
      assert.equal(pipeline.status().nextRunAt, null)
      now.advance(2 * HOUR)
      t.mock.timers.tick(2 * HOUR)
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(youtube.calls.length, 2, '끈 뒤에는 돌지 않는다')
    })

    test('start: 얼마 전에 돌았으면 남은 시간만큼 기다리고, 주기가 지났으면 곧 돈다', async (t) => {
      mockTimers(t)
      const before = await setupScheduled(t)
      const last = await before.pipeline.runOnce()
      await flushWrites()

      // 20분 뒤에 다시 띄웠다: 30분 주기에서 10분 남았다
      before.now.advance(20 * MINUTE)
      const restarted = await setupScheduled(t, { dir: before.dir, now: before.now })
      restarted.pipeline.start()
      await untilScheduled(restarted.pipeline)
      assert.equal(restarted.pipeline.status().nextRunAt, iso(T0 + 30 * MINUTE))
      assert.deepEqual(restarted.pipeline.status().lastRun, last, '지난 실행 기록을 읽어 온다')
      restarted.pipeline.stop()

      // 한 시간 뒤에 다시 띄웠다: 주기가 지났으므로 곧(2초 뒤) 돈다
      before.now.advance(40 * MINUTE)
      const late = await setupScheduled(t, { dir: before.dir, now: before.now })
      late.pipeline.start()
      await untilScheduled(late.pipeline)
      assert.equal(late.pipeline.status().nextRunAt, iso(T0 + HOUR + 2_000))
    })

    test('주기 설정이 이상해도 1분보다 자주 돌지 않고, 타이머가 받는 한도를 넘기지 않는다', async (t) => {
      mockTimers(t)
      // [설정값(분), 실제로 쓰는 주기] — 쓸 수 없는 값이면 기본 주기(180분)
      const cases = [
        [0.001, MINUTE],
        [0, 180 * MINUTE],
        [-5, 180 * MINUTE],
        [NaN, 180 * MINUTE],
        ['30', 180 * MINUTE],
        [1e9, 2 ** 31 - 1],
      ]
      for (const [refreshMinutes, intervalMs] of cases) {
        const { now, youtube, pipeline } = await setupScheduled(t, { trends: { refreshMinutes }, startupDelayMs: 0 })
        pipeline.start()
        await untilScheduled(pipeline)
        now.advance(1)
        t.mock.timers.tick(1)
        const report = await pipeline.runOnce()
        assert.equal(report.trigger, 'schedule')
        assert.equal(youtube.calls.length, 1)
        assert.equal(Date.parse(pipeline.status().nextRunAt) - now(), intervalMs, `refreshMinutes=${refreshMinutes}`)
        pipeline.stop()
      }
    })
  })
})
