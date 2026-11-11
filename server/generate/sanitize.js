// 브라우저에서 온 값은 하나도 믿지 않는다 — 모양·길이·종류를 여기에서 한 번에 바로잡는다.
import { LIMITS, REGISTERS, SITUATION_IDS, SPICE_IDS, TECHNIQUE_IDS } from '../../shared/constants.js'
import { splitTail } from '../../shared/hangul.js'

/** 후보 문구가 넘지 못하는 길이(코드 포인트). 화면 권장 길이(LIMITS.candidates.maxChars)보다 넉넉한 안전선이다. */
export const MAX_TEXT_CHARS = 48

const TOPIC_MAX_CHARS = 20
const LIST_CAPS = Object.freeze({ endings: 6, fillers: 6, expressions: 8, tail: 3 })
const JAMO_RUN_MAX = 6
const STAT_MAX = 9999
// 잘못된 항목이 섞여 있어도 끝없이 훑지 않도록 상한의 몇 배까지만 본다
const SCAN_FACTOR = 4

const REGISTER_IDS = Object.keys(REGISTERS)
const TEMPOS = ['slow', 'normal', 'fast', 'unknown']
const PHRASINGS = ['choppy', 'even', 'flowing', 'unknown']

// 제어 문자, 짝 잃은 서러게이트, 보이지 않는 방향·폭 문자 (이모지를 잇는 U+200D는 남긴다)
const INVISIBLE = /[\p{Cc}\p{Cs}\u200B\u200C\u200E\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/gu
// 빈칸에 넣을 말의 앞뒤에 붙은 기호·웃음 자모 — 조사가 엉뚱한 글자에 붙지 않게 뗀다
const SLOT_EDGES = /^[\s#@~!?.,;:…·]+|[\s~!?.,;:…·ㅋㅎㅠㅜ]+$/gu

// 말끝 습관은 후보 끝에 그대로 붙으므로, 정해진 모양이 아니면 버린다
const TAIL_SHAPES = Object.freeze({
  kk: /^ㅋ{2,}$/u,
  hh: /^ㅎ{2,}$/u,
  cry: /^[ㅠㅜ]{2,}$/u,
  emoji: /^(?=\S*\p{Extended_Pictographic})\S{1,8}$/u,
  emoticon: /^[^\s가-힣]{2,8}$/u,
  punct: /^[!?~….]{1,3}$/u,
  choseong: /^[ㄱ-ㅎ]{2,6}$/u,
})

/** 배열이 아닌 객체인지 */
export const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const record = (value) => (isRecord(value) ? value : {})
const oneOf = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback)
const chars = (text, max) => Array.from(text).slice(0, max).join('')

/**
 * 한 줄짜리 글로 다듬는다: 줄바꿈은 공백으로, 보이지 않는 문자는 지우고, 길이를 자른다.
 * 문자열이 아니면 빈 문자열.
 * @param {unknown} value
 * @param {number} maxChars 코드 포인트 기준
 */
export function cleanText(value, maxChars) {
  if (typeof value !== 'string') return ''
  const flat = value
    .slice(0, maxChars * 8)
    .normalize('NFC')
    .replace(/\s/gu, ' ')
    .replace(INVISIBLE, '')
    .replace(/ {2,}/g, ' ')
    .trim()
  return chars(flat, maxChars).trim()
}

/**
 * 문형 빈칸에 넣을 말(넣고 싶은 말, 직접 입력한 트렌드)을 다듬는다.
 * 틀 문법과 겹치는 중괄호, 해시태그 표시, 끝에 붙은 문장부호·웃음을 뗀다.
 */
export function cleanSlotWord(value, maxChars) {
  if (typeof value !== 'string') return ''
  return cleanText(value.replace(/[{}]/g, ' '), maxChars).replace(SLOT_EDGES, '')
}

/** 같은 문구인지 견줄 때 쓰는 열쇠: 소문자로, 공백과 말끝 꾸밈(ㅋㅋ·!!·이모지)을 뗀다. */
export function textKey(text) {
  const flat = String(text ?? '')
    .normalize('NFC')
    .toLowerCase()
  const squeezed = (s) => s.replace(/\s+/g, '')
  return squeezed(splitTail(flat).core) || squeezed(flat)
}

function cleanList(value, cap, clean) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const raw of value.slice(0, cap * SCAN_FACTOR)) {
    const item = clean(raw)
    if (item && !out.includes(item)) out.push(item)
    if (out.length === cap) break
  }
  return out
}

const item = (value) => cleanText(value, LIMITS.profile.itemMaxChars)
// 사용자가 '~거든', '-거든'처럼 적어 넣은 어미도 같은 것으로 본다
const ending = (value) => item(value).replace(/^[~\-–—\s]+/u, '')
const shaped = (shape) => (value) => {
  const text = item(value)
  return shape.test(text) ? text : ''
}
const jamoRun = (value, shape) => chars(shaped(shape)(value), JAMO_RUN_MAX) || null
const clamped = (value, min, max, fallback) => (typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback)

