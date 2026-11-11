// 트렌드 수집(server/trends/*) 공격 테스트: 구현이 아니라 명세(SPEC Module D)와 검증된 정책 조사를 기준으로 삼는다.
// 네트워크는 쓰지 않고(fetchImpl 주입), 파일은 임시 폴더에만 쓰며, 시각은 주입한 시계를 따른다.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { flushWrites } from '../server/store.js'
import { createQuotaLedger, quotaDay } from '../server/trends/quota.js'
import { createYouTubeClient } from '../server/trends/youtube.js'
import { createTrendStore, TrendStoreError } from '../server/trends/trend-store.js'
import { extractKeywordTrends } from '../server/trends/extract.js'
import { extractMemeTrends } from '../server/trends/extract-llm.js'
import { createInstagramClient, normalizeTag } from '../server/trends/instagram.js'
import { createTrendPipeline } from '../server/trends/pipeline.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SEED_PATH = path.join(ROOT, 'server', 'trends', 'seed-trends.json')
const HOUR = 3_600_000
const DAY = 24 * HOUR
const T0 = Date.parse('2026-11-11T03:00:00.000Z')
const API_KEY = 'AIzaSy-ATTACK-secret_9876543210'
const IG_TOKEN = 'IGQVJ-attack-secret-token-0000'
const IG_USER = '17841400000000001'
const quiet = { info() {}, warn() {}, error() {} }

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'trends-attack-'))
  t.after(async () => {
    await flushWrites()
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })
  return dir
}

function clock(start = T0) {
  let ms = start
  const now = () => ms
  now.advance = (delta) => {
    ms += delta
  }
  return now
}

const res = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body })

function recordingFetch(handler) {
  const calls = []
  const impl = async (url, init = {}) => {
    const call = { url: new URL(url), raw: String(url), headers: init.headers ?? {} }
    calls.push(call)
    return handler(call)
  }
  impl.calls = calls
  return impl
}

const vid = (i, title, tags = [], rank = i) => {
  const id = `atk${String(i).padStart(8, '0')}`
  return { id, title, tags, categoryId: '24', publishedAt: '2026-11-10T00:00:00.000Z', rank, url: `https://www.youtube.com/watch?v=${id}` }
}
const keywordsOf = (videos) => extractKeywordTrends(videos, { now: T0 }).map((draft) => draft.keyword)
const normKey = (text) => text.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

// ───────────────────────────────── quota.js
describe('공격: 할당량 장부', () => {
  test('할당량 날짜는 태평양 시간 자정에 바뀐다(PST·PDT 모두)', () => {
    assert.equal(quotaDay(Date.parse('2026-11-11T07:59:59.999Z')), '2026-11-10')
    assert.equal(quotaDay(Date.parse('2026-11-11T08:00:00.000Z')), '2026-11-11')
    assert.equal(quotaDay(Date.parse('2026-07-01T06:59:59.999Z')), '2026-06-30')
    assert.equal(quotaDay(Date.parse('2026-07-01T07:00:00.000Z')), '2026-07-01')
  })

  test('같은 장부 파일을 쓰는 두 장부(서버 + 수집 CLI)가 동시에 써도 쓴 단위를 잃지 않는다', async (t) => {
    const dir = await tempDir(t)
    const file = path.join(dir, 'youtube-quota.json')
    const now = clock()
    const server = createQuotaLedger({ file, dailyBudget: 2, now })
    const cli = createQuotaLedger({ file, dailyBudget: 2, now })
    await server.load()
    await cli.load()
    await Promise.all([server.spend(1), cli.spend(1)])
    const fresh = createQuotaLedger({ file, dailyBudget: 2, now })
    await fresh.load()
    assert.equal(fresh.status().used, 2, '실제로 2단위를 썼는데 장부에는 덜 적혔다')
    assert.equal(fresh.canSpend(1), false)
  })
})

