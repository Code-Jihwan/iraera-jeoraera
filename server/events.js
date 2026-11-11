// 반응·신고 기록과 성공 지표 계산.
// 기록에는 문구 내용이나 말투 프로필을 남기지 않는다(신고된 문구만 검토용으로 따로 보관).
// 모든 기록은 보관 기간이 지나면 지운다(purge).
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { appendJsonl, readJson, readJsonl, rewriteJsonl, writeJsonAtomic } from './store.js'
import { EVENT_TYPES, LIMITS, REPORT_REASONS, RETENTION_DEFAULT_DAYS, TECHNIQUE_IDS } from '../shared/constants.js'
import { maskPII } from '../shared/pii.js'

const CLIENT_EVENT_TYPES = new Set(EVENT_TYPES.filter((t) => t !== 'expose'))
const REPORT_REASON_IDS = new Set(REPORT_REASONS.map((r) => r.id))
const MAX_EVENTS_READ = 200_000
const MAX_KNOWN_REQUESTS = 50_000
const DAY_MS = 24 * 3600 * 1000

const cleanId = (v, max = 80) => {
  const s = String(v ?? '').trim()
  return /^[A-Za-z0-9_.:-]+$/.test(s) && s.length <= max ? s : ''
}
const cleanText = (v, max) =>
  String(v ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, max)

const round = (n, d = 2) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null)
const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null)

function percentile(sorted, p) {
  if (!sorted.length) return null
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))
  return sorted[idx]
}

const positiveDays = (v, d) => (Number.isFinite(v) && v > 0 ? v : d)

/**
 * @param {{ dataDir: string, now?: () => number, retention?: { events?: number, reports?: number } }} opts
 */
