// 트렌드 저장소: 예시(seed) 데이터와 수집 데이터(data/trends.json)를 함께 다룬다.
// 수집 데이터는 사람 검수 상태(pending → approved / rejected)를 갖고, 차트에서 마지막으로 본 뒤 ttlDays가 지나면 지운다.
import { createHash } from 'node:crypto'
import path from 'node:path'
import { TREND_CATEGORIES } from '../../shared/constants.js'
import { readJson, writeJsonAtomic } from '../store.js'

export const TREND_KINDS = Object.freeze(['pattern', 'phrase', 'word', 'keyword'])

const STATUSES = ['approved', 'pending', 'rejected']
// 운영자가 검수하면서 고칠 수 있는 항목
const EDITABLE_FIELDS = ['meaning', 'origin', 'caution', 'category', 'pattern']
// 뜻이 비어 있던 미검수 항목이 새 수집 결과에서 넘겨받는 설명 항목
const DESCRIPTIVE_FIELDS = ['kind', 'pattern', 'meaning', 'origin', 'caution', 'category']
const LIVE_FILE = 'trends.json'
const DAY_MS = 86_400_000
const DEFAULT_TTL_DAYS = 7
// YouTube 정책(III.E.4.d): API로 받은 데이터는 30일 안에 갱신하거나 지워야 한다
const MAX_TTL_DAYS = 30
const TEXT_MAX = 300
const KEYWORD_MAX = 40
const LABEL_MAX = 40
const TAG_MAX = 100
const URL_MAX = 200
const DRAFTS_MAX = 500
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]+/g