// ───────────────────────────────── youtube.js
describe('공격: YouTube 클라이언트', () => {
  const item = (id, extra = {}) => ({
    id,
    snippet: { publishedAt: '2026-11-10T01:02:03Z', title: `제목 ${id}`, tags: ['태그'], categoryId: '24', channelTitle: '채널', description: '설명', thumbnails: { high: {} } },
    statistics: { viewCount: '999999' },
    ...extra,
  })

  test('요청: part=snippet만, fields 제한, hl 없음, regionCode 항상, 키는 헤더로만', async () => {
    const fetchImpl = recordingFetch(() => res(200, { items: [item('abcde12345')] }))
    const client = createYouTubeClient({ apiKey: API_KEY, fetchImpl })
    await client.mostPopular()
    await client.mostPopular({ categoryId: '10' })
    for (const call of fetchImpl.calls) {
      assert.equal(call.url.origin + call.url.pathname, 'https://www.googleapis.com/youtube/v3/videos')
      assert.equal(call.url.searchParams.get('part'), 'snippet')
      assert.equal(call.url.searchParams.get('chart'), 'mostPopular')
      assert.equal(call.url.searchParams.get('regionCode'), 'KR')
      assert.equal(call.url.searchParams.get('fields'), 'items(id,snippet(publishedAt,title,tags,categoryId))')
      assert.equal(call.url.searchParams.has('hl'), false)
      assert.equal(call.url.searchParams.has('key'), false)
      assert.ok(!call.raw.includes(API_KEY))
      assert.ok(!/statistics/i.test(call.raw))
      const header = Object.entries(call.headers).find(([name]) => name.toLowerCase() === 'x-goog-api-key')
      assert.equal(header?.[1], API_KEY)
    }
    assert.equal(fetchImpl.calls[0].url.searchParams.has('videoCategoryId'), false)
    assert.equal(fetchImpl.calls[1].url.searchParams.get('videoCategoryId'), '10')
  })

  test('VideoMeta에는 정해진 값만 남고, rank는 응답 안의 순서다', async () => {
    const fetchImpl = recordingFetch(() => res(200, { items: [item('first00001'), item('second0002')] }))
    const videos = await createYouTubeClient({ apiKey: API_KEY, fetchImpl }).mostPopular()
    assert.deepEqual(videos.map((video) => Object.keys(video).sort()), [
      ['categoryId', 'id', 'publishedAt', 'rank', 'tags', 'title', 'url'],
      ['categoryId', 'id', 'publishedAt', 'rank', 'tags', 'title', 'url'],
    ])
    assert.deepEqual(videos.map((video) => video.rank), [1, 2])
    assert.equal(videos[0].url, 'https://www.youtube.com/watch?v=first00001')
    assert.ok(!JSON.stringify(videos).includes('999999'))
  })

  test('오류 분류: errors[0].reason → ErrorInfo → HTTP 상태, 재시도·중단 규칙', async () => {
    const legacy = (code, reason) => ({ error: { code, message: `upstream ${API_KEY}`, errors: [{ domain: 'global', reason, message: `msg ${API_KEY}` }] } })
    const infra = (code, top, info) => ({
      error: {
        code,
        message: 'x',
        errors: [{ domain: 'global', reason: top }],
        status: 'X',
        details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: info }, { '@type': 'type.googleapis.com/google.rpc.LocalizedMessage', message: 'y' }],
      },
    })
    const cases = [
      [403, legacy(403, 'quotaExceeded'), 'quotaExceeded', false, true],
      [403, legacy(403, 'dailyLimitExceeded'), 'dailyLimitExceeded', false, true],
      [403, legacy(403, 'rateLimitExceeded'), 'rateLimitExceeded', true, false],
      [429, legacy(429, 'rateLimitExceeded'), 'rateLimitExceeded', true, false],
      [400, legacy(400, 'invalidParameter'), 'invalidParameter', false, false],
      [400, legacy(400, 'videoChartNotFound'), 'videoChartNotFound', false, false],
      [400, infra(400, 'badRequest', 'API_KEY_INVALID'), 'API_KEY_INVALID', false, true],
      [403, infra(403, 'forbidden', 'ACCESS_DENIED'), 'forbidden', false, true],
    ]
    for (const [status, body, reason, retryable, fatal] of cases) {
      const client = createYouTubeClient({ apiKey: API_KEY, fetchImpl: async () => res(status, body) })
      const err = await client.mostPopular({ categoryId: '10' }).then(() => null, (e) => e)
      assert.ok(err, `${reason}: 예외가 나야 한다`)
      assert.equal(err.reason, reason)
      assert.equal(err.status, status)
      assert.equal(err.retryable, retryable, `${reason} retryable`)
      assert.equal(Boolean(err.fatal), fatal, `${reason} fatal`)
      assert.ok(!err.message.includes(API_KEY) && !err.message.includes('googleapis'), '오류 문구에 키·주소가 없어야 한다')
      assert.ok(!(err.stack ?? '').includes(API_KEY))
    }
    const net = createYouTubeClient({ apiKey: API_KEY, fetchImpl: async (url) => { throw new Error(`connect failed ${url} ${API_KEY}`) } })
    const err = await net.mostPopular().then(() => null, (e) => e)
    assert.equal(err.reason, 'network')
    assert.equal(err.retryable, true)
    assert.ok(!err.message.includes(API_KEY) && !err.message.includes('googleapis'))
  })

  test('차트 없음(400 videoChartNotFound / 200 빈 목록)은 장부 파일에 남아 재시작해도 그날은 다시 묻지 않는다', async (t) => {
    const dir = await tempDir(t)
    const file = path.join(dir, 'quota.json')
    const now = clock()
    const fetchImpl = recordingFetch(({ url }) =>
      url.searchParams.get('videoCategoryId') === '23' ? res(400, { error: { errors: [{ reason: 'videoChartNotFound' }] } }) : res(200, { items: [] }),
    )
    const ledger = createQuotaLedger({ file, dailyBudget: 100, now })
    await ledger.load()
    const client = createYouTubeClient({ apiKey: API_KEY, fetchImpl, ledger })
    await client.mostPopular({ categoryId: '23' }).catch(() => {})
    await client.mostPopular({ categoryId: '24' })
    assert.equal(fetchImpl.calls.length, 2)
    await flushWrites()

    const reloaded = createQuotaLedger({ file, dailyBudget: 100, now })
    await reloaded.load()
    const again = createYouTubeClient({ apiKey: API_KEY, fetchImpl, ledger: reloaded })
    assert.deepEqual(await again.mostPopular({ categoryId: '23' }), [])
    assert.deepEqual(await again.mostPopular({ categoryId: '24' }), [])
    assert.equal(fetchImpl.calls.length, 2, '같은 할당량 날짜에는 요청하지 않는다')

    now.advance(DAY)
    await again.mostPopular({ categoryId: '24' })
    assert.equal(fetchImpl.calls.length, 3, '다음 날에는 다시 묻는다')
  })

  test('이상한 입력에도 TypeError나 YouTubeError만 낸다', async () => {
    assert.throws(() => createYouTubeClient({}), TypeError)
    assert.throws(() => createYouTubeClient(), TypeError)
    const client = createYouTubeClient({ apiKey: API_KEY, fetchImpl: async () => res(200, { items: [null, 5, { id: 'x' }, { id: 'goodid0001', snippet: { title: 'ok' } }] }) })
    const videos = await client.mostPopular()
    assert.equal(videos.length, 1)
    assert.deepEqual(videos[0].tags, [])
    await assert.rejects(client.mostPopular({ regionCode: 'Korea' }), TypeError)
  })
})

