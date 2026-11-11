// 안전 필터 — 트렌드 단계의 1차 금칙어 필터와 생성 단계의 안전 필터가 함께 쓴다. 서버 전용.
//
// 결과에는 범주만 담는다. 걸린 낱말은 돌려주지도, 기록하지도, 오류 메시지에 싣지도 않는다.
// 낱말 목록으로는 새말·비꼼·돌려 말하기를 다 잡을 수 없다. 이 필터는 안전망이고, 생성 결과는 AI 심사와 신고 처리가 한 번 더 본다.

import { CHO, JUNG, JONG, compose, decompose, isCompatJamo, isHangulSyllable } from '../../shared/hangul.js'
import { containsPII } from '../../shared/pii.js'
import { SAFETY_CATEGORIES } from '../../shared/constants.js'
import { ENTRIES, ALLOWLIST, JAMO_PATTERNS, AFFIX_PATTERNS } from './lexicon.js'

/** 이보다 긴 글은 끝까지 보지 못하므로 통과시키지 않는다(뒤에 숨긴 말을 놓치지 않도록). */
const MAX_TEXT_CHARS = 4000
const MAX_STYLE_TERMS = 200
const MAX_EXAMPLES = 10

// ── 정규화 ──────────────────────────────────────────────

// 보이지 않는 글자·결합 부호: ‘시(폭 없는 공백)발’처럼 끼워 넣어 필터를 피하는 데 쓰인다
const INVISIBLE_RE = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufeff\uffa0\u0300-\u036f]/g
// NFKC는 호환 자모(ㅅ)를 조합용 자모(ᄉ)로 바꿔 버리므로 호환 자모 토막은 그대로 두고 나머지만 정규화한다
const COMPAT_JAMO_SPLIT_RE = /([\u3131-\u318e]+)/
const CONJOINING_JAMO_RE = /[\u1100-\u1112\u1161-\u1175\u11a8-\u11c2]/g
const SPACE_RE = /\s/
// 맞춤에 쓰는 글자: 한글 음절, 현대 호환 자모, 영문 소문자, 숫자
const KEEP_RE = /[가-힣ㄱ-ㅣa-z0-9]/
const FILLER_RE = /[a-z0-9]/
const MAX_FILLER_RUN = 3
const JONG_NONE = 0
const CHO_IEUNG = CHO.indexOf('ㅇ')

/** 남은 조합용 자모(NFD로 들어온 글 등)를 호환 자모로 되돌린다. */
function toCompatJamo(ch) {
  const c = ch.codePointAt(0)
  if (c <= 0x1112) return CHO[c - 0x1100]
  if (c <= 0x1175) return JUNG[c - 0x1161]
  return JONG[c - 0x11a7]
}

/** 소문자 NFKC, 보이지 않는 글자 제거. 원문 대신 이 꼴에서 영문·숫자 낱말을 찾는다. */
function toRaw(text) {
  return text
    .split(COMPAT_JAMO_SPLIT_RE)
    .map((part, i) => (i % 2 ? part : part.normalize('NFKC')))
    .join('')
    .replace(CONJOINING_JAMO_RE, toCompatJamo)
    .replace(INVISIBLE_RE, '')
    .toLowerCase()
}

const isVowelJamo = (ch) => JUNG.includes(ch)

/**
 * 맞춤용 글자 단위. start = 띄어쓰기 뒤 첫 글자, soft = 문장부호·기호·이모지 바로 뒤(낱말 첫머리로 본다),
 * lead = 낱말 앞머리의 숫자·영문을 걷어 낸 뒤 첫 글자(낱말을 나누는 자리지만 낱말 첫머리는 아니다: ‘9시발’의 ‘시’).
 * @typedef {{ ch: string, start: boolean, soft: boolean, lead?: boolean }} Unit
 */

/** @returns {Unit[]} */
function toUnits(raw) {
  const units = []
  let start = true
  let soft = false
  for (const ch of raw) {
    if (SPACE_RE.test(ch)) {
      start = true
    } else if (!KEEP_RE.test(ch)) {
      soft = true
    } else {
      units.push({ ch, start, soft: soft && !start })
      start = false
      soft = false
    }
  }
  return units
}

