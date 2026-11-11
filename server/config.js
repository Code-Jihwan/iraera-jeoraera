// 환경변수 → 설정. 비밀값은 여기에서만 읽고, 상태 응답에는 절대 담지 않는다.
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_SERVICE_NAME, RETENTION_DEFAULT_DAYS } from '../shared/constants.js'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const int = (v, d, { min = -Infinity, max = Infinity } = {}) => {
  const n = Number.parseInt(String(v ?? '').trim(), 10)
  if (!Number.isFinite(n)) return d
  return Math.min(max, Math.max(min, n))
}
const num = (v, d) => {
  const n = Number.parseFloat(String(v ?? '').trim())
  return Number.isFinite(n) ? n : d
}
const str = (v, d = '') => {
  const s = String(v ?? '').trim()
  return s || d
}
const oneOf = (v, allowed, d) => {
  const s = String(v ?? '').trim().toLowerCase()
  return allowed.includes(s) ? s : d
}
const list = (v, d) => {
  const s = String(v ?? '').trim()
  if (!s) return d
  return s.split(',').map((x) => x.trim()).filter(Boolean)
}

/** `fallbacks: "default"`를 지원하는 모델 (서버 측 거절 대체) */
const FALLBACK_CAPABLE = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-2', 'claude-fable-5-1', 'claude-sonnet-5-5'])

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ loadDotEnv?: boolean }} [opts]
 */
