// 개인정보로 보이는 문자열을 가린다 — 브라우저(대표 문장 고르기)와 서버(안전 필터)가 함께 쓴다.
// 완벽한 탐지가 목적이 아니라, 연락처·계정처럼 뚜렷한 패턴이 프로필이나 결과에 섞이지 않게 하는 안전망이다.

export const PII_MASK = '○○○'

const PATTERNS = [
  // 링크
  /\bhttps?:\/\/[^\s<>"']+/gi,
  /\bwww\.[^\s<>"']+/gi,
  // 이메일
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g,
  // 주민등록번호 꼴 (6자리-7자리)
  /(?<!\d)\d{6}\s?-\s?[1-8]\d{6}(?!\d)/g,
  // 휴대전화·유선전화 (+82 포함)
  /(?<!\d)(?:\+?82[-.\s]?)?0?1[016789][-.\s]?\d{3,4}[-.\s]?\d{4}(?!\d)/g,
  /(?<!\d)0(?:2|[3-6][1-5]|70|50\d)[-.\s]?\d{3,4}[-.\s]?\d{4}(?!\d)/g,
  // 카드·계좌처럼 긴 숫자열 (구분자 포함 9자리 이상)
  /(?<!\d)\d(?:[-\s]?\d){8,}(?!\d)/g,
  // @계정, 카카오톡 @멘션(한글 표시 이름도 친구의 실명일 수 있다)
  /(?<![A-Za-z0-9._%+-])@[A-Za-z0-9_.가-힣]{2,30}/g,
]

/**
 * @param {string} text
 * @returns {{ text: string, masked: number }}
 */
export function maskPII(text) {
  let out = String(text ?? '')
  let masked = 0
  for (const re of PATTERNS) {
    re.lastIndex = 0
    out = out.replace(re, () => {
      masked++
      return PII_MASK
    })
  }
  return { text: out, masked }
}

/** @param {string} text */
export function containsPII(text) {
  const s = String(text ?? '')
  for (const re of PATTERNS) {
    re.lastIndex = 0
    if (re.test(s)) return true
  }
  return false
}
