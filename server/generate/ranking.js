// 후보에 점수를 매기고, 비슷한 것끼리 몰리지 않게 골라 순서를 정한다.
import { LIMITS, TECHNIQUE_IDS } from '../../shared/constants.js'
import { JONG, charLength, decompose, initialsOfWords, splitTail } from '../../shared/hangul.js'
import { MAX_TEXT_CHARS, cleanText, isRecord, sanitizeFeedback, sanitizeOptions, sanitizeProfilePayload, textKey } from './sanitize.js'

/** 점수 배분. 다 더하면 1이고, 싫어한 문구와 닮으면 깎인다. */
const WEIGHTS = Object.freeze({ style: 0.35, trend: 0.2, brevity: 0.15, technique: 0.2, spice: 0.05, liked: 0.05, disliked: 0.25 })
// 프로필 요소를 하나만 써도 내 말투로 읽히므로, 둘째부터는 조금씩만 더 쳐 준다
const STYLE_POINTS = [0, 0.22, 0.31, WEIGHTS.style]
const BREVITY = Object.freeze({ full: 14, zero: 32 })
// 밈의 핵심이 이만큼 겹치면 충분히 살아 있다고 본다 (어미를 바꾸면 끝 글자가 달라지므로 1로 잡지 않는다)
const TREND_FULL_COVERAGE = 0.6
const MISSING_TOPIC_FACTOR = 0.5
const ACRONYM_MAX_CHARS = 5
const MAX_COUNT = 20

/** 맛 단계에 어울리는 방식은 올리고, 어긋나는 방식은 내린다. */
const SPICE_FIT = Object.freeze({
  mild: { ending: 1, filler: 1, twist: -1, blend: -1 },
  medium: {},
  hot: { twist: 1, blend: 1 },
})

/** 고르는 기준: 같은 방식은 두 개까지, 이미 고른 것과 이보다 더 닮으면 건너뛴다. 자리가 남아도 풀지 않는다. */
const SELECTION = Object.freeze({ perTechnique: 2, maxSimilarity: 0.7 })