// ───────────────────────────────── trend-store.js
describe('공격: 트렌드 저장소', () => {
  const draft = (keyword, score, extra = {}) => ({
    keyword,
    kind: 'keyword',
    pattern: null,
    meaning: '',
    origin: '',
    caution: '',
    category: '일상',
    source: { type: 'youtube', label: 'YouTube 인기 차트', url: 'https://www.youtube.com/watch?v=atk00000001', title: null },
    stats: { videoCount: 2 },
    collectedAt: new Date(T0).toISOString(),
    score,
    meaningVerified: false,
    ...extra,
  })

  async function openStore(t, opts = {}) {
    const dir = await tempDir(t)
    const now = clock()
    const store = createTrendStore({ dataDir: dir, seedPath: SEED_PATH, now, ...opts })
    await store.init()
    return { dir, now, store }
  }

  test('수집 id는 yt- + sha256(정규화 키워드) 앞 10자, 목록은 수집(점수순) 다음 예시(파일순)', async (t) => {
    const { store } = await openStore(t)
    const seedIds = store.list().map((trend) => trend.id)
    await store.upsertDrafts([draft('얼죽아 파티', 1.5), draft('겨울 감성', 3.2), draft('얼죽아파티!', 9)], { reviewMode: 'auto' })
    const live = store.list().filter((trend) => !trend.sample)
    assert.deepEqual(live.map((trend) => trend.keyword), ['겨울 감성', '얼죽아 파티'])
    const expected = `yt-${createHash('sha256').update('얼죽아파티').digest('hex').slice(0, 10)}`
    assert.equal(live[1].id, expected)
    assert.equal(typeof live[0].lastSeenAt, 'string')
    assert.equal(typeof live[0].score, 'number')
    assert.equal(live[0].status, 'approved')
    assert.equal(live[0].publishedAt, new Date(T0).toISOString())
    assert.deepEqual(store.list().slice(2).map((trend) => trend.id), seedIds)
  })

  test('setStatus: 300자 제한, 수정·승인하면 meaningVerified, 예시는 바꿀 수 없다', async (t) => {
    const { store, now } = await openStore(t)
    await store.upsertDrafts([draft('겨울 감성', 1)], { reviewMode: 'manual' })
    const [pending] = store.list({ status: 'pending', includeSeed: false })
    assert.equal(pending.publishedAt, null)
    now.advance(2 * HOUR)
    const edited = await store.setStatus(pending.id, 'approved', { meaning: `  ${'가'.repeat(400)}  `, origin: 42 })
    assert.equal(Array.from(edited.meaning).length, 300)
    assert.equal(edited.meaningVerified, true)
    assert.equal(edited.publishedAt, new Date(T0 + 2 * HOUR).toISOString())
    assert.deepEqual(store.latencyHours(), [2])
    await assert.rejects(store.setStatus('seed-gatsaeng', 'rejected'), TrendStoreError)
    await assert.rejects(store.setStatus(pending.id, 'deleted'))
  })

  test('purge: lastSeenAt이 ttlDays보다 오래되면 지우고, 인스타그램 칸은 점수와 따로 저장된다', async (t) => {
    const { dir, now, store } = await openStore(t, { ttlDays: 3 })
    const ig = { tag: '겨울감성', mediaCount: 37, checkedAt: new Date(T0).toISOString() }
    await store.upsertDrafts([draft('겨울 감성', 1.25, { instagram: ig }), draft('붕세권 산책', 2)], { reviewMode: 'auto' })
    await flushWrites()
    const reopened = createTrendStore({ dataDir: dir, seedPath: SEED_PATH, now, ttlDays: 3 })
    await reopened.init()
    const saved = reopened.list({ includeSeed: false }).find((trend) => trend.keyword === '겨울 감성')
    assert.deepEqual(saved.instagram, ig)
    assert.equal(saved.score, 1.25)
    now.advance(3 * DAY + 1)
    assert.equal(await reopened.purgeExpired(), 2)
    assert.equal(reopened.stats().live, 0)
  })

  test('쓰레기 입력에도 죽지 않는다', async (t) => {
    const { store } = await openStore(t)
    assert.deepEqual(await store.upsertDrafts(null), { added: 0, updated: 0 })
    assert.deepEqual(await store.upsertDrafts([null, 1, 'x', { keyword: 5 }, { keyword: '   ' }]), { added: 0, updated: 0 })
    assert.equal(store.get(undefined), null)
    assert.ok(Array.isArray(store.list(null)))
  })
})