/** i에서 시작하는, 한글 사이에 낀 짧은 영문·숫자 토막의 끝. 그런 토막이 아니면 i. */
function fillerEnd(units, i) {
  const prev = units[i - 1]
  if (!prev || !FILLER_RE.test(units[i].ch) || FILLER_RE.test(prev.ch)) return i
  let end = i
  while (end < units.length && FILLER_RE.test(units[end].ch)) end++
  return end - i <= MAX_FILLER_RUN && end < units.length ? end : i
}

/**
 * 한글 사이에 끼운 짧은 영문·숫자(‘씨1발’, ‘시 1 발’, ‘개x새끼’)를 걷어 낸다. 걷어 낸 토막이 낱말 앞머리였으면
 * (‘9시발’, ‘3시 발’) 다음 글자에서 낱말을 나누되 첫머리로는 보지 않는다 — 원래 낱말은 숫자로 시작했으니
 * ‘9시’의 ‘시’에서 짧은 말을 맞추면 출발 시각(9시발 부산행)을 욕설로 읽게 된다.
 */
function dropFillers(units) {
  const out = []
  let carryLead = false
  for (let i = 0; i < units.length; i++) {
    const end = fillerEnd(units, i)
    if (end > i) {
      carryLead = units[i].start
      i = end - 1
      continue
    }
    out.push(carryLead && !units[i].start ? { ...units[i], start: true, soft: false, lead: true } : units[i])
    carryLead = false
  }
  return out
}

/** 풀어 쓴 자모를 음절로 모은다 (ㅅㅣ발 → 시발, ㅂㅕㅇ신 → 병신). 자음만 이어진 줄임말(ㅅㅂ)은 그대로 둔다. */
function composeJamo(units) {
  const out = []
  for (let i = 0; i < units.length; i++) {
    const cho = CHO.indexOf(units[i].ch)
    const vowel = units[i + 1]
    if (cho < 0 || !vowel || !isVowelJamo(vowel.ch)) {
      out.push(units[i])
      continue
    }
    const tail = units[i + 2]
    const jong = tail ? JONG.indexOf(tail.ch) : -1
    const takesJong = jong > JONG_NONE && !(units[i + 3] && isVowelJamo(units[i + 3].ch))
    out.push({ ...units[i], ch: compose(cho, JUNG.indexOf(vowel.ch), takesJong ? jong : JONG_NONE) })
    i += takesJong ? 2 : 1
  }
  return out
}

/**
 * 늘여 쓴 소리를 앞 음절에 합친 꼴. 늘인 소리가 아니면 null.
 * 음절 뒤 모음 자모(좋아ㅏㅏ → 좋아), 받침 없는 음절 뒤 같은 모음의 ‘ㅇ’ 음절(시이발 → 시발, 받침은 앞으로: 병시인 → 병신)
 */
function absorbStretch(prev, ch) {
  if (!isHangulSyllable(prev)) return null
  if (isVowelJamo(ch)) return prev
  const a = decompose(prev)
  const b = decompose(ch)
  if (!b || a.jong !== JONG_NONE || b.cho !== CHO_IEUNG || b.jung !== a.jung) return null
  return compose(a.cho, a.jung, b.jong)
}

/** 같은 글자 되풀이와 늘여 쓴 소리를 한 낱말 안에서 줄인다 (씨이이발 → 씨발, 존나아아 → 존나). */
function squeezeUnits(units) {
  const out = []
  let carrySoft = false
  for (const unit of units) {
    const prev = out[out.length - 1]
    const merged = prev && !unit.start ? (unit.ch === prev.ch ? prev.ch : absorbStretch(prev.ch, unit.ch)) : null
    if (merged !== null) {
      if (merged !== prev.ch) out[out.length - 1] = { ...prev, ch: merged }
      carrySoft = carrySoft || unit.soft
      continue
    }
    out.push(carrySoft ? { ...unit, soft: true } : unit)
    carrySoft = false
  }
  return out
}

/**
 * 맞춤용 보기: 이어 붙인 글과 낱말 경계 정보. starts = 낱말을 나누는 자리, leads = 그 가운데 첫머리가 아닌 자리.
 * @typedef {{ text: string, tokenStart: number[], starts: Set<number>, ends: Set<number>, soft: Set<number>, leads: Set<number> }} View
 */