export function createEventLog({ dataDir, now = () => Date.now(), retention = RETENTION_DEFAULT_DAYS }) {
  const eventsFile = path.join(dataDir, 'events.jsonl')
  const reportsFile = path.join(dataDir, 'reports.jsonl')
  const saltFile = path.join(dataDir, 'salt.json')
  const days = { events: positiveDays(retention?.events, RETENTION_DEFAULT_DAYS.events), reports: positiveDays(retention?.reports, RETENTION_DEFAULT_DAYS.reports) }
  let salt = null
  // 서버가 실제로 만들어 준 생성 요청 — 반응·신고는 이 요청에 대해서만 받는다(지표 조작 방지)
  const known = new Map()
  let knownLoaded = null

  async function getSalt() {
    if (salt) return salt
    const saved = await readJson(saltFile, null)
    if (saved && typeof saved.salt === 'string' && saved.salt.length >= 16) {
      salt = saved.salt
    } else {
      salt = randomBytes(16).toString('hex')
      await writeJsonAtomic(saltFile, { salt })
    }
    return salt
  }

  /** 브라우저가 만든 익명 ID를 그대로 두지 않고 서버 소금으로 한 번 더 해시한다. */
  async function anonKey(anonId) {
    const id = cleanId(anonId, 64)
    if (!id) return 'anon'
    return createHash('sha256').update(`${await getSalt()}:${id}`).digest('hex').slice(0, 12)
  }

  function remember(requestId, shown, ts) {
    if (!requestId) return
    known.delete(requestId)
    known.set(requestId, { shown, ts })
    while (known.size > MAX_KNOWN_REQUESTS) known.delete(known.keys().next().value)
  }

  /** 다시 켜졌을 때도 보관 기간 안의 생성 요청을 알아보도록, 처음 한 번 기록에서 읽어 둔다. */
  function loadKnown() {
    if (!knownLoaded) {
      knownLoaded = readJsonl(eventsFile, { limit: MAX_EVENTS_READ }).then((rows) => {
        const cutoff = now() - days.events * DAY_MS
        for (const e of rows) if (e?.type === 'generate' && e.ts >= cutoff && !known.has(e.requestId)) remember(e.requestId, Number(e.shown) || 0, e.ts)
      })
    }
    return knownLoaded
  }

  /** 서버가 만든 요청과 그 요청의 후보 번호인지 */
  async function isKnown(requestId, candidateId = null) {
    await loadKnown()
    const req = known.get(requestId)
    if (!req || req.ts < now() - days.events * DAY_MS) return false
    if (candidateId === null) return true
    const m = new RegExp(`^${requestId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-(\\d{1,3})$`).exec(candidateId)
    const n = m ? Number(m[1]) : 0
    return n >= 1 && n <= Math.max(req.shown, LIMITS.candidates.count)
  }

  /** 생성 한 번의 집계 기록 (서버가 직접 남긴다) */
  async function recordGeneration({ requestId, anonId, trend, engine, safety, candidateCount, hasVoice, hasText, sample = false }) {
    const ts = now()
    const id = cleanId(requestId)
    const shown = Number(candidateCount) || 0
    remember(id, shown, ts)
    const custom = !trend || trend.source?.type === 'custom'
    await appendJsonl(eventsFile, {
      ts,
      type: 'generate',
      anon: await anonKey(anonId),
      requestId: id,
      // 직접 넣은 트렌드는 키워드를 짐작할 수 있는 ID 대신 'custom'으로만 남긴다
      trendId: custom ? 'custom' : cleanId(trend.id) || 'unknown',
      trendSource: custom ? 'custom' : trend.source?.type || 'seed',
      engine: engine?.mode === 'llm' ? 'llm' : 'local',
      fallback: Boolean(engine?.fallbackReason),
      generated: Number(safety?.generated) || 0,
      blocked: Number(safety?.blocked) || 0,
      shown,
      hasVoice: Boolean(hasVoice),
      hasText: Boolean(hasText),
      sample: Boolean(sample),
    })
  }

  /**
   * 브라우저에서 온 반응 이벤트. 형식이 맞지 않거나 서버가 만든 요청이 아니면 false.
   * @returns {Promise<boolean>}
   */
  async function recordClientEvent(raw) {
    const type = String(raw?.type ?? '')
    if (!CLIENT_EVENT_TYPES.has(type)) return false
    const requestId = cleanId(raw.requestId)
    if (!requestId) return false
    const evt = { ts: now(), type, anon: await anonKey(raw.anonId), requestId }
    if (type === 'rating') {
      const value = Number(raw.value)
      if (!Number.isInteger(value) || value < 1 || value > 5) return false
      if (!(await isKnown(requestId))) return false
      evt.value = value
    } else {
      const candidateId = cleanId(raw.candidateId)
      if (!candidateId || !(await isKnown(requestId, candidateId))) return false
      evt.candidateId = candidateId
      if (TECHNIQUE_IDS.includes(raw.technique)) evt.technique = raw.technique
    }
    await appendJsonl(eventsFile, evt)
    return true
  }

  /** 신고. 검토를 위해 신고된 문구만 저장하고, 연락처 같은 부분은 가린다. */
  async function recordReport(raw) {
    const reason = String(raw?.reason ?? '')
    const requestId = cleanId(raw?.requestId)
    const candidateId = cleanId(raw?.candidateId)
    const text = maskPII(cleanText(raw?.text, 80)).text
    if (!REPORT_REASON_IDS.has(reason) || !requestId || !candidateId || !text) return false
    if (!(await isKnown(requestId, candidateId))) return false
    const ts = now()
    const anon = await anonKey(raw.anonId)
    await appendJsonl(reportsFile, {
      ts,
      anon,
      requestId,
      candidateId,
      reason,
      text,
      trendKeyword: maskPII(cleanText(raw.trendKeyword, 40)).text,
      engine: raw.engine === 'llm' ? 'llm' : 'local',
      note: maskPII(cleanText(raw.note, 200)).text,
    })
    await appendJsonl(eventsFile, { ts, type: 'report', anon, requestId, candidateId, reason })
    return true
  }

  async function listReports({ limit = 100 } = {}) {
    const rows = await readJsonl(reportsFile, { limit })
    return rows.reverse()
  }

  /** 보관 기간이 지난 기록을 지운다. */
  async function purge() {
    const t = now()
    const eventsCutoff = t - days.events * DAY_MS
    const reportsCutoff = t - days.reports * DAY_MS
    const [ev, rp] = await Promise.all([
      rewriteJsonl(eventsFile, (row) => Number(row?.ts) >= eventsCutoff),
      rewriteJsonl(reportsFile, (row) => Number(row?.ts) >= reportsCutoff),
    ])
    for (const [id, req] of known) if (req.ts < eventsCutoff) known.delete(id)
    return { events: ev.removed, reports: rp.removed }
  }

  /**
   * 기획안의 성공 지표 네 가지와 보조 수치.
   * @param {{ latencyHours?: number[], sinceMs?: number|null }} [opts]
   */
  async function metrics({ latencyHours = [], sinceMs = null } = {}) {
    const rows = await readJsonl(eventsFile, { limit: MAX_EVENTS_READ })
    return computeMetrics(rows, { latencyHours, sinceMs, at: now() })
  }

  /** 운영 화면용: 파일을 한 번만 읽어 전체 기간과 최근 기간을 함께 계산한다. */
  async function overview({ latencyHours = [], sinceMs = null } = {}) {
    const rows = await readJsonl(eventsFile, { limit: MAX_EVENTS_READ })
    const at = now()
    return { all: computeMetrics(rows, { latencyHours, at }), recent: computeMetrics(rows, { latencyHours, sinceMs, at }) }
  }

  return { recordGeneration, recordClientEvent, recordReport, listReports, metrics, overview, purge, retentionDays: days }
}