// ───────────────────────────────── extract.js
describe('공격: 규칙 기반 추출', () => {
  test('형식 문구(하이라이트·직캠·4k·라이브·자막)는 낱말 끝에 무엇이 붙어 있든 키워드가 되지 못한다', () => {
    const boilerplate = new Set(['하이라이트', '직캠', '4k', '라이브', '자막', '예고', '풀버전', '공식', '뮤직비디오'])
    for (const title of ['#하이라이트모음', '#직캠모음', '#4K직캠', '#라이브모음', '#자막리뷰']) {
      const found = keywordsOf([vid(1, title)]).filter((keyword) => boilerplate.has(normKey(keyword)))
      assert.deepEqual(found, [], `${title} → ${found.join(', ')}`)
    }
    const fromTags = keywordsOf([vid(1, '제목 하나', ['4K직캠', '직캠모음']), vid(2, '제목 둘', ['4K직캠', '직캠모음'])])
    assert.deepEqual(fromTags.filter((keyword) => boilerplate.has(normKey(keyword))), [])
  })

  test('형식 문구만으로 이루어진 해시태그(#OfficialMV, #EngSub, #공식MV)는 버린다', () => {
    for (const title of ['#OfficialMV', '#EngSub', '#공식MV']) {
      assert.deepEqual(keywordsOf([vid(1, title)]), [], title)
    }
  })

  test('날짜는 붙여 써도 버린다(#11월11일, #12월25일, #2026년11월)', () => {
    for (const title of ['#11월11일', '#12월25일', '#2026년11월']) {
      assert.deepEqual(keywordsOf([vid(1, title)]), [], title)
    }
  })

  test('이모지는 흔적(변형 선택자 U+FE0F, 키캡 U+20E3) 없이 걷어 낸다', () => {
    const videos = [vid(1, '“좋아요❤️” 모음'), vid(2, '#하트❤️ 챌린지'), vid(3, '“1️⃣등 가자”'), vid(4, '오늘 기분 최고❤️ 진짜'), vid(5, '오늘 기분 최고❤️ 대박')]
    const keywords = keywordsOf(videos)
    assert.ok(keywords.length > 0)
    for (const keyword of keywords) {
      assert.ok(!/[︎️⃣‍]|\p{Extended_Pictographic}/u.test(keyword), `이모지 흔적: ${JSON.stringify(keyword)}`)
      assert.equal(keyword, keyword.trim().replace(/\s+/g, ' '), `공백 정리: ${JSON.stringify(keyword)}`)
    }
  })

  test('점수 = 근거 영상 수 + 1/(가장 높은 순위+1), 출처는 가장 높은 순위 영상, 통계는 쓰지 않는다', () => {
    const videos = [vid(1, '퇴근길 감성 브이로그', [], 7), vid(2, '오늘의 퇴근길 감성', [], 3), vid(3, '#붕세권 산책', [], 12)]
    const drafts = extractKeywordTrends(videos, { now: T0 })
    const commute = drafts.find((draft) => draft.keyword === '퇴근길 감성')
    assert.ok(commute, JSON.stringify(drafts.map((draft) => draft.keyword)))
    assert.equal(commute.score, 2 + 1 / 4)
    assert.equal(commute.stats.videoCount, 2)
    assert.equal(commute.source.url, videos[1].url)
    assert.equal(commute.source.title, null)
    assert.equal(commute.source.type, 'youtube')
    assert.equal(commute.kind, 'keyword')
    assert.equal(commute.category, '일상')
    assert.equal(commute.meaningVerified, false)
    assert.equal(commute.collectedAt, new Date(T0).toISOString())
    const withStats = videos.map((video) => ({ ...video, statistics: { viewCount: '100000000', likeCount: '5' }, viewCount: 1e9 }))
    assert.deepEqual(extractKeywordTrends(withStats, { now: T0 }), drafts)
  })

  test('아주 큰 입력과 쓰레기에도 빨리 끝나고 죽지 않는다', () => {
    const huge = Array.from({ length: 3000 }, (_, i) => vid(i + 1, `#태그${i % 50} ${'가나다 라마바 '.repeat(40)} “${'ㅋ'.repeat(30)}”`, Array.from({ length: 80 }, (_, j) => `태그${j}`)))
    const started = performance.now()
    const drafts = extractKeywordTrends(huge, { now: T0, max: 1e9 })
    assert.ok(performance.now() - started < 3000)
    assert.ok(drafts.length <= 200)
    assert.deepEqual(extractKeywordTrends(null, { now: T0 }), [])
    assert.deepEqual(extractKeywordTrends([null, 1, { title: 5 }, { title: 'x', url: 'javascript:alert(1)' }], { now: T0 }), [])
  })
})