export class TrendStoreError extends Error {
  /**
   * @param {'bad_status'|'seed_readonly'|'not_found'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message)
    this.name = 'TrendStoreError'
    this.code = code
  }
}

/** 문자열을 한 줄로 다듬고 글자 수(코드 포인트)를 제한한다. 문자열이 아니면 빈 문자열. */
export function clipText(value, max) {
  if (typeof value !== 'string') return ''
  const text = value.slice(0, max * 4).replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim()
  return Array.from(text).slice(0, max).join('').trim()
}

/**
 * 표기를 맞춘다: 풀어 쓴 한글은 완성형으로, 전각 영문·숫자·기호는 반각으로.
 * NFKC는 쓰지 않는다 — ㅋㅋ·ㅠㅠ 같은 호환 자모를 조합용 자모로 바꿔 버려 글자가 깨져 보인다.
 */
export function foldText(text) {
  return text
    .normalize('NFC')
    .replace(/[\uff01-\uff5e]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
}

/** 같은 말인지 견줄 때 쓰는 열쇠: 소문자로 바꾸고 띄어쓰기·기호를 뺀다. */
export function normalizeKeyword(text) {
  if (typeof text !== 'string') return ''
  return foldText(text).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

const toIso = (ms) => new Date(ms).toISOString()
/** 시각 문자열을 한 가지 표기(ISO, UTC)로 맞춘다. 읽을 수 없으면 null. */
function isoOrNull(value) {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isNaN(ms) ? null : toIso(ms)
}
const isHttpsUrl = (value) => typeof value === 'string' && value.length <= URL_MAX && /^https:\/\/[^\s<>"']+$/.test(value)
const liveId = (key) => `yt-${createHash('sha256').update(key).digest('hex').slice(0, 10)}`

/** 점수 높은 순, 같으면 가나다(코드 포인트) 순. 수집 트렌드와 초안을 같은 기준으로 줄 세운다. */
export const byScore = (a, b) => b.score - a.score || (a.keyword < b.keyword ? -1 : a.keyword > b.keyword ? 1 : 0)

/** 출처는 링크로만 남긴다. 영상 제목은 저장하지 않는다. */
function readSource(source) {
  return { type: 'youtube', label: clipText(source?.label, LABEL_MAX) || 'YouTube 인기 차트', url: isHttpsUrl(source?.url) ? source.url : null, title: null }
}

/** 인스타그램 반응은 유튜브 데이터와 섞지 않고 이 칸에만 둔다(점수에 넣지 않는다). */
function readInstagram(value) {
  const tag = clipText(value?.tag, TAG_MAX)
  const checkedAt = isoOrNull(value?.checkedAt)
  if (!tag || !checkedAt || !Number.isInteger(value.mediaCount) || value.mediaCount < 0) return null
  return { tag, mediaCount: value.mediaCount, checkedAt }
}

/** 바깥에서 온 초안(또는 저장 파일의 한 줄)을 믿을 수 있는 모양으로 읽는다. 쓸 수 없으면 null. */
function readDraft(draft) {
  const keyword = clipText(draft?.keyword, KEYWORD_MAX)
  const key = normalizeKeyword(keyword)
  if (!key) return null
  const videoCount = draft.stats?.videoCount
  return {
    key,
    keyword,
    kind: TREND_KINDS.includes(draft.kind) ? draft.kind : 'keyword',
    pattern: clipText(draft.pattern, TEXT_MAX) || null,
    meaning: clipText(draft.meaning, TEXT_MAX),
    origin: clipText(draft.origin, TEXT_MAX),
    caution: clipText(draft.caution, TEXT_MAX),
    category: TREND_CATEGORIES.includes(draft.category) ? draft.category : '일상',
    source: readSource(draft.source),
    stats: { videoCount: Number.isInteger(videoCount) && videoCount > 0 ? videoCount : 0 },
    instagram: readInstagram(draft.instagram),
    collectedAt: isoOrNull(draft.collectedAt),
    score: Number.isFinite(draft.score) ? draft.score : 0,
  }
}

function createLive(draft, nowIso, autoApprove) {
  const { key, score, collectedAt, ...described } = draft
  return {
    id: liveId(key),
    ...described,
    collectedAt: collectedAt ?? nowIso,
    publishedAt: autoApprove ? nowIso : null,
    status: autoApprove ? 'approved' : 'pending',
    sample: false,
    meaningVerified: false,
    lastSeenAt: nowIso,
    score,
  }
}

/** 저장 파일의 한 줄을 되살린다. 손상된 줄은 버린다. */
function reviveLive(item) {
  const draft = readDraft(item)
  const lastSeenAt = isoOrNull(item?.lastSeenAt)
  if (!draft || !lastSeenAt || !STATUSES.includes(item.status)) return null
  return {
    ...createLive(draft, lastSeenAt, false),
    publishedAt: isoOrNull(item.publishedAt),
    status: item.status,
    meaningVerified: item.meaningVerified === true,
  }
}

/** 이미 있는 수집 트렌드를 이번 수집 결과로 갱신한다. 검수 상태는 건드리지 않는다. */
function refreshLive(trend, draft, nowIso) {
  trend.stats = draft.stats
  trend.score = draft.score
  trend.lastSeenAt = nowIso
  if (draft.source.url) trend.source = draft.source
  if (draft.instagram) trend.instagram = draft.instagram
  // 사람이 확인하기 전이고 뜻이 비어 있었다면, 뜻을 가져온 새 결과의 설명을 받아들인다
  if (!trend.meaningVerified && !trend.meaning && draft.meaning) {
    for (const field of DESCRIPTIVE_FIELDS) trend[field] = draft[field]
  }
}

function readEdits(edits) {
  const changes = {}
  for (const field of EDITABLE_FIELDS) {
    if (typeof edits?.[field] === 'string') changes[field] = clipText(edits[field], TEXT_MAX)
  }
  if ('category' in changes && !TREND_CATEGORIES.includes(changes.category)) delete changes.category
  if ('pattern' in changes) changes.pattern ||= null
  return changes
}

const isSeedShape = (item) => typeof item?.id === 'string' && typeof item.keyword === 'string'
const toSeedTrend = (item) => ({ ...item, stats: item.stats ?? null, status: 'approved', sample: true, collectedAt: null, publishedAt: null })

/**
 * @param {{ dataDir: string, seedPath?: string, ttlDays?: number, now?: () => number }} opts
 */
export function createTrendStore({ dataDir, seedPath, ttlDays = DEFAULT_TTL_DAYS, now = () => Date.now() } = {}) {
  if (typeof dataDir !== 'string' || !dataDir) throw new TypeError('트렌드를 저장할 폴더(dataDir)가 필요합니다.')
  const liveFile = path.join(dataDir, LIVE_FILE)
  const ttlMs = Math.min(Number.isFinite(ttlDays) && ttlDays > 0 ? ttlDays : DEFAULT_TTL_DAYS, MAX_TTL_DAYS) * DAY_MS

  let seeds = []
  let seedKeys = new Set()
  /** @type {Map<string, any>} id → 수집 트렌드 */
  const live = new Map()

  // 보관 기간이 지난 항목은 정리 작업이 돌기 전이라도 내보내지 않는다
  const isFresh = (trend) => now() - Date.parse(trend.lastSeenAt) <= ttlMs
  const freshLive = () => [...live.values()].filter(isFresh)
  const persist = () => writeJsonAtomic(liveFile, { version: 1, updatedAt: toIso(now()), trends: [...live.values()] })

  async function purgeExpired() {
    const expired = [...live.values()].filter((trend) => !isFresh(trend))
    for (const trend of expired) live.delete(trend.id)
    if (expired.length > 0) await persist()
    return expired.length
  }

  return {
    /** 예시 데이터와 저장된 수집 데이터를 읽는다. 다른 메서드보다 먼저 한 번 부른다. */
    async init() {
      const seedFile = seedPath ? await readJson(seedPath, null) : null
      seeds = (Array.isArray(seedFile?.trends) ? seedFile.trends : []).filter(isSeedShape).map(toSeedTrend)
      seedKeys = new Set(seeds.map((trend) => normalizeKeyword(trend.keyword)))
      const saved = await readJson(liveFile, null)
      live.clear()
      for (const item of Array.isArray(saved?.trends) ? saved.trends : []) {
        const trend = reviveLive(item)
        if (trend) live.set(trend.id, trend)
      }
      await purgeExpired()
    },

    /**
     * 수집 트렌드(점수 높은 순) 다음에 예시 트렌드(파일 순서)를 돌려준다.
     * @param {{ status?: 'approved'|'pending'|'rejected', includeSeed?: boolean }} [options]
     */
    list(options) {
      const { status = 'approved', includeSeed = true } = options ?? {}
      const collected = freshLive().filter((trend) => trend.status === status).sort(byScore)
      const samples = includeSeed && status === 'approved' ? seeds : []
      return structuredClone([...collected, ...samples])
    },

    /** @returns {object|null} 예시 또는 수집 트렌드. 없으면 null */
    get(id) {
      const trend = seeds.find((seed) => seed.id === id) ?? live.get(id)
      return trend && (trend.sample || isFresh(trend)) ? structuredClone(trend) : null
    },

    /** 키워드형 트렌드에 틀로 빌려 쓸 수 있는 예시 트렌드 */
    frames() {
      return structuredClone(seeds.filter((trend) => trend.engine?.asFrame === true))
    },

    /**
     * 수집 초안을 반영한다. 같은 키워드(띄어쓰기·대소문자 무시)는 한 항목으로 본다.
     * @param {object[]} drafts
     * @param {{ reviewMode?: 'manual'|'auto' }} [options] auto면 새 항목을 바로 노출하고, 아니면 검수 대기로 둔다
     * @returns {Promise<{ added: number, updated: number }>}
     */
    async upsertDrafts(drafts, options) {
      const autoApprove = options?.reviewMode === 'auto'
      const nowIso = toIso(now())
      const seen = new Set()
      let added = 0
      let updated = 0
      for (const raw of Array.isArray(drafts) ? drafts.slice(0, DRAFTS_MAX) : []) {
        const draft = readDraft(raw)
        // 예시 트렌드와 같은 말은 뜻·유래가 정리된 예시 쪽만 남긴다
        if (!draft || seen.has(draft.key) || seedKeys.has(draft.key)) continue
        seen.add(draft.key)
        const existing = live.get(liveId(draft.key))
        if (existing) {
          refreshLive(existing, draft, nowIso)
          updated++
        } else {
          const trend = createLive(draft, nowIso, autoApprove)
          live.set(trend.id, trend)
          added++
        }
      }
      if (added + updated > 0) await persist()
      return { added, updated }
    },

    /**
     * 검수 결과를 반영한다. 사람이 승인하거나 내용을 고치면 뜻을 확인한 것으로 본다.
     * @param {string} id
     * @param {'approved'|'pending'|'rejected'} status
     * @param {{ meaning?: string, origin?: string, caution?: string, category?: string, pattern?: string }} [edits]
     */
    async setStatus(id, status, edits = {}) {
      if (!STATUSES.includes(status)) throw new TrendStoreError('bad_status', '상태는 approved, pending, rejected 가운데 하나여야 합니다.')
      if (seeds.some((seed) => seed.id === id)) throw new TrendStoreError('seed_readonly', '예시 트렌드는 바꿀 수 없습니다.')
      const trend = live.get(id)
      if (!trend || !isFresh(trend)) throw new TrendStoreError('not_found', '트렌드를 찾을 수 없습니다.')
      const changes = readEdits(edits)
      Object.assign(trend, changes, { status })
      // 노출 시각은 처음 승인한 때로 고정한다(반영 지연 시간을 재는 기준)
      if (status === 'approved') trend.publishedAt ??= toIso(now())
      if (status === 'approved' || Object.keys(changes).length > 0) trend.meaningVerified = true
      await persist()
      return structuredClone(trend)
    },

    /** 보관 기간(ttlDays)이 지난 수집 트렌드를 지우고, 지운 개수를 돌려준다. */
    purgeExpired,

    stats() {
      const collected = freshLive()
      const count = (status) => collected.filter((trend) => trend.status === status).length
      const lastCollectedAt = collected.reduce((latest, trend) => (latest !== null && latest > trend.lastSeenAt ? latest : trend.lastSeenAt), null)
      return { seed: seeds.length, live: collected.length, approved: count('approved'), pending: count('pending'), rejected: count('rejected'), lastCollectedAt }
    },

    /** 노출 중인 수집 트렌드의 반영 지연 시간(수집 → 노출, 시간 단위) */
    latencyHours() {
      return freshLive()
        .filter((trend) => trend.status === 'approved' && trend.publishedAt)
        .map((trend) => Math.max(0, Math.round(((Date.parse(trend.publishedAt) - Date.parse(trend.collectedAt)) / 3_600_000) * 100) / 100))
    },
  }
}