/** @param {Unit[]} units @returns {View} */
function toView(units) {
  const tokenStart = []
  const starts = new Set()
  const ends = new Set()
  const soft = new Set()
  const leads = new Set()
  let text = ''
  let current = 0
  units.forEach((unit, i) => {
    if (unit.start || i === 0) {
      if (i > 0) ends.add(i - 1)
      current = i
      starts.add(i)
    }
    if (unit.soft) soft.add(i)
    if (unit.lead) leads.add(i)
    tokenStart.push(current)
    text += unit.ch
  })
  if (units.length) ends.add(units.length - 1)
  return { text, tokenStart, starts, ends, soft, leads }
}

/** 사전 항목을 글과 같은 방식으로 줄인다. 띄어 쓴 구는 낱말마다 따로 줄여 붙인다. */
function squeezeWord(word) {
  return squeezeUnits(toUnits(word)).map((unit) => unit.ch).join('')
}

/** 띄어 쓴 자리의 위치(붙여 쓴 꼴 기준) */
function spaceOffsets(word, squeeze) {
  const offsets = []
  let length = 0
  for (const part of word.split(' ')) {
    if (length > 0) offsets.push(length)
    length += (squeeze ? squeezeWord(part) : part).length
  }
  return offsets
}

/** 띄어쓰기로 나눈 낱말들 */
function wordsOf(units) {
  const words = []
  units.forEach((unit, i) => {
    if (unit.start || i === 0) words.push('')
    words[words.length - 1] += unit.ch
  })
  return words
}

/**
 * 글을 맞춤용 꼴들로 바꾼다. jamoWords는 자모를 음절로 모으기 전의 낱말(ㅅㅂ 같은 줄임말 맞춤용),
 * words는 모은 뒤의 낱말(…충 같은 형태소 맞춤용)이다.
 */
function analyze(text) {
  const raw = toRaw(text)
  const units = dropFillers(toUnits(raw))
  const composed = composeJamo(units)
  return {
    raw,
    jamoWords: wordsOf(units),
    words: wordsOf(composed),
    compact: toView(composed),
    squeezed: toView(squeezeUnits(composed)),
  }
}

// ── 사전 준비(모듈을 읽을 때 한 번) ───────────────────────

const CATEGORY_KEYS = Object.keys(SAFETY_CATEGORIES)
const SEVERITIES = new Set(['block', 'caution'])
const HANGUL_KEY_RE = /^[가-힣ㄱ-ㅣ]+$/
const LATIN_RE = /[a-z0-9]/
const LATIN_WORD_RE = /^[a-z0-9]+$/
// 띄어 쓴 변형(‘시 발’)까지 잡는 범주. 다른 범주의 두 글자 말은 ‘자 살 빼자’ 같은 평범한 문장과 겹쳐서
// spaced를 적은 항목만 잡고, 세 글자 이상은 모든 범주에서 잡는다(‘세 월 호’) — 낱말 경계에서 시작·끝나야 하니 우연히 겹치기 어렵다.
const CROSS_SPACE_CATEGORIES = new Set(['profanity'])
const CROSS_SPACE_MIN_SYLLABLES = 3

function assertValid(item, index) {
  if (!CATEGORY_KEYS.includes(item.category) || !SEVERITIES.has(item.severity)) {
    throw new Error(`안전 필터 사전 ${index}번 항목의 범주나 세기가 잘못됐습니다.`)
  }
}

const syllables = (key) => Array.from(key).filter(isHangulSyllable).length

/**
 * 허용 낱말을 맞춤용으로 편다. offsets = 이 낱말 안에서 막는 말이 시작하는 자리들.
 * @returns {{ word: string, spaces: number[], offsets: number[] }|null}
 */
function compileAllow(allow, key, squeeze) {
  const word = squeeze ? squeezeWord(allow) : allow.replace(/ /g, '')
  const offsets = []
  for (let at = word.indexOf(key); at >= 0; at = word.indexOf(key, at + 1)) offsets.push(at)
  return offsets.length ? { word, spaces: spaceOffsets(allow, squeeze), offsets } : null
}

function compileAllows(allows, key, squeeze) {
  return allows.map((allow) => compileAllow(allow, key, squeeze)).filter(Boolean)
}

