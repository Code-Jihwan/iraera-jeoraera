// 전체 흐름 통합 테스트: 키 없이(예시 데이터 + 기본 엔진) 서버를 띄워 사용자 흐름과 운영 API를 끝까지 따라간다.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { buildServer } from '../server/main.js'
import { analyzeStyle, splitUtterances, profileToPayload } from '../shared/style-analyzer.js'
import { SAMPLE_PERSONAS } from '../public/js/samples.js'
import { LIMITS, TECHNIQUE_IDS } from '../shared/constants.js'

const quiet = { info() {}, warn() {}, error() {}, log() {} }

let dir
let server
let base
let trends

const json = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

function payloadFor(persona) {
  const profile = analyzeStyle({ textUtterances: splitUtterances(persona.text), sample: true })
  return profileToPayload(profile)
}

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'e2e-test-'))
  server = await buildServer({
    env: { DATA_DIR: dir, PORT: '0', HOST: '127.0.0.1', LLM_MODE: 'off', GENERATE_RATE_LIMIT_PER_MIN: '10000', GENERATE_DAILY_LIMIT_PER_CLIENT: '10000', EVENTS_RATE_LIMIT_PER_MIN: '10000' },
    loadDotEnv: false,
    log: quiet,
  })
  const address = await server.start()
  base = `http://127.0.0.1:${address.port}`
  trends = (await (await fetch(`${base}/api/trends`)).json()).items
})

after(async () => {
  await server.stop()
  await rm(dir, { recursive: true, force: true })
})

test('상태: 키가 없으면 기본 엔진과 예시 데이터', async () => {
  const s = await (await fetch(`${base}/api/status`)).json()
  assert.equal(s.engine.mode, 'local')
  assert.equal(s.trends.youtubeEnabled, false)
  assert.ok(s.trends.seed >= 20)
  assert.ok(s.serviceName)
  assert.ok(s.consentVersion)
  assert.deepEqual(s.retention, { events: 90, reports: 90 }, '고지 문구가 쓸 보관 기간')
})