// ───────────────────────────────── extract-llm.js
describe('공격: LLM 추출', () => {
  test('메타데이터만 120개까지, 태그 8개까지 보내고, 인물·민감 항목은 버리고, 뜻은 미확인으로 둔다', async () => {
    const videos = Array.from({ length: 150 }, (_, i) => vid(i + 1, `오히려 좋아 ${i}`, Array.from({ length: 12 }, (_, j) => `태그${j}`)))
    let request = null
    const llm = {
      async generateJson(req) {
        request = req
        return {
          items: [
            { keyword: '오히려 좋아', kind: 'phrase', pattern: '', meaning: '나쁜 일도 좋게 받아들이는 말', origin: '', caution: '', category: '공감', videoIndexes: [4, 2], isPersonOrBrand: false, sensitive: false },
            { keyword: '태그1', kind: 'word', pattern: '', meaning: '', origin: '', caution: '', category: '일상', videoIndexes: [0], isPersonOrBrand: true, sensitive: false },
            { keyword: '태그2', kind: 'word', pattern: '', meaning: '', origin: '', caution: '', category: '일상', videoIndexes: [0], isPersonOrBrand: false, sensitive: true },
          ],
        }
      },
    }
    const drafts = await extractMemeTrends(videos, llm, { now: T0 })
    const payload = JSON.parse(request.user ?? request.messages?.[0]?.content)
    assert.ok(payload.videos.length <= 120)
    for (const sent of payload.videos) {
      assert.ok(sent.tags.length <= 8)
      assert.deepEqual(Object.keys(sent).sort(), ['categoryId', 'index', 'rank', 'tags', 'title'])
    }
    assert.ok(!JSON.stringify(request).includes('youtube.com/watch'))
    assert.ok(/[가-힣]/.test(request.system))
    assert.deepEqual(drafts.map((draft) => draft.keyword), ['오히려 좋아'])
    assert.equal(drafts[0].meaningVerified, false)
    assert.equal(drafts[0].source.url, videos[4].url)
    await assert.rejects(extractMemeTrends(videos, { generateJson: async () => { throw new Error('down') } }, { now: T0 }))
  })
})