function compileHangul(item, index) {
  const phrase = item.term.includes(' ')
  const key = item.term.replace(/ /g, '')
  if (!HANGUL_KEY_RE.test(key)) throw new Error(`안전 필터 사전 ${index}번 항목에 맞출 수 없는 글자가 있습니다.`)
  const squeezedKey = squeezeWord(item.term)
  const allows = [...(item.allow ?? []), ...ALLOWLIST]
  return {
    category: item.category,
    severity: item.severity,
    key,
    squeezedKey,
    phrase,
    noun: item.noun === true,
    boundary: item.boundary ?? (phrase || syllables(key) <= 2),
    crossSpace:
      !phrase &&
      (item.spaced === true || CROSS_SPACE_CATEGORIES.has(item.category) || syllables(key) >= CROSS_SPACE_MIN_SYLLABLES),
    allows: { compact: compileAllows(allows, key, false), squeezed: compileAllows(allows, squeezedKey, true) },
  }
}

/** 같은 글자가 이어지는 토막들(fuck → f·u·c·k, ssibal → ss·i·b·a·l). 글에서는 토막마다 그 수 이상 되풀이되어도 맞는다. */
function toRuns(term) {
  const runs = []
  for (const ch of term) {
    const last = runs[runs.length - 1]
    if (last && last.ch === ch) last.min++
    else runs.push({ ch, min: 1 })
  }
  return runs
}

/** 첫 글자 → 항목들. 글의 각 자리에서 그 글자로 시작하는 항목만 확인하면 된다. */
function indexByFirstChar(entries) {
  const index = new Map()
  for (const entry of entries) {
    const list = index.get(entry.key[0]) ?? []
    list.push(entry)
    index.set(entry.key[0], list)
  }
  return index
}

function compileLexicon() {
  const mixed = []
  const latinWords = []
  const hangul = []
  ENTRIES.forEach((item, index) => {
    assertValid(item, index)
    const base = { category: item.category, severity: item.severity }
    if (LATIN_WORD_RE.test(item.term)) latinWords.push({ ...base, key: item.term, runs: toRuns(item.term) })
    else if (LATIN_RE.test(item.term)) mixed.push({ ...base, term: item.term })
    else hangul.push(compileHangul(item, index))
  })
  JAMO_PATTERNS.forEach((item, index) => assertValid(item, ENTRIES.length + index))
  AFFIX_PATTERNS.forEach((item, index) => assertValid(item, ENTRIES.length + JAMO_PATTERNS.length + index))
  return {
    mixed,
    latinWords: indexByFirstChar(latinWords),
    nouns: hangul.filter((entry) => entry.noun),
    index: indexByFirstChar(hangul.filter((entry) => !entry.noun)),
  }
}

const LEXICON = compileLexicon()

function countByCategory() {
  const counts = Object.fromEntries(CATEGORY_KEYS.map((key) => [key, 0]))
  for (const item of [...ENTRIES, ...JAMO_PATTERNS, ...AFFIX_PATTERNS]) counts[item.category]++
  return Object.freeze(counts)
}

/** 사전 규모(관리 화면·점검용). 낱말 자체는 담지 않는다. */
export const LEXICON_STATS = Object.freeze({
  terms: ENTRIES.length + JAMO_PATTERNS.length + AFFIX_PATTERNS.length,
  byCategory: countByCategory(),
})

// ── 맞춤 ────────────────────────────────────────────────

/** 띄어 쓴 낱말의 첫 글자인지(앞머리의 숫자·영문을 걷어 낸 자리는 아니다) */
const atTokenStart = (view, i) => view.starts.has(i) && !view.leads.has(i)

/** 낱말 첫머리인지: 띄어쓰기 뒤, 문장부호·기호 뒤, 자모(ㅋㅋ) 바로 뒤 */
function atWordStart(view, i) {
  return atTokenStart(view, i) || view.soft.has(i) || isCompatJamo(view.text[i - 1])
}

/** at에서 시작하는 허용 낱말 안의 낱말 경계가 모두 띄어 쓴 자리로 적힌 곳에 있는지 */
function boundariesFit(view, at, { word, spaces }) {
  for (let k = at + 1; k < at + word.length; k++) {
    if (view.starts.has(k) && !spaces.includes(k - at)) return false
  }
  return true
}

/** 허용 낱말이 [i, end) 자리를 덮는지 */
function allowedAt(allows, view, i, end) {
  return allows.some((allow) =>
    allow.offsets.some((offset) => {
      const at = i - offset
      return at >= 0 && at + allow.word.length >= end && view.text.startsWith(allow.word, at) && boundariesFit(view, at, allow)
    }),
  )
}