/** 기록 줄들로 지표를 계산한다(파일을 읽지 않는 순수 함수). */
export function computeMetrics(allRows, { latencyHours = [], sinceMs = null, at = Date.now() } = {}) {
  const events = sinceMs ? allRows.filter((e) => e.ts >= sinceMs) : allRows

  const generations = new Map()
  let generated = 0
  let blocked = 0
  let shown = 0
  let llmRuns = 0
  let fallbacks = 0
  for (const e of events) {
    if (e.type !== 'generate') continue
    generations.set(e.requestId, e)
    generated += e.generated || 0
    blocked += e.blocked || 0
    shown += e.shown || 0
    if (e.engine === 'llm') llmRuns++
    if (e.fallback) fallbacks++
  }

  // 평가는 생성 한 번에 한 사람당 마지막 값만 센다. 서버가 만든 생성에 대한 반응만 센다.
  const ratings = new Map()
  const saveState = new Map()
  const shared = new Set()
  const reported = new Set()
  const reaction = new Map()
  for (const e of events) {
    if (e.type === 'generate' || !generations.has(e.requestId)) continue
    const candKey = `${e.requestId}|${e.candidateId}`
    switch (e.type) {
      case 'rating':
        ratings.set(`${e.requestId}|${e.anon}`, e)
        break
      case 'save':
        saveState.set(candKey, true)
        break
      case 'unsave':
        saveState.set(candKey, false)
        break
      case 'share':
        shared.add(candKey)
        break
      case 'report':
        reported.add(candKey)
        break
      case 'like':
      case 'dislike':
        reaction.set(`${candKey}|${e.anon}`, { kind: e.type, technique: e.technique })
        break
      case 'clear_reaction':
        reaction.delete(`${candKey}|${e.anon}`)
        break
      default:
        break
    }
  }

  // 예시 말투로 만든 결과의 평가는 ‘내 말투 같다’에서 빼고 따로 보인다
  const ratingValues = []
  const sampleValues = []
  const byProfile = { voiceAndText: [], textOnly: [], voiceOnly: [] }
  for (const r of ratings.values()) {
    const g = generations.get(r.requestId)
    if (g?.sample) {
      sampleValues.push(r.value)
      continue
    }
    ratingValues.push(r.value)
    if (!g) continue
    if (g.hasVoice && g.hasText) byProfile.voiceAndText.push(r.value)
    else if (g.hasVoice) byProfile.voiceOnly.push(r.value)
    else byProfile.textOnly.push(r.value)
  }

  const savedOrShared = new Set(shared)
  for (const [k, v] of saveState) if (v) savedOrShared.add(k)

  let likes = 0
  let dislikes = 0
  const techniques = Object.fromEntries(TECHNIQUE_IDS.map((t) => [t, { up: 0, down: 0 }]))
  for (const r of reaction.values()) {
    if (r.kind === 'like') likes++
    else dislikes++
    if (r.technique && techniques[r.technique]) techniques[r.technique][r.kind === 'like' ? 'up' : 'down']++
  }

  const sortedLatency = latencyHours.filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b)

  return {
    generatedAt: new Date(at).toISOString(),
    counts: {
      generations: generations.size,
      candidatesGenerated: generated,
      candidatesShown: shown,
      llmRuns,
      fallbacks,
      likes,
      dislikes,
      ratings: ratingValues.length,
      reports: reported.size,
    },
    // ① 내 말투 같다 (5점 척도 평균)
    styleScore: {
      average: round(avg(ratingValues)),
      n: ratingValues.length,
      // 기획안의 검증 과제: 음성을 더하면 글만 쓸 때보다 나아지는가
      byProfile: {
        voiceAndText: { average: round(avg(byProfile.voiceAndText)), n: byProfile.voiceAndText.length },
        textOnly: { average: round(avg(byProfile.textOnly)), n: byProfile.textOnly.length },
        voiceOnly: { average: round(avg(byProfile.voiceOnly)), n: byProfile.voiceOnly.length },
      },
      samplePersona: { average: round(avg(sampleValues)), n: sampleValues.length },
    },
    // ② 저장·공유율 (보여 준 후보 중 저장하거나 공유한 비율)
    saveShareRate: { percent: shown ? round((savedOrShared.size / shown) * 100, 1) : null, savedOrShared: savedOrShared.size, shown },
    // ③ 트렌드 반영 속도 (수집 → 서비스 노출까지 걸린 시간)
    trendLatency: {
      medianHours: round(percentile(sortedLatency, 0.5)),
      p90Hours: round(percentile(sortedLatency, 0.9)),
      n: sortedLatency.length,
    },
    // ④ 유해 생성물 비율 (안전 필터에 막히거나 신고된 결과의 비율)
    harmfulRate: {
      percent: generated ? round(((blocked + reported.size) / generated) * 100, 2) : null,
      blocked,
      reported: reported.size,
      generated,
    },
    techniques,
  }
}