// ───────────────────────────────── instagram.js
describe('공격: 인스타그램 반응 확인', () => {
  function graph({ pages = true } = {}) {
    return recordingFetch(({ url }) => {
      if (url.pathname.endsWith('/ig_hashtag_search')) return res(200, { data: [{ id: `178410${String(url.searchParams.get('q').length).padStart(8, '0')}` }] })
      if (url.pathname.endsWith('/top_media')) {
        return res(200, { data: Array.from({ length: 7 }, (_, i) => ({ id: String(i) })), paging: pages ? { next: `https://graph.facebook.com/v27.0/next?access_token=${IG_TOKEN}` } : undefined })
      }
      return res(404, { error: { code: 100 } })
    })
  }

  test('v27.0, access_token 쿼리, 최소 필드, 인기 게시물 한 쪽(limit=50)만, 개수만 센다', async (t) => {
    const dir = await tempDir(t)
    const fetchImpl = graph()
    const client = createInstagramClient({ accessToken: IG_TOKEN, userId: IG_USER, fetchImpl, ledgerFile: path.join(dir, 'ig.json'), now: clock() })
    const result = await client.checkHashtag('#겨울 감성')
    assert.equal(result.tag, '겨울감성')
    assert.equal(result.mediaCount, 7)
    assert.ok(!JSON.stringify(result).includes(IG_TOKEN))
    assert.equal(fetchImpl.calls.length, 2, '다음 쪽(paging.next)은 따라가지 않는다')
    for (const call of fetchImpl.calls) {
      assert.ok(call.url.pathname.startsWith('/v27.0/'))
      assert.equal(call.url.searchParams.get('access_token'), IG_TOKEN)
    }
    const top = fetchImpl.calls[1].url
    assert.equal(top.searchParams.get('fields'), 'id,media_type,comments_count,like_count,timestamp')
    assert.equal(top.searchParams.get('limit'), '50')
  })

  test('normalizeTag: NFC, # 빼기, 소문자, 이모지·기호 거부', () => {
    assert.equal(normalizeTag('#Café'.normalize('NFD')), 'café')
    assert.equal(normalizeTag('  #얼죽아 챌린지 '), '얼죽아챌린지')
    assert.equal(normalizeTag('#좋아요❤️'), null)
    assert.equal(normalizeTag('1️⃣'), null)
    assert.equal(normalizeTag('🇰🇷'), null)
    assert.equal(normalizeTag('a-b'), null)
    assert.equal(normalizeTag(null), null)
    assert.equal(normalizeTag({}), null)
  })

  test('같은 장부 파일을 쓰는 두 클라이언트(서버 + 수집 CLI)가 동시에 물어도 7일 30개를 넘지 않는다', async (t) => {
    const dir = await tempDir(t)
    const ledgerFile = path.join(dir, 'instagram-hashtags.json')
    const now = clock()
    const slots = Array.from({ length: 29 }, (_, i) => ({ userId: IG_USER, tag: `기존${i}`, hashtagId: null, firstQueriedAt: now() - HOUR, checkedAt: null, mediaCount: null }))
    await writeFile(ledgerFile, JSON.stringify({ version: 1, slots }))
    const fetchImpl = graph({ pages: false })
    const make = () => createInstagramClient({ accessToken: IG_TOKEN, userId: IG_USER, fetchImpl, ledgerFile, now })
    await Promise.all([make().checkHashtag('새태그하나'), make().checkHashtag('새태그둘')])
    const queried = new Set(fetchImpl.calls.filter((call) => call.url.pathname.endsWith('/ig_hashtag_search')).map((call) => call.url.searchParams.get('q')))
    assert.ok(29 + queried.size <= 30, `서로 다른 해시태그 ${29 + queried.size}개를 조회했다`)
    await flushWrites()
    const saved = JSON.parse(await readFile(ledgerFile, 'utf8'))
    for (const tag of queried) assert.ok(saved.slots.some((slot) => slot.tag === tag), `조회한 ${tag}가 장부에서 사라졌다`)
  })

  test('오류가 나도 던지지 않고, 토큰은 결과·lastError 어디에도 없다', async (t) => {
    const dir = await tempDir(t)
    const fetchImpl = async (url) => {
      throw new Error(`ECONNRESET ${url}`)
    }
    const client = createInstagramClient({ accessToken: IG_TOKEN, userId: IG_USER, fetchImpl, ledgerFile: path.join(dir, 'ig.json'), now: clock() })
    assert.equal(await client.checkHashtag('겨울감성'), null)
    assert.ok(!JSON.stringify(client.lastError ?? {}).includes(IG_TOKEN))
    const budget = await client.budget()
    assert.deepEqual([budget.limit, budget.windowDays], [30, 7])
  })
})

