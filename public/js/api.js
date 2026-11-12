// 서버 API 호출. 오류는 사용자에게 보여 줄 수 있는 메시지를 가진 ApiError로 통일한다.
// 정적 배포(GitHub Pages)에서는 서버가 없으므로 같은 모양의 응답을 브라우저 안 백엔드(static-backend.js)가 만든다.
import { RUNTIME } from './runtime.js'
import { ApiError } from './api-error.js'

// 예전처럼 api.js에서 ApiError를 꺼내 쓸 수 있게 다시 내보낸다
export { ApiError }

async function request(path, { method = 'GET', body, headers = {}, timeoutMs = 20000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let res
  try {
    res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json', ...headers } : headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      credentials: 'same-origin',
      cache: 'no-store',
    })
  } catch (err) {
    if (err?.name === 'AbortError') throw new ApiError('응답이 너무 늦어요. 잠시 뒤 다시 시도해 주세요.', { code: 'timeout' })
    throw new ApiError('서버에 연결하지 못했어요. 서버가 켜져 있는지 확인해 주세요.', { code: 'network' })
  } finally {
    clearTimeout(timer)
  }
  let data = null
  try {
    data = await res.json()
  } catch {
    data = null
  }
  if (!res.ok) {
    throw new ApiError(data?.error?.message || '요청을 처리하지 못했어요.', { status: res.status, code: data?.error?.code || 'error' })
  }
  return data
}

const serverApi = {
  status: () => request('/api/status'),
  trends: () => request('/api/trends'),
  checkTrend: (payload) => request('/api/trends/check', { method: 'POST', body: payload }),
  // LLM 생성과 안전 심사까지 기다려야 해서 넉넉히 잡는다
  generate: (payload) => request('/api/generate', { method: 'POST', body: payload, timeoutMs: 240000 }),
  event: (payload) => request('/api/events', { method: 'POST', body: payload }),
  report: (payload) => request('/api/report', { method: 'POST', body: payload }),
}

let staticBackend = null

/** 브라우저 안 백엔드는 정적 모드에서 처음 부를 때만 불러온다. 불러오지 못하면 다음 호출 때 다시 시도한다. */
function loadStaticBackend() {
  staticBackend ??= import('./static-backend.js')
    .then((mod) => mod.createStaticBackend())
    .catch(() => {
      staticBackend = null
      throw new ApiError('데모 엔진을 불러오지 못했어요. 인터넷 연결을 확인한 뒤 새로 고침해 주세요.', { code: 'network' })
    })
  return staticBackend
}

const viaStatic = (method) => async (payload) => (await loadStaticBackend())[method](payload)

const staticApi = {
  status: viaStatic('status'),
  trends: viaStatic('trends'),
  checkTrend: viaStatic('checkTrend'),
  generate: viaStatic('generate'),
  event: viaStatic('event'),
  report: viaStatic('report'),
}

export const api = RUNTIME.mode === 'static' ? staticApi : serverApi

/** 반응 기록은 실패해도 화면 흐름을 막지 않는다. */
export function sendEvent(payload) {
  api.event(payload).catch(() => {})
}

/** 운영 화면용 — 토큰이 있으면 헤더에 싣는다. */
export function opsRequest(path, { method = 'GET', body, token = '' } = {}) {
  return request(path, { method, body, headers: token ? { 'X-Admin-Token': token } : {}, timeoutMs: 120000 })
}