// ‘지진 아 무서워’처럼 두 글자 이상 낱말 뒤에 따로 쓴 감탄사는 낱말 + 감탄사로 읽는다(지진아로 잇지 않는다)
const LONE_INTERJECTIONS = new Set(['아', '야', '어'])

function wordThenInterjection(view, i, end) {
  const last = end - 1
  return view.tokenStart[last] === last && LONE_INTERJECTIONS.has(view.text[last]) && view.tokenStart[last - 1] === i && last - i >= 2
}

/** 여러 낱말에 걸친 맞춤을 받아들일지: 구로 적은 항목, 또는 낱말 경계에서 시작해 낱말 경계에서 끝나는 crossSpace 항목 */
function spanAccepted(entry, view, i, end) {
  if (view.tokenStart[end - 1] === view.tokenStart[i]) return true
  // 숫자로 시작한 낱말(‘이 3시발 열차’의 3시발)로 넘어가는 맞춤은 받지 않는다
  for (let k = i + 1; k < end; k++) if (view.leads.has(k)) return false
  if (entry.phrase) return true
  if (!entry.crossSpace || !atTokenStart(view, i) || !view.ends.has(end - 1)) return false
  return CROSS_SPACE_CATEGORIES.has(entry.category) || !wordThenInterjection(view, i, end)
}

function scanView(view, mode, hits) {
  const { text } = view
  for (let i = 0; i < text.length; i++) {
    const candidates = LEXICON.index.get(text[i])
    if (!candidates) continue
    for (const entry of candidates) {
      const key = mode === 'squeezed' ? entry.squeezedKey : entry.key
      if (!text.startsWith(key, i)) continue
      const end = i + key.length
      if (!spanAccepted(entry, view, i, end)) continue
      if (entry.boundary && !atWordStart(view, i)) continue
      if (allowedAt(entry.allows[mode], view, i, end)) continue
      hits.push(entry)
    }
  }
}

// ── 명사로 쓰일 때만 막는 말(보지, 자지) ──────────────────
// 같은 꼴이 ‘보다·자다’의 활용형(보지 마, 안 자지?)으로 훨씬 흔히 쓰여서, 낱말 첫머리에서 시작하고
// 앞뒤가 동사 쪽으로 읽히지 않을 때만 맞춘다.

// 바로 붙어도 명사로 읽히는 꼬리
const NOUN_TAILS_STRONG = new Set(['년', '놈', '털', '물', '구멍', '빨', '냄새', '족', '충'])
// 명사로도 활용형으로도 읽히는 꼬리 — 앞뒤 낱말로 가린다
const NOUN_TAILS_WEAK = new Set(['', '가', '를', '랑', '이랑'])
// 뒤 낱말이 이것으로 시작하면 활용형(보지 마, 자지 않고, 보지 뭐, 자지 그래). 붙여 쓴 ‘보지도·보지는·보지만·보지요’는
// 위 꼬리 목록에 없어서 맞추지 않는다. ‘안’은 넣지 않는다(‘않’과 달리 ‘안에’ 같은 명사 뒤에도 온다).
const VERB_FOLLOWERS = ['마', '말', '못', '않', '뭐', '그래', '그랬', '싫']
// 앞 낱말이 이것이면 동사를 꾸미는 말(안 보지?, 일찍 자지)
const VERB_ADVERBS = new Set([
  '안', '못', '잘', '좀', '또', '더', '다', '꼭', '왜', '푹', '같이', '함께', '그냥', '직접', '많이', '계속', '아직', '먼저',
  '다시', '한번', '어서', '얼른', '일찍', '늦게', '빨리', '일단', '이제', '미리', '혼자', '마저', '자주', '매일',
])
const EDGE_JAMO_RE = /^[ㄱ-ㅣ]+|[ㄱ-ㅣ]+$/g

/** 띄어쓰기로 나눈 낱말을 문장부호 없이 줄인 꼴과, 물음표(‘-지?’ 활용형의 표지)가 붙었는지 */
function nounTokens(raw) {
  return raw
    .split(/\s+/)
    .map((token) => ({ core: squeezeWord(token).replace(EDGE_JAMO_RE, ''), question: token.includes('?') }))
    .filter((token) => token.core)
}

