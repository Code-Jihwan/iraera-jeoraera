// 반응 기록과 성공 지표 계산
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createEventLog } from '../server/events.js'
import { flushWrites } from '../server/store.js'

let dir
let clock
let log

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'events-test-'))
  clock = 1_800_000_000_000
  log = createEventLog({ dataDir: dir, now: () => clock })
})

afterEach(async () => {
  await flushWrites()
  await rm(dir, { recursive: true, force: true })
})

const gen = (requestId, extra = {}) => ({
  requestId,
  anonId: 'user-1',
  trend: { id: 'seed-x', source: { type: 'seed' } },
  engine: { mode: 'local', fallbackReason: null },
  safety: { generated: 10, blocked: 1 },
  candidateCount: 5,
  hasVoice: false,
  hasText: true,
  ...extra,
})

test('지표: 저장·공유율, 유해 비율, 말투 점수', async () => {
  await log.recordGeneration(gen('r1'))
  await log.recordGeneration(gen('r2', { hasVoice: true, safety: { generated: 10, blocked: 0 } }))
  assert.equal(await log.recordClientEvent({ anonId: 'user-1', type: 'save', requestId: 'r1', candidateId: 'r1-1', technique: 'ending' }), true)
  assert.equal(await log.recordClientEvent({ anonId: 'user-1', type: 'share', requestId: 'r1', candidateId: 'r1-2' }), true)
  assert.equal(await log.recordClientEvent({ anonId: 'user-1', type: 'save', requestId: 'r2', candidateId: 'r2-1' }), true)
  assert.equal(await log.recordClientEvent({ anonId: 'user-1', type: 'unsave', requestId: 'r2', candidateId: 'r2-1' }), true)
  assert.equal(await log.recordClientEvent({ anonId: 'user-1', type: 'rating', requestId: 'r1', value: 3 }), true)
  assert.equal(await log.recordClientEvent({ anonId: 'user-1', type: 'rating', requestId: 'r1', value: 4 }), true)
  assert.equal(await log.recordClientEvent({ anonId: 'user-1', type: 'rating', requestId: 'r2', value: 5 }), true)
  assert.equal(await log.recordReport({ anonId: 'user-1', requestId: 'r1', candidateId: 'r1-3', reason: 'hate', text: '문구', trendKeyword: '밈' }), true)

  const m = await log.metrics({ latencyHours: [2, 10, 4] })
  assert.equal(m.counts.generations, 2)
  assert.equal(m.counts.candidatesShown, 10)
  // 저장했다가 뺀 후보는 세지 않는다: 저장 1 + 공유 1 = 2 / 10
  assert.equal(m.saveShareRate.savedOrShared, 2)
  assert.equal(m.saveShareRate.percent, 20)
  // 같은 생성에 대한 평가는 마지막 값만: (4 + 5) / 2
  assert.equal(m.styleScore.n, 2)
  assert.equal(m.styleScore.average, 4.5)
  assert.equal(m.styleScore.byProfile.textOnly.average, 4)
  assert.equal(m.styleScore.byProfile.voiceAndText.average, 5)
  // 유해 비율: (차단 1 + 신고 1) / 생성 20
  assert.equal(m.harmfulRate.percent, 10)
  assert.equal(m.trendLatency.medianHours, 4)
  assert.equal(m.trendLatency.p90Hours, 10)
  assert.equal(m.trendLatency.n, 3)
})

test('지표: 데이터가 없으면 null로 돌려준다', async () => {
  const m = await log.metrics()
  assert.equal(m.styleScore.average, null)
  assert.equal(m.saveShareRate.percent, null)
  assert.equal(m.harmfulRate.percent, null)
  assert.equal(m.trendLatency.medianHours, null)
})

test('좋아요·별로예요는 마지막 반응만 세고 방식별로 쌓인다', async () => {
  await log.recordGeneration(gen('r1'))
  const e = (type, candidateId, technique) => log.recordClientEvent({ anonId: 'user-1', type, requestId: 'r1', candidateId, technique })
  await e('like', 'r1-1', 'ending')
  await e('dislike', 'r1-1', 'ending')
  await e('like', 'r1-2', 'slot')
  await e('like', 'r1-3', 'twist')
  await e('clear_reaction', 'r1-3', 'twist')
  const m = await log.metrics()
  assert.equal(m.counts.likes, 1)
  assert.equal(m.counts.dislikes, 1)
  assert.deepEqual(m.techniques.ending, { up: 0, down: 1 })
  assert.deepEqual(m.techniques.slot, { up: 1, down: 0 })
  assert.deepEqual(m.techniques.twist, { up: 0, down: 0 })
})

