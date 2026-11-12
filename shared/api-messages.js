// API 오류를 사용자에게 보여 줄 응답(상태 코드·코드·문구)으로 바꾼다.
// 서버(server/api.js)와 정적 배포의 브라우저 안 백엔드(public/js/static-backend.js)가 함께 써서 두 쪽 문구가 어긋나지 않게 한다.
import { SAFETY_CATEGORIES } from './constants.js'

/** @typedef {{ status: number, code: string, message: string }} ApiErrorShape */

export const API_ERRORS = Object.freeze({
  trendKeywordMissing: Object.freeze({ status: 400, code: 'bad_request', message: '트렌드 키워드를 입력해 주세요.' }),
  badGenerateRequest: Object.freeze({ status: 400, code: 'bad_request', message: '요청 형식이 올바르지 않습니다.' }),
  trendNotFound: Object.freeze({ status: 404, code: 'trend_not_found', message: '고른 트렌드를 찾을 수 없어요. 목록을 새로 고친 뒤 다시 골라 주세요.' }),
  badJsonObject: Object.freeze({ status: 400, code: 'bad_json', message: 'JSON 객체가 필요합니다.' }),
})

/** 안전 필터 범주 키 → 보여 줄 이름. 걸린 낱말은 담지 않는다. */
export const categoryLabels = (categories) => (Array.isArray(categories) ? categories.map((c) => SAFETY_CATEGORIES[c] || SAFETY_CATEGORIES.other) : [])

const withLabels = (categories) => {
  const labels = categoryLabels(categories)
  return labels.length ? ` (${labels.join(', ')})` : ''
}

/** 직접 입력한 트렌드 키워드가 금칙어 필터에 걸렸을 때 */
export function blockedTrendError(categories) {
  return { status: 422, code: 'blocked_input', message: `이 키워드는 쓸 수 없어요${withLabels(categories)}. 다른 말로 바꿔 주세요.` }
}

/** 생성 요청의 입력(직접 넣은 트렌드, 넣고 싶은 말)이 금칙어 필터에 걸렸을 때 */
export function blockedInputError(categories) {
  return { status: 422, code: 'blocked_input', message: `입력한 말에 쓸 수 없는 표현이 있어요${withLabels(categories)}. 바꿔서 다시 시도해 주세요.` }
}

/**
 * 트렌드 확인(checkCustomTrend)에서 난 오류 → 응답 오류. 알 수 없는 오류면 null.
 * @returns {ApiErrorShape|null}
 */
export function trendCheckErrorResponse(err) {
  if (err instanceof TypeError) return { ...API_ERRORS.trendKeywordMissing }
  return null
}

/**
 * 생성(generate)에서 난 오류 → 응답 오류. 알 수 없는 오류면 null.
 * @returns {ApiErrorShape|null}
 */
export function generateErrorResponse(err) {
  if (err?.code === 'trend_not_found') return { ...API_ERRORS.trendNotFound }
  if (err?.code === 'blocked_input') return blockedInputError(err.categories)
  if (err instanceof TypeError) return { ...API_ERRORS.badGenerateRequest }
  return null
}