test('트렌드 목록: 예시 데이터가 뜻·출처와 함께 오고, 엔진 힌트는 빠져 있다', () => {
  assert.ok(trends.length >= 20)
  for (const t of trends) {
    assert.ok(t.id && t.keyword, '키워드')
    assert.equal(t.status, 'approved')
    assert.equal(t.sample, true)
    assert.ok(!('engine' in t), '엔진 힌트는 브라우저로 보내지 않는다')
    assert.ok(t.source && t.source.type === 'seed')
    if (t.kind !== 'keyword') {
      assert.ok(t.meaning.length > 10, `${t.keyword} 뜻`)
      assert.match(t.source.url, /^https?:\/\//, `${t.keyword} 출처 링크`)
    }
  }
})

test('정적 파일: 화면·공용 모듈은 주고, 서버 코드·설정은 주지 않는다', async () => {
  const ok = async (p, type) => {
    const res = await fetch(`${base}${p}`)
    assert.equal(res.status, 200, p)
    assert.match(res.headers.get('content-type'), type, p)
  }
  await ok('/', /text\/html/)
  await ok('/ops.html', /text\/html/)
  await ok('/js/main.js', /javascript/)
  await ok('/js/voice.js', /javascript/)
  await ok('/shared/hangul.js', /javascript/)
  await ok('/shared/style-analyzer.js', /javascript/)
  await ok('/shared/kakao-parser.js', /javascript/)
  await ok('/css/app.css', /text\/css/)
  for (const p of ['/server/config.js', '/server.js', '/package.json', '/.env', '/.env.example', '/data/events.jsonl', '/shared/../server/config.js', '/server/safety/lexicon.js']) {
    assert.equal((await fetch(`${base}${p}`)).status, 404, p)
  }
})

test('생성: 모든 예시 트렌드 × 예시 말투 세 가지로 후보가 나온다', async () => {
  const personas = SAMPLE_PERSONAS.map(payloadFor)
  let checked = 0
  for (const trend of trends) {
    const profile = personas[checked % personas.length]
    const res = await fetch(`${base}/api/generate`, json({ anonId: 'e2e-user', profile, trendId: trend.id, options: { situation: 'chat', spice: 'medium', topic: checked % 2 ? '떡볶이' : '' }, feedback: {} }))
    assert.equal(res.status, 200, `${trend.keyword}: ${res.status}`)
    const r = await res.json()
    assert.equal(r.engine.mode, 'local')
    assert.ok(r.requestId)
    assert.ok(r.candidates.length >= 3 && r.candidates.length <= LIMITS.candidates.count, `${trend.keyword}: 후보 ${r.candidates.length}개`)
    assert.ok(!('engine' in r.trend))
    assert.equal(r.safety.passed + r.safety.blocked <= r.safety.generated + 20, true)
    const texts = new Set()
    for (const c of r.candidates) {
      assert.ok(c.text && !/[{}]/.test(c.text) && !/undefined|null|NaN/.test(c.text), `${trend.keyword}: ${c.text}`)
      assert.ok(!/ {2,}/.test(c.text), `겹친 공백: ${c.text}`)
      assert.equal(c.examples.length, LIMITS.candidates.examplesPerCandidate, `${trend.keyword}: 예문 수`)
      for (const ex of c.examples) assert.ok(ex && !/[{}]/.test(ex) && !/undefined|null/.test(ex), `${trend.keyword} 예문: ${ex}`)
      assert.ok(TECHNIQUE_IDS.includes(c.technique))
      assert.ok(c.why)
      assert.ok(c.score >= 0 && c.score <= 1)
      assert.ok(!texts.has(c.text), `겹치는 후보: ${c.text}`)
      texts.add(c.text)
    }
    checked++
  }
  assert.ok(checked >= 20)
})

test('생성: 좋아요·별로예요와 이미 본 문구가 다음 결과에 반영된다', async () => {
  const profile = payloadFor(SAMPLE_PERSONAS[0])
  const trend = trends.find((t) => t.keyword.includes('오히려 좋아'))
  const body = { anonId: 'e2e-user', profile, trendId: trend.id, options: { situation: 'chat', spice: 'medium', topic: '' }, feedback: {} }
  const first = await (await fetch(`${base}/api/generate`, json(body))).json()
  const shown = first.candidates.map((c) => c.text)
  const second = await (await fetch(`${base}/api/generate`, json({ ...body, feedback: { liked: [], disliked: [], techniqueStats: {}, shown } }))).json()
  for (const c of second.candidates) assert.ok(!shown.includes(c.text), `이미 본 문구가 또 나옴: ${c.text}`)
})

test('생성: 직접 넣은 트렌드와 넣고 싶은 말', async () => {
  const check = await fetch(`${base}/api/trends/check`, json({ keyword: '주말 등산', meaning: '주말마다 산에 가는 것' }))
  assert.equal(check.status, 200)
  const { trend } = await check.json()
  assert.equal(trend.source.type, 'custom')
  const res = await fetch(`${base}/api/generate`, json({ anonId: 'e2e-user', profile: payloadFor(SAMPLE_PERSONAS[1]), customTrend: { keyword: trend.keyword, meaning: trend.meaning }, options: { situation: 'sns', spice: 'hot', topic: '' }, feedback: {} }))
  assert.equal(res.status, 200)
  const r = await res.json()
  assert.ok(r.candidates.length >= 3)
  assert.ok(r.candidates.some((c) => c.text.includes('등산')), '키워드가 후보에 들어간다')
})

test('안전: 쓸 수 없는 키워드와 넣고 싶은 말은 422로 막고, 걸린 낱말은 돌려주지 않는다', async () => {
  const bad = await fetch(`${base}/api/trends/check`, json({ keyword: '씨발', meaning: '' }))
  assert.equal(bad.status, 422)
  const badBody = await bad.json()
  assert.equal(badBody.error.code, 'blocked_input')
  assert.ok(!badBody.error.message.includes('씨발'))
  const trend = trends.find((t) => t.kind === 'pattern')
  const topic = await fetch(`${base}/api/generate`, json({ anonId: 'e2e-user', profile: payloadFor(SAMPLE_PERSONAS[0]), trendId: trend.id, options: { situation: 'chat', spice: 'medium', topic: '씨발' }, feedback: {} }))
  assert.equal(topic.status, 422)
  const empty = await fetch(`${base}/api/trends/check`, json({ keyword: '   ' }))
  assert.equal(empty.status, 400)
})

test('생성: 없는 트렌드는 404, 엉터리 요청에도 서버가 죽지 않는다', async () => {
  const missing = await fetch(`${base}/api/generate`, json({ profile: {}, trendId: 'seed-does-not-exist', options: {}, feedback: {} }))
  assert.equal(missing.status, 404)
  for (const body of [{}, { profile: 'x', trendId: 123, options: [], feedback: 'y' }, { profile: null, customTrend: { keyword: 12345 } }, { profile: { endings: [{}, null, 1], samples: 'no' }, trendId: trends[0].id, options: { situation: 'nope', spice: 9, topic: {} }, feedback: { liked: 'x', techniqueStats: [] } }]) {
    const res = await fetch(`${base}/api/generate`, json(body))
    assert.ok(res.status < 500, `상태 ${res.status} — ${JSON.stringify(body).slice(0, 60)}`)
  }
})

test('반응·신고가 운영 지표에 반영된다', async () => {
  const profile = payloadFor(SAMPLE_PERSONAS[2])
  const r = await (await fetch(`${base}/api/generate`, json({ anonId: 'metrics-user', profile, trendId: trends[0].id, options: {}, feedback: {} }))).json()
  const [c1, c2, c3] = r.candidates
  const ev = (body) => fetch(`${base}/api/events`, json({ anonId: 'metrics-user', requestId: r.requestId, ...body }))
  assert.equal((await ev({ type: 'like', candidateId: c1.id, technique: c1.technique })).status, 200)
  assert.equal((await ev({ type: 'save', candidateId: c1.id, technique: c1.technique })).status, 200)
  assert.equal((await ev({ type: 'share', candidateId: c2.id })).status, 200)
  assert.equal((await ev({ type: 'rating', value: 4 })).status, 200)
  assert.equal((await ev({ type: 'bogus', candidateId: c1.id })).status, 400)
  // 서버가 만들지 않은 요청에 대한 반응은 지표에 넣지 않는다
  const forged = await fetch(`${base}/api/events`, json({ anonId: 'x', type: 'rating', requestId: 'not-a-real-request', value: 5 }))
  assert.equal(forged.status, 400)
  const report = await fetch(`${base}/api/report`, json({ anonId: 'metrics-user', requestId: r.requestId, candidateId: c3.id, reason: 'other', text: c3.text, trendKeyword: r.trend.keyword, engine: 'local' }))
  assert.equal(report.status, 200)

  const overview = await (await fetch(`${base}/api/ops/overview`)).json()
  const m = overview.metrics.all
  assert.ok(m.counts.generations >= 1)
  assert.ok(m.saveShareRate.savedOrShared >= 2)
  assert.ok(m.styleScore.n >= 1)
  assert.ok(m.harmfulRate.reported >= 1)
  assert.equal(overview.engine.mode, 'local')
  assert.ok(!JSON.stringify(overview).includes('ANTHROPIC'), '비밀값 이름조차 응답에 없다')

  const reports = await (await fetch(`${base}/api/ops/reports`)).json()
  assert.ok(reports.reports.some((x) => x.text === c3.text))
})

test('운영: 트렌드 목록과 수집 — 키가 없으면 건너뛰고 예시 데이터는 고칠 수 없다', async () => {
  const list = await (await fetch(`${base}/api/ops/trends`)).json()
  assert.deepEqual(list.pending, [])
  assert.ok(list.seedCount >= 20)
  const collect = await (await fetch(`${base}/api/ops/collect`, json({}))).json()
  assert.equal(collect.report.ok, false)
  const seedEdit = await fetch(`${base}/api/ops/trends/${encodeURIComponent(trends[0].id)}`, json({ status: 'rejected' }))
  assert.equal(seedEdit.status, 400)
})