test('기간 필터', async () => {
  await log.recordGeneration(gen('old'))
  clock += 10 * 24 * 3600 * 1000
  await log.recordGeneration(gen('new'))
  const week = await log.metrics({ sinceMs: clock - 7 * 24 * 3600 * 1000 })
  assert.equal(week.counts.generations, 1)
  const all = await log.metrics()
  assert.equal(all.counts.generations, 2)
})

test('형식이 틀린 반응은 기록하지 않는다', async () => {
  assert.equal(await log.recordClientEvent(null), false)
  assert.equal(await log.recordClientEvent({ type: 'hack', requestId: 'r1', candidateId: 'c' }), false)
  assert.equal(await log.recordClientEvent({ type: 'like', requestId: '', candidateId: 'c' }), false)
  assert.equal(await log.recordClientEvent({ type: 'like', requestId: 'r1', candidateId: '<script>' }), false)
  assert.equal(await log.recordClientEvent({ type: 'rating', requestId: 'r1', value: 9 }), false)
  assert.equal(await log.recordClientEvent({ type: 'rating', requestId: 'r1', value: 2.5 }), false)
  assert.equal(await log.recordClientEvent({ type: 'expose', requestId: 'r1', candidateId: 'c' }), false)
  assert.equal(await log.recordReport({ requestId: 'r1', candidateId: 'c', reason: 'nope', text: 'x' }), false)
  assert.equal(await log.recordReport({ requestId: 'r1', candidateId: 'c', reason: 'hate', text: '' }), false)
})

test('익명 ID는 원래 값 그대로 저장하지 않고, 문구 내용도 이벤트 기록에 남기지 않는다', async () => {
  await log.recordGeneration(gen('r1', { anonId: 'my-device-id-123' }))
  await log.recordClientEvent({ anonId: 'my-device-id-123', type: 'like', requestId: 'r1', candidateId: 'r1-1', technique: 'ending', text: '몰래 넣은 문구' })
  await flushWrites()
  const raw = await readFile(path.join(dir, 'events.jsonl'), 'utf8')
  assert.ok(!raw.includes('my-device-id-123'))
  assert.ok(!raw.includes('몰래 넣은 문구'))
  const lines = raw.trim().split('\n').map((l) => JSON.parse(l))
  assert.equal(lines[0].anon, lines[1].anon)
  assert.match(lines[0].anon, /^[0-9a-f]{12}$/)
})

test('신고 목록은 최근 것부터, 문구는 길이를 자른다', async () => {
  await log.recordGeneration(gen('r1'))
  assert.equal(await log.recordReport({ anonId: 'u', requestId: 'r1', candidateId: 'r1-1', reason: 'other', text: '가'.repeat(300), note: '메모' }), true)
  clock += 1000
  assert.equal(await log.recordReport({ anonId: 'u', requestId: 'r1', candidateId: 'r1-2', reason: 'sexual', text: '둘째' }), true)
  const list = await log.listReports()
  assert.equal(list.length, 2)
  assert.equal(list[0].text, '둘째')
  assert.equal(list[1].text.length, 80)
})

test('서버가 만든 생성 요청과 후보 번호에 대해서만 반응·신고를 받는다', async () => {
  await log.recordGeneration(gen('r9', { candidateCount: 3 }))
  const ev = (body) => log.recordClientEvent({ anonId: 'u', ...body })
  assert.equal(await ev({ type: 'like', requestId: 'not-issued', candidateId: 'not-issued-1' }), false)
  assert.equal(await ev({ type: 'rating', requestId: 'not-issued', value: 5 }), false)
  assert.equal(await ev({ type: 'like', requestId: 'r9', candidateId: 'r9-9' }), false, '보여 준 후보 수를 넘는 번호')
  assert.equal(await ev({ type: 'like', requestId: 'r9', candidateId: 'other-1' }), false, '다른 요청의 후보 번호')
  assert.equal(await ev({ type: 'like', requestId: 'r9', candidateId: 'r9-2' }), true)
  assert.equal(await log.recordReport({ requestId: 'fake', candidateId: 'fake-1', reason: 'hate', text: '문구' }), false)
})

