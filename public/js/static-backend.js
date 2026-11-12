// 정적 배포(GitHub Pages)용 브라우저 안 백엔드. 서버 API(/api/*)와 같은 모양의 응답을 이 브라우저 안에서 만든다.
// 규칙 기반 기본 엔진만 쓰고(API 키를 브라우저에 두지 않는다), 아무것도 밖으로 보내지 않는다.
// DOM을 쓰지 않아 Node 테스트에서도 빌드 결과물을 그대로 불러 쓸 수 있다.
// '../engine/…' 경로는 빌드 결과물(dist)에만 있다 — 서버 모드에서는 이 파일을 불러오지 않는다.
import { createGenerator, GenerateError } from '../engine/generate/engine.js'
import * as safety from '../engine/safety/filter.js'
import { CONSENT_VERSION, DEFAULT_SERVICE_NAME } from '../shared/constants.js'
import { blockedTrendError, generateErrorResponse, trendCheckErrorResponse, API_ERRORS } from '../shared/api-messages.js'
import { ApiError } from './api-error.js'

const ENGINE_STATUS = Object.freeze({ mode: 'local', label: '기본 엔진(규칙 기반)', model: null, reason: null, configured: false })
const LOAD_FAILED = '데모 데이터를 불러오지 못했어요. 새로 고침한 뒤 다시 시도해 주세요.'
const INTERNAL = '문제가 생겼어요. 새로 고침한 뒤 다시 시도해 주세요.'
const silentLog = Object.freeze({ info() {}, warn() {}, error() {}, log() {} })

const toApiError = ({ status, code, message }) => new ApiError(message, { status, code })
/** HTTP를 오간 것처럼 JSON으로 한 번 바꿨다 되살린다(함수·undefined·순환 참조가 남지 않게). */
const roundTrip = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))
/** 브라우저에는 규칙 엔진 힌트를 빼고 보낸다(서버의 publicTrend와 같다). */
function publicTrend(trend) {
  if (!trend) return null
  const { engine, ...rest } = trend
  return rest
}

/** 서버가 요청 본문을 읽는 방식을 따른다: 본문이 없으면 빈 객체, 객체가 아니면 400. */
function readBody(payload) {
  const body = payload ? roundTrip(payload) : {}
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw toApiError(API_ERRORS.badJsonObject)
  return body
}

/**
 * @param {{ fetchImpl?: typeof fetch, trendsUrl?: URL|string }} [opts]
 */
export function createStaticBackend({ fetchImpl = globalThis.fetch, trendsUrl = new URL('../data/trends.json', import.meta.url) } = {}) {
  let loading = null

  /** 빌드 때 만든 트렌드 묶음을 한 번만 받는다. 실패하면 다음 호출 때 다시 받는다. */
  function load() {
    loading ??= (async () => {
      let data
      try {
        const res = await fetchImpl(String(trendsUrl), { cache: 'no-cache', credentials: 'same-origin' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        data = await res.json()
      } catch {
        throw new ApiError(LOAD_FAILED, { code: 'network' })
      }
      const items = Array.isArray(data?.items) ? data.items.filter((item) => item && typeof item.id === 'string') : []
      const byId = new Map(items.map((item) => [item.id, item]))
      const frames = Array.isArray(data?.frames) ? data.frames : []
      const trendStore = {
        get(id) {
          const item = byId.get(id)
          return item && item.status === 'approved' ? structuredClone(item) : null
        },
        frames: () => structuredClone(frames),
      }
      const generator = createGenerator({
        config: { llm: { safetyJudge: false, model: null, safetyModel: null } },
        llm: null,
        safety,
        trendStore,
        log: silentLog,
      })
      return { items, stats: data?.stats && typeof data.stats === 'object' ? data.stats : {}, generator }
    })().catch((err) => {
      loading = null
      throw err
    })
    return loading
  }

  function trendStatus(stats) {
    return {
      ...structuredClone(stats),
      youtubeEnabled: false,
      instagramEnabled: false,
      reviewMode: 'manual',
      refreshMinutes: null,
      ttlDays: null,
      lastRunAt: null,
      lastRunOk: null,
      nextRunAt: null,
    }
  }

  /** 엔진 호출에서 난 오류를 서버와 같은 ApiError로 바꾼다. */
  async function run(task, mapError) {
    try {
      return roundTrip(await task())
    } catch (err) {
      if (err instanceof ApiError) throw err
      const known = mapError(err)
      throw known ? toApiError(known) : new ApiError(INTERNAL, { status: 500, code: 'internal' })
    }
  }

  return {
    /** GET /api/status와 같은 모양 */
    async status() {
      const { stats } = await load()
      return {
        serviceName: DEFAULT_SERVICE_NAME,
        consentVersion: CONSENT_VERSION,
        // 서버가 없어 보관하는 기록이 없다
        retention: null,
        hosting: 'static',
        engine: { ...ENGINE_STATUS },
        trends: trendStatus(stats),
      }
    },

    /** GET /api/trends와 같은 모양(같은 순서) */
    async trends() {
      const { items, stats } = await load()
      return { items: items.map((item) => publicTrend(structuredClone(item))), status: trendStatus(stats) }
    },

    /** POST /api/trends/check */
    async checkTrend(payload) {
      const { generator } = await load()
      const body = readBody(payload)
      return run(async () => {
        const result = await generator.checkCustomTrend(body)
        if (!result.ok) throw toApiError(blockedTrendError(result.categories))
        return { trend: publicTrend(result.trend) }
      }, trendCheckErrorResponse)
    },

    /** POST /api/generate */
    async generate(payload) {
      const { generator } = await load()
      const body = readBody(payload)
      return run(
        () =>
          generator.generate({
            profile: body.profile,
            trendId: body.trendId,
            customTrend: body.customTrend,
            options: body.options,
            feedback: body.feedback,
          }),
        // 서버와 같이 엔진이 알려 준 오류(트렌드 없음·금칙어)와 형식 오류만 사용자 문구로 바꾼다
        (err) => (err instanceof GenerateError || err instanceof TypeError ? generateErrorResponse(err) : null),
      )
    },

    /** POST /api/events — 정적 데모는 반응 기록을 어디에도 보내지 않는다 */
    async event() {
      return { ok: true }
    },

    /** POST /api/report — 운영 서버가 없어 신고는 누구에게도 전달되지 않는다(delivered: false) */
    async report() {
      return { ok: true, delivered: false }
    },
  }
}