// ───────────────────────────────── pipeline.js
describe('공격: 수집 파이프라인', () => {
  const allowAll = { checkTrend: () => ({ ok: true, level: 'ok', categories: [] }) }
  const chartItems = [
    { id: 'pipe000001', snippet: { title: '퇴근길 감성 브이로그 #붕세권', tags: ['퇴근길 감성', '직장인'], categoryId: '22', publishedAt: '2026-11-10T00:00:00Z' } },
    { id: 'pipe000002', snippet: { title: '오늘의 퇴근길 감성 모음', tags: ['퇴근길 감성', '직장인'], categoryId: '22', publishedAt: '2026-11-10T00:00:00Z' } },
  ]
  const config = (dir, extra = {}) => ({
    dataDir: dir,
    youtube: { apiKey: API_KEY, regionCode: 'KR', categoryIds: ['0'], maxResults: 50 },
    trends: { refreshMinutes: 30, reviewMode: 'manual', ttlDays: 7, maxPerRun: 30 },
    instagram: { maxHashtagsPerRun: 3 },
    ...extra,
  })

  async function setup(t, deps = {}) {
    const dir = await tempDir(t)
    const now = clock()
    const store = createTrendStore({ dataDir: dir, seedPath: SEED_PATH, now })
    await store.init()
    const fetchImpl = recordingFetch(() => res(200, { items: chartItems }))
    const youtube = createYouTubeClient({ apiKey: API_KEY, fetchImpl })
    const pipeline = createTrendPipeline({ config: config(dir), store, youtube, safety: allowAll, log: quiet, now, retryDelayMs: 0, ...deps })
    return { dir, now, store, fetchImpl, pipeline }
  }

  test('YouTube 키가 없으면 정해진 보고서만 돌려주고 아무것도 하지 않는다', async (t) => {
    const dir = await tempDir(t)
    const store = createTrendStore({ dataDir: dir, seedPath: SEED_PATH, now: clock() })
    await store.init()
    const cfg = config(dir)
    cfg.youtube.apiKey = ''
    const pipeline = createTrendPipeline({ config: cfg, store, youtube: null, safety: allowAll, log: quiet, now: clock() })
    const report = await pipeline.runOnce()
    assert.equal(report.ok, false)
    assert.equal(report.extractor, 'none')
    assert.deepEqual(report.errors, ['YOUTUBE_API_KEY가 없어 수집을 건너뜁니다.'])
    pipeline.start()
    assert.equal(pipeline.status().nextRunAt, null)
    assert.equal(pipeline.status().enabled, false)
  })

  test('동시 호출은 같은 프라미스, LLM 실패는 규칙 추출로, 차단된 초안은 세기만 한다', async (t) => {
    const llm = { available: () => true, generateJson: async () => { throw new Error('boom') } }
    const safety = { checkTrend: (draft) => ({ ok: draft.keyword !== '직장인', level: draft.keyword === '직장인' ? 'block' : 'ok', categories: [] }) }
    const { store, fetchImpl, pipeline, dir } = await setup(t, { llm, safety })
    const first = pipeline.runOnce()
    const second = pipeline.runOnce()
    assert.equal(first, second)
    const report = await first
    assert.equal(fetchImpl.calls.length, 1)
    assert.equal(report.extractor, 'rules')
    assert.ok(report.blocked >= 1)
    const stored = store.list({ status: 'pending', includeSeed: false }).map((trend) => trend.keyword)
    assert.ok(!stored.includes('직장인'))
    assert.ok(stored.includes('퇴근길 감성'), JSON.stringify(stored))
    await flushWrites()
    const runs = JSON.parse(await readFile(path.join(dir, 'trend-runs.json'), 'utf8'))
    assert.ok(!JSON.stringify(runs).includes(API_KEY))
    for (const key of ['startedAt', 'finishedAt', 'trigger', 'ok', 'videos', 'drafts', 'blocked', 'added', 'updated', 'purged', 'extractor', 'igChecked', 'errors', 'unitsUsed']) {
      assert.ok(key in report, key)
    }
  })

  test('인스타그램 반응은 trend.instagram에 따로 붙고 점수에는 섞이지 않는다', async (t) => {
    const instagram = { enabled: true, lastError: null, checkHashtag: async (tag) => ({ tag: normalizeTag(tag), hashtagId: '1784100000', mediaCount: 50, checkedAt: new Date(T0).toISOString() }) }
    const { store, pipeline } = await setup(t, { instagram })
    const plain = await setup(t)
    await pipeline.runOnce()
    await plain.pipeline.runOnce()
    const withIg = store.list({ status: 'pending', includeSeed: false })
    const without = plain.store.list({ status: 'pending', includeSeed: false })
    assert.ok(withIg.some((trend) => trend.instagram?.mediaCount === 50))
    assert.deepEqual(withIg.map((trend) => [trend.keyword, trend.score]), without.map((trend) => [trend.keyword, trend.score]))
  })
})
