// 브라우저 쪽 상태. 말투 프로필·보관함·반응 기록은 이 기기(localStorage)에만 둔다.
// 붙여 넣은 원문과 녹음 결과는 여기에 저장하지 않는다(분석이 끝나면 메모리에서도 지운다).
import { CONSENT_VERSION, LIMITS, SITUATION_IDS, SPICE_IDS, TECHNIQUE_IDS } from '../shared/constants.js'

const STORAGE_KEY = 'my-catchphrase.v1'

function newAnonId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID()
  return `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`
}

function defaults() {
  return {
    v: 1,
    anonId: newAnonId(),
    consent: null,
    profile: null,
    customTrends: [],
    selectedTrendId: null,
    options: { situation: 'chat', spice: 'medium', topic: '' },
    result: null,
    reactions: {},
    ratings: {},
    saved: [],
    feedback: { liked: [], disliked: [], techniqueStats: {}, shown: [] },
  }
}

function load() {
  const base = defaults()
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return base
    const saved = JSON.parse(raw)
    if (!saved || typeof saved !== 'object' || saved.v !== 1) return base
    const merged = { ...base, ...saved }
    // 저장된 값이 깨져 있어도 화면이 죽지 않게 형태를 맞춘다
    merged.options = { ...base.options, ...(saved.options || {}) }
    if (!SITUATION_IDS.includes(merged.options.situation)) merged.options.situation = 'chat'
    if (!SPICE_IDS.includes(merged.options.spice)) merged.options.spice = 'medium'
    merged.options.topic = String(merged.options.topic || '').slice(0, 20)
    merged.feedback = { ...base.feedback, ...(saved.feedback || {}) }
    for (const key of ['liked', 'disliked', 'shown']) if (!Array.isArray(merged.feedback[key])) merged.feedback[key] = []
    if (!merged.feedback.techniqueStats || typeof merged.feedback.techniqueStats !== 'object') merged.feedback.techniqueStats = {}
    if (!Array.isArray(merged.customTrends)) merged.customTrends = []
    if (!Array.isArray(merged.saved)) merged.saved = []
    if (!merged.reactions || typeof merged.reactions !== 'object') merged.reactions = {}
    if (!merged.ratings || typeof merged.ratings !== 'object') merged.ratings = {}
    if (typeof merged.anonId !== 'string' || !merged.anonId) merged.anonId = base.anonId
    return merged
  } catch {
    return base
  }
}

let state = load()
const listeners = new Set()
let storageOk = true

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
    storageOk = true
  } catch {
    // 사생활 보호 모드 등으로 저장이 막혀도 이번 방문 동안은 메모리 상태로 계속 쓸 수 있다
    storageOk = false
  }
}

export function getState() {
  return state
}

/** 상태를 바꾼다. patch는 객체이거나 (현재 상태) => 바꿀 부분 을 돌려주는 함수. */
export function update(patch) {
  const next = typeof patch === 'function' ? patch(state) : patch
  if (!next) return state
  state = { ...state, ...next }
  persist()
  for (const fn of listeners) fn(state)
  return state
}

export function subscribe(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

// 다른 탭에서 지우거나 바꾼 내용을 이 탭에도 반영한다. 그러지 않으면 이 탭의 옛 상태가 다음 저장 때 지운 것을 되살린다.
const syncListeners = new Set()
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY && e.key !== null) return
    state = load()
    for (const fn of listeners) fn(state)
    for (const fn of syncListeners) fn(state)
  })
}

/** 다른 탭에서 상태가 바뀌었을 때 불린다(화면을 다시 그리는 데 쓴다). */
export function onExternalChange(fn) {
  syncListeners.add(fn)
  return () => syncListeners.delete(fn)
}

export function isStorageAvailable() {
  return storageOk
}

/** 서버가 생성형 AI 엔진을 쓰는지(쓰도록 설정됐는지). 국외 이전 안내가 필요한지 가르는 데 쓴다. */
export function engineUsesLlm(engine) {
  return engine?.mode === 'llm' || engine?.configured === true
}

/**
 * 동의가 지금 문구 버전으로 되어 있는지.
 * status를 주면, AI 엔진이 켜진 서버에서는 국외 이전 안내를 보고 동의했는지도 본다.
 */