function nounHit(entry, tokens, t) {
  const { core, question } = tokens[t]
  if (!core.startsWith(entry.squeezedKey)) return false
  const tail = core.slice(entry.squeezedKey.length)
  if (NOUN_TAILS_STRONG.has(tail)) return true
  if (!NOUN_TAILS_WEAK.has(tail) || question) return false
  const prev = tokens[t - 1]?.core
  const next = tokens[t + 1]?.core
  if (prev && VERB_ADVERBS.has(prev)) return false
  return !(next && VERB_FOLLOWERS.some((head) => next.startsWith(head)))
}

function scanNouns(raw, hits) {
  if (!LEXICON.nouns.length) return
  const tokens = nounTokens(raw)
  for (const entry of LEXICON.nouns) {
    if (tokens.some((_, t) => nounHit(entry, tokens, t))) hits.push(entry)
  }
}

// ── 영문 ────────────────────────────────────────────────

const LATIN_LETTER_RE = /[a-z]/
const LATIN_SEPARATOR_RE = /[\s\p{P}\p{S}]/u

/**
 * 띄어쓰기·문장부호로만 떨어진 영문·숫자를 한 줄로 이은 토막들(S E X, s.e.x → sex). 한글 같은 다른 글자에서는 끊는다.
 * starts·ends = 원래 낱말이 시작·끝나는 자리.
 */
function latinSegments(raw) {
  const segments = []
  let current = null
  let gap = true
  for (const ch of raw) {
    if (LATIN_RE.test(ch)) {
      if (!current) {
        current = { text: '', starts: new Set(), ends: new Set() }
        segments.push(current)
      } else if (gap) {
        current.ends.add(current.text.length - 1)
      }
      if (gap) current.starts.add(current.text.length)
      current.text += ch
      gap = false
    } else {
      gap = true
      if (!LATIN_SEPARATOR_RE.test(ch) && current) {
        current.ends.add(current.text.length - 1)
        current = null
      }
    }
  }
  if (current) current.ends.add(current.text.length - 1)
  return segments
}

/** at에서 토막(runs)을 차례로, 글자마다 정해진 수 이상 되풀이되며 따라가 끝난 자리. 맞지 않으면 -1. */
function runsEnd(text, at, runs) {
  let pos = at
  for (const { ch, min } of runs) {
    const from = pos
    while (text[pos] === ch) pos++
    if (pos - from < min) return -1
  }
  return pos
}

/**
 * [at, end)가 여러 낱말에 걸치면 한 글자씩 떼어 쓴 꼴(f u c k)일 때만 받는다.
 * 여러 글자 낱말끼리 이으면 평범한 글(U.S. Ex-Im → sex)이 걸린다.
 */
function latinSpanOk(starts, at, end) {
  let crossing = false
  let spelled = true
  for (let k = at + 1; k < end; k++) {
    if (starts.has(k)) crossing = true
    else spelled = false
  }
  return !crossing || spelled
}

/**
 * 영문 낱말 항목: 낱말 첫머리에서 시작해 낱말 끝에서 끝날 때만 맞춘다(unisex, sussex는 통과).
 * 한 글자씩 띄우거나 점을 찍거나(f u c k, s.e.x) 글자를 늘여도(fuuuck) 잡는다.
 */
function scanLatinWords(raw, hits) {
  if (!LATIN_LETTER_RE.test(raw)) return
  const found = new Set()
  for (const { text, starts, ends } of latinSegments(raw)) {
    for (const at of starts) {
      for (const entry of LEXICON.latinWords.get(text[at]) ?? []) {
        if (found.has(entry)) continue
        const end = runsEnd(text, at, entry.runs)
        if (end > at && ends.has(end - 1) && latinSpanOk(starts, at, end)) found.add(entry)
      }
    }
  }
  hits.push(...found)
}

/** 항목의 끝 글자가 영문·숫자라면 이웃 글자는 영문·숫자가 아니어야 한다. */
const clearEdge = (edge, neighbor) => !LATIN_RE.test(edge) || neighbor === undefined || !LATIN_RE.test(neighbor)

