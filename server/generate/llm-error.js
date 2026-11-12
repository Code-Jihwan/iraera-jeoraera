// LLM 호출 오류. 생성 엔진(engine.js)이 SDK를 부르는 llm.js 없이도 오류 종류를 가려낼 수 있도록 따로 둔다.

const ERROR_MESSAGES = Object.freeze({
  disabled: 'AI 엔진이 꺼져 있습니다.',
  unavailable: 'AI 엔진을 불러오지 못했습니다.',
  auth: 'AI 엔진 인증에 실패했습니다.',
  daily_cap: '오늘의 AI 엔진 호출 한도에 도달했습니다.',
  rate_limit: 'AI 엔진 요청 한도에 걸렸습니다.',
  bad_request: 'AI 엔진이 요청을 받아들이지 않았습니다.',
  network: 'AI 엔진에 연결하지 못했습니다.',
  api: 'AI 엔진 호출에 실패했습니다.',
  refusal: 'AI 엔진이 요청을 거절했습니다.',
  max_tokens: 'AI 엔진 응답이 길이 한도에서 끊겼습니다.',
  bad_json: 'AI 엔진 응답이 JSON 형식이 아닙니다.',
})

export class LlmError extends Error {
  /** @param {string} kind 오류 종류 (auth, rate_limit, refusal, bad_json …) */
  constructor(kind) {
    super(Object.hasOwn(ERROR_MESSAGES, kind) ? ERROR_MESSAGES[kind] : ERROR_MESSAGES.api)
    this.name = 'LlmError'
    this.kind = kind
  }
}