test('다시 켜도 보관 기간 안의 생성 요청은 알아본다', async () => {
  await log.recordGeneration(gen('r-old'))
  await flushWrites()
  const restarted = createEventLog({ dataDir: dir, now: () => clock })
  assert.equal(await restarted.recordClientEvent({ type: 'save', requestId: 'r-old', candidateId: 'r-old-1' }), true)
})

test('신고 문구·덧붙인 말의 연락처는 가려서 저장한다', async () => {
  await log.recordGeneration(gen('r1'))
  await log.recordReport({ anonId: 'u', requestId: 'r1', candidateId: 'r1-1', reason: 'other', text: '연락은 010-1234-5678', note: '메일 me@example.com 으로 답 주세요' })
  await flushWrites()
  const raw = await readFile(path.join(dir, 'reports.jsonl'), 'utf8')
  assert.ok(!raw.includes('010-1234-5678'))
  assert.ok(!raw.includes('me@example.com'))
})

test('직접 넣은 트렌드는 키워드를 짐작할 수 있는 ID 대신 custom으로만 남긴다', async () => {
  await log.recordGeneration(gen('r1', { trend: { id: 'custom-3f9a1c2b', source: { type: 'custom' }, keyword: '비밀 키워드' } }))
  await flushWrites()
  const raw = await readFile(path.join(dir, 'events.jsonl'), 'utf8')
  assert.ok(!raw.includes('3f9a1c2b'))
  assert.ok(!raw.includes('비밀 키워드'))
  assert.equal(JSON.parse(raw.trim().split('\n')[0]).trendId, 'custom')
})

test('보관 기간이 지난 반응·신고 기록은 지운다', async () => {
  const short = createEventLog({ dataDir: dir, now: () => clock, retention: { events: 30, reports: 10 } })
  await short.recordGeneration(gen('old'))
  await short.recordReport({ anonId: 'u', requestId: 'old', candidateId: 'old-1', reason: 'other', text: '오래된 신고' })
  clock += 20 * 24 * 3600 * 1000
  await short.recordGeneration(gen('new'))
  let removed = await short.purge()
  assert.deepEqual(removed, { events: 0, reports: 1 }, '신고만 10일이 지났다')
  clock += 15 * 24 * 3600 * 1000
  removed = await short.purge()
  assert.equal(removed.events, 2, '35일 지난 생성 기록과 신고 이벤트')
  const m = await short.metrics()
  assert.equal(m.counts.generations, 1)
  assert.equal(await short.recordClientEvent({ type: 'like', requestId: 'old', candidateId: 'old-1' }), false, '지운 요청은 더 받지 않는다')
})

test('예시 말투로 만든 결과의 평가는 ‘내 말투 같다’에서 따로 센다', async () => {
  await log.recordGeneration(gen('mine'))
  await log.recordGeneration(gen('demo', { sample: true }))
  await log.recordClientEvent({ anonId: 'u', type: 'rating', requestId: 'mine', value: 4 })
  await log.recordClientEvent({ anonId: 'u', type: 'rating', requestId: 'demo', value: 1 })
  const m = await log.metrics()
  assert.equal(m.styleScore.average, 4)
  assert.equal(m.styleScore.n, 1)
  assert.deepEqual(m.styleScore.samplePersona, { average: 1, n: 1 })
})

test('운영 개요는 파일을 한 번 읽어 전체와 최근 기간을 함께 낸다', async () => {
  await log.recordGeneration(gen('a'))
  clock += 10 * 24 * 3600 * 1000
  await log.recordGeneration(gen('b'))
  const o = await log.overview({ sinceMs: clock - 7 * 24 * 3600 * 1000 })
  assert.equal(o.all.counts.generations, 2)
  assert.equal(o.recent.counts.generations, 1)
})