export function loadConfig(env = process.env, { loadDotEnv = true } = {}) {
  if (loadDotEnv) {
    const envPath = path.join(ROOT, '.env')
    if (existsSync(envPath) && typeof process.loadEnvFile === 'function') {
      try {
        process.loadEnvFile(envPath)
      } catch (err) {
        console.warn(`[config] .env 파일을 읽지 못했습니다: ${err.message}`)
      }
    }
  }

  const host = str(env.HOST, '127.0.0.1')
  const port = int(env.PORT, 3000, { min: 0, max: 65535 })

  const publicHosts = list(env.PUBLIC_HOSTS, [])
  const allowAnyHost = publicHosts.includes('*')
  const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1', ...publicHosts.map((h) => h.toLowerCase())])

  const llmMode = oneOf(env.LLM_MODE, ['auto', 'on', 'off'], 'auto')
  const hasAnthropicCredential = Boolean(str(env.ANTHROPIC_API_KEY) || str(env.ANTHROPIC_AUTH_TOKEN))
  const llmModel = str(env.LLM_MODEL, 'claude-opus-5-5')
  const fallbackSetting = oneOf(env.LLM_FALLBACKS, ['auto', 'on', 'off'], 'auto')

  const config = {
    root: ROOT,
    publicDir: path.join(ROOT, 'public'),
    sharedDir: path.join(ROOT, 'shared'),
    dataDir: path.resolve(ROOT, str(env.DATA_DIR, 'data')),
    seedTrendsPath: path.join(ROOT, 'server', 'trends', 'seed-trends.json'),

    host,
    port,
    serviceName: str(env.SERVICE_NAME, DEFAULT_SERVICE_NAME),
    allowedHosts,
    allowAnyHost,
    adminToken: str(env.ADMIN_TOKEN),
    // 같은 컴퓨터의 리버스 프록시(nginx 등) 뒤에서 돌릴 때만 켠다. 켜면 X-Forwarded-For의 첫 주소를 손님 주소로 본다.
    trustProxy: ['true', '1', 'yes'].includes(String(env.TRUST_PROXY ?? '').trim().toLowerCase()),

    // 서버에 남는 기록의 보관 기간(일)
    retention: {
      events: int(env.EVENT_RETENTION_DAYS, RETENTION_DEFAULT_DAYS.events, { min: 1, max: 365 }),
      reports: int(env.REPORT_RETENTION_DAYS, RETENTION_DEFAULT_DAYS.reports, { min: 1, max: 365 }),
    },

    llm: {
      mode: llmMode,
      // auto: 키가 있으면 켠다 / on: SDK가 찾는 자격 증명(ant auth login 포함)을 그대로 쓴다
      enabled: llmMode === 'on' || (llmMode === 'auto' && hasAnthropicCredential),
      model: llmModel,
      safetyModel: str(env.LLM_SAFETY_MODEL, llmModel),
      effort: oneOf(env.LLM_EFFORT, ['low', 'medium', 'high', 'xhigh', 'max'], 'medium'),
      safetyJudge: oneOf(env.LLM_SAFETY_JUDGE, ['on', 'off'], 'on') === 'on',
      fallbacks: fallbackSetting === 'on' || (fallbackSetting === 'auto' && FALLBACK_CAPABLE.has(llmModel)),
      timeoutMs: int(env.LLM_TIMEOUT_MS, 90_000, { min: 5_000, max: 600_000 }),
      dailyCallCap: int(env.LLM_DAILY_CALL_CAP, 500, { min: 0 }),
    },

    youtube: {
      apiKey: str(env.YOUTUBE_API_KEY),
      regionCode: str(env.YOUTUBE_REGION, 'KR').toUpperCase(),
      // 0 = 전체 인기 차트. 뉴스·정치(25)는 사건·참사 희화화 위험 때문에 기본 수집에서 뺀다.
      categoryIds: list(env.YOUTUBE_CATEGORY_IDS, ['0', '10', '20', '22', '23', '24', '26']),
      maxResults: int(env.YOUTUBE_MAX_RESULTS, 50, { min: 1, max: 50 }),
      dailyUnitBudget: int(env.YOUTUBE_DAILY_UNIT_BUDGET, 500, { min: 1 }),
    },

    trends: {
      refreshMinutes: int(env.TREND_REFRESH_MINUTES, 180, { min: 15 }),
      // manual: 사람 검수를 거쳐야 노출 / auto: 금칙어 필터만 통과하면 바로 노출
      reviewMode: oneOf(env.TREND_REVIEW_MODE, ['manual', 'auto'], 'manual'),
      // 유튜브 API 데이터는 30일 안에 갱신하거나 지워야 한다. 기본은 7일.
      ttlDays: int(env.TREND_TTL_DAYS, 7, { min: 1, max: 30 }),
      maxPerRun: int(env.TREND_MAX_PER_RUN, 30, { min: 1, max: 100 }),
    },

    instagram: {
      accessToken: str(env.IG_ACCESS_TOKEN),
      userId: str(env.IG_USER_ID),
      apiVersion: str(env.IG_API_VERSION, 'v27.0'),
      maxHashtagsPerRun: int(env.IG_MAX_HASHTAGS_PER_RUN, 3, { min: 0, max: 30 }),
    },

    limits: {
      generatePerMinute: int(env.GENERATE_RATE_LIMIT_PER_MIN, 12, { min: 1 }),
      // 한 손님(IP, IPv6는 /64)이 하루에 만들 수 있는 횟수 — 한 사람이 하루 LLM 한도를 다 쓰지 못하게
      generatePerDay: int(env.GENERATE_DAILY_LIMIT_PER_CLIENT, 60, { min: 1 }),
      eventsPerMinute: int(env.EVENTS_RATE_LIMIT_PER_MIN, 120, { min: 1 }),
      bodyBytes: int(env.MAX_BODY_BYTES, 128 * 1024, { min: 1024 }),
    },

    // 성공 지표 목표 — 기획안에서 비워 둔 값이라 임시로 잡았다. 팀에서 확정하면 환경변수로 바꾼다.
    targets: {
      styleScore: num(env.TARGET_STYLE_SCORE, 4.0),
      saveShareRate: num(env.TARGET_SAVE_SHARE_RATE, 30),
      trendLatencyHours: num(env.TARGET_TREND_LATENCY_HOURS, 24),
      harmfulRate: num(env.TARGET_HARMFUL_RATE, 1),
    },
  }

  config.instagram.enabled = Boolean(config.instagram.accessToken && config.instagram.userId)
  config.youtube.enabled = Boolean(config.youtube.apiKey)
  return config
}

/** 상태 응답용 — 비밀값 없이 무엇이 켜져 있는지만 */
export function publicConfig(config) {
  return {
    serviceName: config.serviceName,
    llm: { enabled: config.llm.enabled, model: config.llm.enabled ? config.llm.model : null, safetyJudge: config.llm.safetyJudge },
    youtube: { enabled: config.youtube.enabled, regionCode: config.youtube.regionCode },
    instagram: { enabled: config.instagram.enabled },
    trends: { refreshMinutes: config.trends.refreshMinutes, reviewMode: config.trends.reviewMode, ttlDays: config.trends.ttlDays },
    retention: config.retention,
    security: { adminToken: Boolean(config.adminToken), trustProxy: config.trustProxy, publicHosts: config.allowAnyHost ? ['*'] : [...config.allowedHosts].filter((h) => !['localhost', '127.0.0.1', '[::1]', '::1'].includes(h)) },
    targets: config.targets,
  }
}