export function hasConsent(s = state, status = null) {
  const c = s.consent
  if (!(c && c.version === CONSENT_VERSION && c.age14 && c.text)) return false
  if (status && engineUsesLlm(status.engine) && c.transfer !== 'llm') return false
  return true
}

/** 예전에 동의했지만 문구가 바뀌어 다시 동의해야 하는지 */
export function consentNeedsRenewal(s = state, status = null) {
  return Boolean(s.consent && s.consent.text) && !hasConsent(s, status)
}

export function hasVoiceConsent(s = state, status = null) {
  return hasConsent(s, status) && Boolean(s.consent.voice)
}

export function candidateKey(requestId, candidateId) {
  return `${requestId}|${candidateId}`
}

/** 좋아요·별로예요를 다음 생성과 랭킹에 반영할 요약으로 바꿔 둔다. */
export function applyReaction(candidate, requestId, kind) {
  return update((s) => {
    const key = candidateKey(requestId, candidate.id)
    const prev = s.reactions[key] || null
    const nextKind = prev === kind ? null : kind
    const reactions = { ...s.reactions }
    if (nextKind) reactions[key] = nextKind
    else delete reactions[key]

    const entry = { text: candidate.text, technique: candidate.technique }
    const without = (list) => list.filter((x) => x.text !== candidate.text)
    let liked = without(s.feedback.liked)
    let disliked = without(s.feedback.disliked)
    if (nextKind === 'like') liked = [entry, ...liked].slice(0, LIMITS.feedback.liked)
    if (nextKind === 'dislike') disliked = [entry, ...disliked].slice(0, LIMITS.feedback.disliked)

    const techniqueStats = { ...s.feedback.techniqueStats }
    if (TECHNIQUE_IDS.includes(candidate.technique)) {
      const cur = { up: 0, down: 0, ...(techniqueStats[candidate.technique] || {}) }
      if (prev === 'like') cur.up = Math.max(0, cur.up - 1)
      if (prev === 'dislike') cur.down = Math.max(0, cur.down - 1)
      if (nextKind === 'like') cur.up += 1
      if (nextKind === 'dislike') cur.down += 1
      techniqueStats[candidate.technique] = cur
    }
    return { reactions, feedback: { ...s.feedback, liked, disliked, techniqueStats } }
  })
}

/** 보여 준 문구를 기억해 다음에 같은 문구가 되풀이되지 않게 한다. */
export function rememberShown(candidates) {
  return update((s) => {
    const texts = candidates.map((c) => c.text)
    const shown = [...texts, ...s.feedback.shown.filter((t) => !texts.includes(t))].slice(0, LIMITS.feedback.shown)
    return { feedback: { ...s.feedback, shown } }
  })
}

export function isSaved(requestId, candidateId, s = state) {
  const key = candidateKey(requestId, candidateId)
  return s.saved.some((x) => x.key === key)
}

export function toggleSaved(candidate, result) {
  const key = candidateKey(result.requestId, candidate.id)
  let saved = false
  update((s) => {
    if (s.saved.some((x) => x.key === key)) return { saved: s.saved.filter((x) => x.key !== key) }
    saved = true
    const item = {
      key,
      requestId: result.requestId,
      candidateId: candidate.id,
      text: candidate.text,
      examples: candidate.examples,
      technique: candidate.technique,
      why: candidate.why,
      engine: candidate.engine,
      trend: {
        keyword: result.trend.keyword,
        meaning: result.trend.meaning,
        caution: result.trend.caution,
        sourceUrl: result.trend.source?.url || null,
        sourceTitle: result.trend.source?.title || null,
        sourceType: result.trend.source?.type || 'seed',
      },
      savedAt: new Date().toISOString(),
    }
    return { saved: [item, ...s.saved].slice(0, 200) }
  })
  return saved
}

export function removeSaved(key) {
  update((s) => ({ saved: s.saved.filter((x) => x.key !== key) }))
}

/** 프로필만 지운다(보관함은 남긴다). */
export function clearProfile() {
  update({ profile: null, result: null })
}

/** 동의 철회 — 이 기기에 저장된 모든 것을 지운다. */
export function resetAll() {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // 저장소를 쓸 수 없으면 지울 것도 없다
  }
  state = defaults()
  for (const fn of listeners) fn(state)
  return state
}
