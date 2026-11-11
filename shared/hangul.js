// 한글 유틸리티 — 브라우저와 서버가 함께 쓰는 모듈 (의존성 없음)
//
// 음절 코드 = 0xAC00 + (초성 * 21 + 중성) * 28 + 종성

const S_BASE = 0xac00
const S_END = 0xd7a3

export const CHO = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ']
export const JUNG = ['ㅏ', 'ㅐ', 'ㅑ', 'ㅒ', 'ㅓ', 'ㅔ', 'ㅕ', 'ㅖ', 'ㅗ', 'ㅘ', 'ㅙ', 'ㅚ', 'ㅛ', 'ㅜ', 'ㅝ', 'ㅞ', 'ㅟ', 'ㅠ', 'ㅡ', 'ㅢ', 'ㅣ']
export const JONG = ['', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ']

const JONG_RIEUL = 8

/** @param {string} ch 한 글자 */
export function isHangulSyllable(ch) {
  if (!ch) return false
  const c = ch.codePointAt(0)
  return c >= S_BASE && c <= S_END
}

/** 호환용 자모(ㄱ-ㅎ, ㅏ-ㅣ)인지 */
export function isCompatJamo(ch) {
  if (!ch) return false
  const c = ch.codePointAt(0)
  return c >= 0x3131 && c <= 0x318e
}

/** 호환용 자모 중 자음(ㄱ-ㅎ)인지 */
export function isCompatConsonant(ch) {
  if (!ch) return false
  const c = ch.codePointAt(0)
  return c >= 0x3131 && c <= 0x314e
}

/**
 * 음절을 초·중·종성 인덱스로 분해한다. 한글 음절이 아니면 null.
 * @param {string} ch
 * @returns {{cho:number, jung:number, jong:number}|null}
 */
export function decompose(ch) {
  if (!isHangulSyllable(ch)) return null
  const n = ch.codePointAt(0) - S_BASE
  return { cho: Math.floor(n / 588), jung: Math.floor((n % 588) / 28), jong: n % 28 }
}

/** 초·중·종성 인덱스로 음절을 만든다. */
export function compose(cho, jung, jong = 0) {
  return String.fromCodePoint(S_BASE + (cho * 21 + jung) * 28 + jong)
}

// 숫자를 한국어로 읽었을 때의 받침: 영 일 이 삼 사 오 육 칠 팔 구
const DIGIT_BATCHIM = [true, true, false, true, false, false, true, true, true, false]
const DIGIT_RIEUL = [false, true, false, false, false, false, false, true, true, false]

/**
 * 낱말 끝소리 정보. 뒤에 붙은 문장부호·공백·이모지는 건너뛴다.
 * 영문은 글자 이름 기준(L·M·N·R만 받침)으로 본다.
 * @param {string} word
 * @returns {{has:boolean, rieul:boolean, known:boolean}}
 */
export function batchimInfo(word) {
  const chars = Array.from(String(word ?? ''))
  for (let i = chars.length - 1; i >= 0; i--) {
    const ch = chars[i]
    const d = decompose(ch)
    if (d) return { has: d.jong !== 0, rieul: d.jong === JONG_RIEUL, known: true }
    if (isCompatConsonant(ch)) return { has: true, rieul: ch === 'ㄹ', known: true }
    if (isCompatJamo(ch)) return { has: false, rieul: false, known: true }
    if (/[0-9]/.test(ch)) {
      const n = Number(ch)
      return { has: DIGIT_BATCHIM[n], rieul: DIGIT_RIEUL[n], known: true }
    }
    if (/[A-Za-z]/.test(ch)) {
      const lower = ch.toLowerCase()
      const prev = (chars[i - 1] || '').toLowerCase()
      if (lower === 'g' && prev === 'n') return { has: true, rieul: false, known: true }
      const has = 'lmnr'.includes(lower)
      return { has, rieul: lower === 'l' || lower === 'r', known: true }
    }
    // 그 밖의 글자(문장부호, 공백, 이모지)는 건너뛴다
  }
  return { has: false, rieul: false, known: false }
}

/**
 * 받침에 맞는 조사를 고른다.
 * @param {string} word 앞말
 * @param {string} pair '받침 있을 때/없을 때' 꼴. 예: '은/는', '이/가', '을/를', '과/와', '으로/로', '이야/야', '이/'
 * @returns {string} 고른 조사
 */
export function josa(word, pair) {
  const [withBatchim, without = ''] = String(pair).split('/')
  const info = batchimInfo(word)
  if (!info.has) return without
  // '으로/로'는 ㄹ 받침 뒤에서 '로'
  if (withBatchim === '으로' && info.rieul) return without
  return withBatchim
}

/** 앞말에 조사를 붙여 돌려준다. */
export function attach(word, pair) {
  return String(word) + josa(word, pair)
}

/**
 * 마지막 한글 음절에 받침이 없으면 받침을 더한다 (가요 → 가용, 좋다 → 좋당).
 * 더할 수 없으면 원래 문자열을 그대로 돌려준다.
 * @param {string} text
 * @param {string} jongChar 'ㅇ' | 'ㅁ' | 'ㄴ' …
 */
export function addBatchim(text, jongChar = 'ㅇ') {
  const jongIndex = JONG.indexOf(jongChar)
  if (jongIndex <= 0) return String(text)
  const chars = Array.from(String(text ?? ''))
  for (let i = chars.length - 1; i >= 0; i--) {
    const d = decompose(chars[i])
    if (!d) {
      if (isCompatJamo(chars[i]) || /[0-9A-Za-z]/.test(chars[i])) return chars.join('')
      continue
    }
    if (d.jong !== 0) return chars.join('')
    chars[i] = compose(d.cho, d.jung, jongIndex)
    return chars.join('')
  }
  return chars.join('')
}

/** 마지막 한글 음절에 받침을 더할 수 있는지 */
export function canAddBatchim(text) {
  const chars = Array.from(String(text ?? ''))
  for (let i = chars.length - 1; i >= 0; i--) {
    const d = decompose(chars[i])
    if (d) return d.jong === 0
    if (isCompatJamo(chars[i]) || /[0-9A-Za-z]/.test(chars[i])) return false
  }
  return false
}

/** 한글 음절 수(숫자는 한 자리당 한 음절로 어림) — 말 빠르기 계산용 */
export function countSyllables(text) {
  let n = 0
  for (const ch of String(text ?? '')) {
    if (isHangulSyllable(ch) || /[0-9]/.test(ch)) n++
  }
  return n
}

/** 한글 음절을 초성으로 바꾼다 (안녕 → ㅇㄴ). 다른 글자는 그대로 둔다. */
export function toChoseong(text) {
  let out = ''
  for (const ch of String(text ?? '')) {
    const d = decompose(ch)
    out += d ? CHO[d.cho] : ch
  }
  return out
}

/** 각 어절의 첫 글자를 모은다 (줄임말 후보). */
export function initialsOfWords(text) {
  return String(text ?? '')
    .split(/\s+/)
    .map((w) => Array.from(w.replace(/^[^0-9A-Za-z가-힣]+/, ''))[0] || '')
    .join('')
}

// 말끝에 붙는 웃음·울음 자모, 문장부호, 이모지, 공백
const TAIL_RE = /(?:[\s~!?.,;:…·^*_\-]|[ㅋㅎㅠㅜㄷㅇㅈㄹㅊㄱㄴㅅㅂㅁ]|\p{Extended_Pictographic}|️|‍)+$/u

/**
 * 문장을 본문과 말끝 꾸밈(ㅋㅋ, ㅠㅠ, ~, !!, 이모지)으로 나눈다.
 * @param {string} text
 * @returns {{core:string, tail:string}}
 */
export function splitTail(text) {
  const s = String(text ?? '')
  const m = s.match(TAIL_RE)
  if (!m) return { core: s, tail: '' }
  const core = s.slice(0, m.index)
  // 본문이 통째로 꾸밈으로만 이루어진 경우(예: "ㅋㅋㅋ")는 본문 없음으로 본다
  return { core: core.trimEnd(), tail: m[0].trim() }
}

/** 글자 수(코드 포인트 기준) */
export function charLength(text) {
  return Array.from(String(text ?? '')).length
}