const clamp01 = (n) => Math.min(1, Math.max(0, n))
const compact = (value) => String(value ?? '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

// ── 닮은 정도 ─────────────────────────────────────────────

/** 글자 두 개씩 묶은 조각들. 한 글자짜리는 그 글자 하나. */
function grams(value) {
  const chars = Array.from(textKey(value))
  if (chars.length < 2) return new Set(chars)
  return new Set(chars.slice(0, -1).map((ch, i) => ch + chars[i + 1]))
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0
  let shared = 0
  for (const gram of a) if (b.has(gram)) shared++
  return shared / (a.size + b.size - shared)
}

const closest = (own, others) => others.reduce((max, other) => Math.max(max, jaccard(own, other)), 0)

/** 두 글에 함께 나오는 가장 긴 연속 구간의 길이 */
function longestSharedRun(a, b) {
  let best = 0
  let prev = new Array(b.length + 1).fill(0)
  for (const ch of a) {
    const row = [0]
    for (let j = 0; j < b.length; j++) {
      row.push(ch === b[j] ? prev[j] + 1 : 0)
      best = Math.max(best, row[j + 1])
    }
    prev = row
  }
  return best
}

// ── 말투 반영 ─────────────────────────────────────────────

const jongAt = (core, fromEnd) => {
  const d = decompose(Array.from(core).at(-1 - fromEnd) ?? '')
  return d ? JONG[d.jong] : null
}
const endsWithAny = (...suffixes) => (core) => suffixes.some((suffix) => core.endsWith(suffix))
const afterNieun = (suffix) => (core) => core.endsWith(suffix) && jongAt(core, Array.from(suffix).length) === 'ㄴ'
const pairs = (endings, test) => endings.map((ending) => [ending, test])

/** 글자 그대로 끝나지 않아도 같은 어미로 치는 경우 (좋은데·인데 ← 는데, 좋아 ← 어) */
const ENDING_VARIANTS = new Map([
  ...pairs(['는데', '은데', 'ㄴ데'], afterNieun('데')),
  ...pairs(['는데요', '은데요', 'ㄴ데요'], afterNieun('데요')),
  ...pairs(['습니다', 'ㅂ니다'], endsWithAny('니다')),
  ...pairs(['어', '아'], endsWithAny('어', '아')),
  ...pairs(['엉', '앙'], endsWithAny('엉', '앙')),
  ...pairs(['어요', '아요', '해요'], endsWithAny('요')),
  // 음슴체의 ㅁ 받침: 함 · 됨, ㄹ 줄기에서는 ㄻ(삶 · 앎)
  ['ㅁ', (core) => ['ㅁ', 'ㄻ'].includes(jongAt(core, 0))],
])

const hasEnding = (core, ending) => core.endsWith(ending) || Boolean(ENDING_VARIANTS.get(ending)?.(core))

const LAUGHS = [
  ['kk', /ㅋ{2,}/u],
  ['hh', /ㅎ{2,}/u],
  ['cry', /[ㅠㅜ]{2,}/u],
]
// 늘여 쓰기: 받침 없는 홀소리 글자가 겹치거나(좋아아아) 물결이 겹칠 때
const STRETCHED = /([아애야얘어에여예오와왜외요우워웨위유으의이])\1|~~/u
// 끊어 쓰기: 문구 안에서 마침표로 한 번 끊고 이어 갈 때
const BEAT = /[가-힣]\. \S/u

// 글 어디에든 그대로 나오면 드러난 것으로 치는 말끝 습관
const marksOf = (tail) => [...tail.punct, ...tail.emoji, ...tail.emoticons, ...tail.choseong]

/** 프로필 요소가 글에 드러났는지 보는 검사들. 저마다 드러난 요소의 수를 돌려준다. */
const STYLE_CHECKS = [
  ({ core, profile }) => Number(profile.endings.some((ending) => hasEnding(core, ending))),
  ({ words, profile }) => profile.fillers.filter((filler) => words.includes(` ${filler} `)).length,
  ({ text, profile }) => LAUGHS.filter(([habit, shape]) => profile.tail[habit] && shape.test(text)).length,
  ({ text, profile }) => marksOf(profile.tail).filter((mark) => text.includes(mark)).length,
  ({ text, profile }) => Number(profile.tail.elongation && STRETCHED.test(text)),
  ({ text, profile }) => Number((profile.rhythm.short || profile.rhythm.phrasing === 'choppy') && BEAT.test(text)),
]

function styleScore({ text }, { profile }) {
  const core = splitTail(text).core
  const words = ` ${core.replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `
  const hits = STYLE_CHECKS.reduce((sum, check) => sum + check({ text, core, words, profile }), 0)
  return STYLE_POINTS[Math.min(hits, STYLE_POINTS.length - 1)]
}

// ── 밈 반영 ───────────────────────────────────────────────

// 키워드의 ‘~’, ‘OO’와 문형의 {X}는 빈칸이므로 그 앞뒤 글자만 밈의 고정된 부분이다
const BLANK = /\{[^{}]*\}|~|(?<![A-Za-z])OO(?![A-Za-z])|○○/g
const ANCHOR_MAX_CHARS = 120

/** 밈에서 글자 그대로 남아야 하는 부분들. 줄임말 후보를 위해 어절 첫 글자 모음도 함께 둔다. */
function anchorsOf(trend) {
  const sources = [trend?.keyword, trend?.pattern].map((source) => cleanText(source, ANCHOR_MAX_CHARS)).filter(Boolean)
  return sources.map((source) => ({
    parts: source.split(BLANK).map(compact).filter(Boolean),
    initials: compact(initialsOfWords(source.replace(BLANK, ' ').trim())),
  }))
}

/** 고정된 부분이 글에 얼마나 살아 있는지 0..1. 한 글자만 겹친 것은 우연으로 본다. */
function coverage(parts, key) {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const kept = parts.reduce((sum, part) => {
    const run = longestSharedRun(Array.from(part), key)
    return sum + (run >= Math.min(2, part.length) ? run : 0)
  }, 0)
  return total ? kept / total : 0
}

function trendScore({ text }, { anchors, topic }) {
  const flat = compact(splitTail(text).core)
  const key = Array.from(flat)
  const fits = anchors.flatMap(({ parts, initials }) => [
    coverage(parts, key),
    // 줄임말(‘떡못참’)은 어절 첫 글자가 이어져 있으면 밈이 살아 있는 것으로 본다
    key.length <= ACRONYM_MAX_CHARS && initials.length >= 2 ? coverage([initials], key) : 0,
  ])
  // 넣고 싶은 말을 받았는데 빠져 있으면 밈을 살렸어도 절반만 쳐 준다
  const asked = !topic || flat.includes(topic) ? 1 : MISSING_TOPIC_FACTOR
  return WEIGHTS.trend * asked * clamp01(Math.max(0, ...fits) / TREND_FULL_COVERAGE)
}

// ── 나머지 점수 ───────────────────────────────────────────

const brevityScore = ({ text }) => WEIGHTS.brevity * clamp01((BREVITY.zero - charLength(text)) / (BREVITY.zero - BREVITY.full))

function techniqueScore({ technique }, { feedback }) {
  const { up = 0, down = 0 } = feedback.techniqueStats[technique] ?? {}
  return (WEIGHTS.technique * (up + 1)) / (up + down + 2)
}

const spiceScore = ({ technique }, { options }) => WEIGHTS.spice * (SPICE_FIT[options.spice][technique] ?? 0)

const feedbackScore = ({ grams: own }, { liked, disliked }) => WEIGHTS.liked * closest(own, liked) - WEIGHTS.disliked * closest(own, disliked)

const SCORE_PARTS = [styleScore, trendScore, brevityScore, techniqueScore, spiceScore, feedbackScore]

// ── 고르기 ────────────────────────────────────────────────

const strings = (value, max) => (Array.isArray(value) ? value.filter((v) => typeof v === 'string').slice(0, max) : [])

/** 바깥에서 온 후보를 채점할 수 있는 모양으로 읽는다. 문구가 없거나 너무 길면 null. */
function readCandidate(raw, fallbackEngine) {
  const text = isRecord(raw) ? cleanText(raw.text, MAX_TEXT_CHARS + 1) : ''
  if (!text || charLength(text) > MAX_TEXT_CHARS) return null
  return {
    text,
    examples: strings(raw.examples, LIMITS.candidates.examplesPerCandidate),
    technique: TECHNIQUE_IDS.includes(raw.technique) ? raw.technique : 'twist',
    styleElements: strings(raw.styleElements, 8),
    memeElement: typeof raw.memeElement === 'string' ? raw.memeElement : '',
    why: typeof raw.why === 'string' ? raw.why : '',
    engine: raw.engine === 'llm' || raw.engine === 'local' ? raw.engine : fallbackEngine,
    key: textKey(text),
    grams: grams(text),
  }
}

function allows(item, picked) {
  if (picked.filter((other) => other.technique === item.technique).length >= SELECTION.perTechnique) return false
  return picked.every((other) => jaccard(item.grams, other.grams) <= SELECTION.maxSimilarity)
}

/** 점수 순으로 훑으며 다양성 조건을 지키는 것만 고른다. */
function selectDiverse(sorted, count) {
  const picked = []
  for (const item of sorted) {
    if (picked.length >= count) break
    if (allows(item, picked)) picked.push(item)
  }
  return picked
}

// 두 엔진의 후보가 섞여 들어오는 것은, 살아남은 AI 엔진 후보가 모자라 규칙 엔진 후보로 채울 때뿐이다.
// 그때는 AI 엔진 후보를 먼저 싣고 남는 자리만 채운다.
const fromLlm = (item) => Number(item.engine === 'llm')

/** 같은 문구(정규화 기준)는 앞선 것만 남긴다. */
function uniqueByKey(items) {
  const seen = new Set()
  return items.filter((item) => !seen.has(item.key) && seen.add(item.key))
}

/**
 * @param {object[]} rawCandidates
 * @param {{ profile?: object, trend?: object, options?: object, feedback?: object, count?: number, requestId?: string,
 *           engine?: 'llm'|'local', rng?: () => number }} [context]  rng는 점수가 같을 때의 순서를 정하는 데만 쓴다
 * @returns {import('../../shared/types.js').Candidate[]}
 */
export function rankCandidates(rawCandidates, context) {
  const { profile, trend, options, feedback, count = LIMITS.candidates.count, requestId = 'r', engine = 'local', rng } = context ?? {}
  const fb = sanitizeFeedback(feedback)
  const shown = new Set(fb.shown.map(textKey))
  const cleanOptions = sanitizeOptions(options)
  const scoring = {
    profile: sanitizeProfilePayload(profile),
    options: cleanOptions,
    feedback: fb,
    anchors: anchorsOf(trend),
    topic: compact(cleanOptions.topic),
    liked: fb.liked.map((entry) => grams(entry.text)),
    disliked: fb.disliked.map((entry) => grams(entry.text)),
  }
  const scored = (Array.isArray(rawCandidates) ? rawCandidates : [])
    .map((raw) => readCandidate(raw, engine === 'llm' ? 'llm' : 'local'))
    .filter((item) => item && !shown.has(item.key))
    .map((item, order) => ({
      ...item,
      order,
      tie: typeof rng === 'function' ? Number(rng()) || 0 : 0,
      score: clamp01(SCORE_PARTS.reduce((sum, part) => sum + part(item, scoring), 0)),
    }))
    .sort((a, b) => fromLlm(b) - fromLlm(a) || b.score - a.score || b.tie - a.tie || a.order - b.order)
  const limit = Number.isInteger(count) && count > 0 ? Math.min(count, MAX_COUNT) : LIMITS.candidates.count
  return selectDiverse(uniqueByKey(scored), limit).map((item, index) => ({
    id: `${requestId}-${index + 1}`,
    text: item.text,
    examples: item.examples,
    technique: item.technique,
    styleElements: item.styleElements,
    memeElement: item.memeElement,
    why: item.why,
    score: Math.round(item.score * 1000) / 1000,
    engine: item.engine,
  }))
}