/**
 * @param {unknown} raw
 * @returns {import('../../shared/types.js').ProfilePayload}
 */
export function sanitizeProfilePayload(raw) {
  const p = record(raw)
  const tail = record(p.tail)
  const rhythm = record(p.rhythm)
  return {
    register: oneOf(p.register, REGISTER_IDS, 'banmal'),
    cute: clamped(p.cute, 0, 1, 0),
    endings: cleanList(p.endings, LIST_CAPS.endings, ending),
    fillers: cleanList(p.fillers, LIST_CAPS.fillers, item),
    expressions: cleanList(p.expressions, LIST_CAPS.expressions, item),
    tail: {
      kk: jamoRun(tail.kk, TAIL_SHAPES.kk),
      hh: jamoRun(tail.hh, TAIL_SHAPES.hh),
      cry: jamoRun(tail.cry, TAIL_SHAPES.cry),
      emoji: cleanList(tail.emoji, LIST_CAPS.tail, shaped(TAIL_SHAPES.emoji)),
      emoticons: cleanList(tail.emoticons, LIST_CAPS.tail, shaped(TAIL_SHAPES.emoticon)),
      punct: cleanList(tail.punct, LIST_CAPS.tail, shaped(TAIL_SHAPES.punct)),
      choseong: cleanList(tail.choseong, LIST_CAPS.tail, shaped(TAIL_SHAPES.choseong)),
      elongation: tail.elongation === true,
    },
    rhythm: {
      avgChars: clamped(rhythm.avgChars, 0, 1000, null),
      short: rhythm.short === true,
      tempo: oneOf(rhythm.tempo, TEMPOS, 'unknown'),
      phrasing: oneOf(rhythm.phrasing, PHRASINGS, 'unknown'),
    },
    samples: cleanList(p.samples, LIMITS.profile.samples, (value) => cleanText(value, LIMITS.profile.sampleMaxChars)),
    hasVoice: p.hasVoice === true,
    hasText: p.hasText === true,
  }
}

/**
 * @param {unknown} raw
 * @returns {{ situation: string, spice: string, topic: string }}
 */
export function sanitizeOptions(raw) {
  const o = record(raw)
  return {
    situation: oneOf(o.situation, SITUATION_IDS, 'chat'),
    spice: oneOf(o.spice, SPICE_IDS, 'medium'),
    topic: cleanSlotWord(o.topic, TOPIC_MAX_CHARS),
  }
}

// 좋아요·별로예요 한 건. 문구만 문자열로 보낸 경우도 받아 준다.
function reaction(value) {
  const text = cleanText(isRecord(value) ? value.text : value, MAX_TEXT_CHARS)
  return text ? { text, technique: oneOf(value?.technique, TECHNIQUE_IDS, '') } : null
}

function reactions(value, cap) {
  const seen = new Set()
  const list = Array.isArray(value) ? value.slice(0, cap * SCAN_FACTOR).map(reaction) : []
  return list.filter((r) => r && !seen.has(r.text) && seen.add(r.text)).slice(0, cap)
}

const tally = (value) => (Number.isInteger(value) && value >= 0 ? Math.min(value, STAT_MAX) : null)

function techniqueStats(value) {
  const stats = {}
  for (const id of TECHNIQUE_IDS) {
    if (!isRecord(value) || !Object.hasOwn(value, id)) continue
    const up = tally(value[id]?.up)
    const down = tally(value[id]?.down)
    if (up !== null && down !== null) stats[id] = { up, down }
  }
  return stats
}

/**
 * 목록은 최근 것이 앞에 오므로(브라우저가 그렇게 쌓는다) 넘치면 앞에서부터 남긴다.
 * @param {unknown} raw
 * @returns {import('../../shared/types.js').FeedbackSummary}
 */
export function sanitizeFeedback(raw) {
  const f = record(raw)
  return {
    liked: reactions(f.liked, LIMITS.feedback.liked),
    disliked: reactions(f.disliked, LIMITS.feedback.disliked),
    techniqueStats: techniqueStats(f.techniqueStats),
    shown: cleanList(f.shown, LIMITS.feedback.shown, (value) => cleanText(value, MAX_TEXT_CHARS)),
  }
}

/**
 * @param {unknown} raw
 * @returns {{ keyword: string, meaning: string }}
 * @throws {TypeError} 키워드가 비어 있을 때
 */
export function sanitizeCustomTrend(raw) {
  const t = record(raw)
  const keyword = cleanSlotWord(t.keyword, LIMITS.customTrend.keywordMaxChars)
  if (!keyword) throw new TypeError('트렌드 키워드를 입력해 주세요.')
  return { keyword, meaning: cleanText(t.meaning, LIMITS.customTrend.meaningMaxChars) }
}