/** 영문·숫자와 한글·기호가 섞인 항목은 원문 꼴에서, 앞뒤가 영문·숫자가 아닐 때만 찾는다 (2018놈은 통과). */
function scanMixed(raw, hits) {
  for (const entry of LEXICON.mixed) {
    const { term } = entry
    for (let at = raw.indexOf(term); at >= 0; at = raw.indexOf(term, at + 1)) {
      if (clearEdge(term[0], raw[at - 1]) && clearEdge(term[term.length - 1], raw[at + term.length])) {
        hits.push(entry)
        break
      }
    }
  }
}

// ── 자모 줄임말 ─────────────────────────────────────────

const LAUGH_EDGE_RE = /^[ㅋㅎㅠㅜ]+|[ㅋㅎㅠㅜ]+$/g

const JAMO_RUN_RE = /[ㄱ-ㅣ]+/g

/** 낱말마다 자모만 이어진 토막을 모은다. 한 글자씩 띄어 쓴 자모(ㅅ ㅂ)는 하나로 잇는다. */
function jamoRuns(words) {
  const runs = []
  let spaced = ''
  const flushSpaced = () => {
    if (spaced.length > 1) runs.push(spaced)
    spaced = ''
  }
  for (const word of words) {
    runs.push(...(word.match(JAMO_RUN_RE) ?? []))
    if (word.length === 1 && isCompatJamo(word)) spaced += word
    else flushSpaced()
  }
  flushSpaced()
  return runs
}

const isRepeatOf = (text, unit) => text.length % unit.length === 0 && unit.repeat(text.length / unit.length) === text

function scanJamo(words, hits) {
  for (const run of jamoRuns(words)) {
    const trimmed = run.replace(LAUGH_EDGE_RE, '')
    if (!trimmed) continue
    const forms = [trimmed, squeezeWord(trimmed)]
    for (const pattern of JAMO_PATTERNS) {
      if (forms.some((form) => isRepeatOf(form, pattern.term))) hits.push(pattern)
    }
  }
}

// ── 비하 형태소(…충, 씹…) ───────────────────────────────

// ‘급식충들’, ‘맘충이’처럼 형태소 뒤에 붙는 조사·꼬리. ‘충전’, ‘충격’, ‘충분’의 뒷글자는 여기에 없다.
const SUFFIX_TAILS = new Set([
  '', '이', '은', '는', '을', '를', '아', '야', '도', '만', '임', '이야', '이냐', '이네', '이다', '이지', '같은', '같다', '새끼',
  '들', '들이', '들은', '들을', '들아', '들도', '들만', '한테', '에게', '이랑',
])

function suffixHit(pattern, token) {
  const at = token.lastIndexOf(pattern.morpheme)
  if (at < 1 || !SUFFIX_TAILS.has(token.slice(at + pattern.morpheme.length))) return false
  const stem = token.slice(0, at)
  if (stem.length > pattern.maxStem || !Array.from(stem).every(isHangulSyllable)) return false
  const word = stem + pattern.morpheme
  return !pattern.allow.some((allow) => word.endsWith(allow))
}

function prefixHit(pattern, token) {
  return token.startsWith(pattern.morpheme) && !pattern.allow.some((allow) => token.startsWith(allow))
}

function scanAffixes(words, hits) {
  for (const pattern of AFFIX_PATTERNS) {
    const test = pattern.kind === 'suffix' ? suffixHit : prefixHit
    if (words.some((word) => test(pattern, word))) hits.push(pattern)
  }
}

/** @returns {{category: string, severity: string}[]} */
function collectHits(text) {
  const { raw, jamoWords, words, compact, squeezed } = analyze(text)
  const hits = []
  scanView(compact, 'compact', hits)
  scanView(squeezed, 'squeezed', hits)
  scanNouns(raw, hits)
  scanLatinWords(raw, hits)
  scanMixed(raw, hits)
  scanJamo(jamoWords, hits)
  scanAffixes(words, hits)
  if (containsPII(raw)) hits.push({ category: 'privacy', severity: 'block' })
  return hits
}

// ── 판정 ────────────────────────────────────────────────

const CONTEXTS = new Set(['trend', 'output', 'input'])
// 트렌드 단계에서는 사건·사고, 자해, 정치 쟁점을 가리키는 말이 보이기만 해도 유행어 소재에서 뺀다
const STRICT_IN_TREND = new Set(['tragedy', 'self_harm', 'other'])
const LEVEL_RANK = { ok: 0, caution: 1, block: 2 }

function levelOf(hit, context) {
  if (hit.severity === 'block') return 'block'
  return context === 'trend' && STRICT_IN_TREND.has(hit.category) ? 'block' : 'caution'
}

/** 판정 하나를 만든다. categories에는 판정 단계(막음/주의)에 해당하는 범주만, 정해진 순서로 담는다. */
function verdict(level, categories = []) {
  const unique = CATEGORY_KEYS.filter((key) => categories.includes(key))
  return { ok: level !== 'block', level, categories: unique }
}

function verdictOfHits(hits, context) {
  let level = 'ok'
  let categories = []
  for (const hit of hits) {
    const hitLevel = levelOf(hit, context)
    if (LEVEL_RANK[hitLevel] > LEVEL_RANK[level]) {
      level = hitLevel
      categories = []
    }
    if (hitLevel === level) categories.push(hit.category)
  }
  return verdict(level, categories)
}

/** 여러 판정을 하나로: 가장 높은 단계와 그 단계의 범주들 */
function mergeVerdicts(verdicts) {
  let level = 'ok'
  for (const item of verdicts) if (LEVEL_RANK[item.level] > LEVEL_RANK[level]) level = item.level
  return verdict(level, verdicts.filter((item) => item.level === level).flatMap((item) => item.categories))
}

/** 검사할 수 있는 꼴로 바꾼다. 없음 → '', 문자열·숫자·참거짓 → 문자열, 그 밖의 값 → null(알 수 없으니 막는다) */
function toCheckable(value) {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  return null
}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

// ── 공개 함수 ───────────────────────────────────────────

/**
 * 맞춤에 쓰는 세 가지 꼴. raw = 소문자 NFKC, compact = 띄어쓰기·문장부호·한글 사이 영문/숫자를 걷어 낸 꼴,
 * squeezed = compact에서 같은 글자 되풀이와 늘여 쓴 소리를 줄인 꼴.
 * @param {string} text
 * @returns {{ raw: string, compact: string, squeezed: string }}
 */
export function normalizeForMatch(text) {
  const input = toCheckable(text) ?? ''
  const { raw, compact, squeezed } = analyze(input.slice(0, MAX_TEXT_CHARS))
  return { raw, compact: compact.text, squeezed: squeezed.text }
}

/**
 * @param {string} text
 * @param {{ context?: 'trend'|'output'|'input' }} [options]
 * @returns {import('../../shared/types.js').SafetyVerdict}
 */
export function checkText(text, options = {}) {
  const context = CONTEXTS.has(options?.context) ? options.context : 'output'
  const input = toCheckable(text)
  if (input === null) return verdict('block', ['other'])
  if (input.length > MAX_TEXT_CHARS) return verdict('block', ['other'])
  if (!input.trim()) return verdict('ok')
  return verdictOfHits(collectHits(input), context)
}

/** 트렌드 초안: 키워드, 문형, 뜻, (있으면) 제목을 트렌드 단계 기준으로 본다. */
export function checkTrend(draft) {
  if (!isRecord(draft)) return verdict('block', ['other'])
  const source = isRecord(draft.source) ? draft.source : {}
  const fields = [draft.keyword, draft.pattern, draft.meaning, draft.title, source.title]
  return mergeVerdicts(fields.map((field) => checkText(field, { context: 'trend' })))
}

/** 생성 후보: 문구, 모든 예문, 한 줄 설명을 결과물 기준으로 본다. */
export function checkCandidate(candidate) {
  if (!isRecord(candidate)) return verdict('block', ['other'])
  const { examples } = candidate
  if (Array.isArray(examples) && examples.length > MAX_EXAMPLES) return verdict('block', ['other'])
  const fields = [candidate.text, ...(Array.isArray(examples) ? examples : [examples]), candidate.why]
  return mergeVerdicts(fields.map((field) => checkText(field, { context: 'output' })))
}

/** 말투 요소 목록에서 막히는 것을 뺀다. 순서는 그대로, 문자열이 아닌 값도 뺀다. */
export function filterStyleTerms(terms) {
  if (!Array.isArray(terms)) return []
  return terms
    .slice(0, MAX_STYLE_TERMS)
    .filter((term) => typeof term === 'string' && checkText(term, { context: 'input' }).ok)
}
