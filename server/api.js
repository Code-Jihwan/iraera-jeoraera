// API 라우트. 사용자 앱이 부르는 것과 운영 화면이 부르는 것(/api/ops/*)으로 나뉜다.
import { HttpError } from './http.js'
import { publicConfig } from './config.js'
import { CONSENT_VERSION } from '../shared/constants.js'
import { blockedTrendError, generateErrorResponse, trendCheckErrorResponse } from '../shared/api-messages.js'

/** 브라우저에는 규칙 엔진 힌트를 빼고 보낸다. */
function publicTrend(trend) {
  if (!trend) return null
  const { engine, ...rest } = trend
  return rest
}

/** 사용자에게 보여 줄 오류 문구는 shared/api-messages.js에 모아 정적 배포와 함께 쓴다. */
const httpError = ({ status, message, code }) => new HttpError(status, message, code)

/**
 * @param {ReturnType<import('./http.js').createApp>} app
 * @param {{ config:any, trendStore:any, pipeline:any, generator:any, llm:any, events:any, instagram:any, log:any }} deps
 */
export function registerRoutes(app, { config, trendStore, pipeline, generator, llm, events, instagram, log = console }) {
  function engineStatus() {
    const s = llm.status()
    const mode = llm.available() ? 'llm' : 'local'
    return {
      mode,
      label: mode === 'llm' ? 'AI 엔진(Claude)' : '기본 엔진(규칙 기반)',
      model: mode === 'llm' ? s.model : null,
      // 키를 넣었는데도 기본 엔진으로 돌 때 이유를 알려 준다
      reason: mode === 'llm' ? null : s.enabled ? s.reason || 'AI 엔진을 쓸 수 없는 상태입니다.' : null,
      configured: Boolean(s.enabled),
    }
  }

  function trendStatus() {
    const stats = trendStore.stats()
    const p = pipeline.status()
    return {
      ...stats,
      youtubeEnabled: config.youtube.enabled,
      instagramEnabled: config.instagram.enabled,
      reviewMode: config.trends.reviewMode,
      refreshMinutes: config.trends.refreshMinutes,
      ttlDays: config.trends.ttlDays,
      lastRunAt: p.lastRun?.finishedAt ?? null,
      lastRunOk: p.lastRun ? Boolean(p.lastRun.ok) : null,
      nextRunAt: p.nextRunAt ?? null,
    }
  }

  // ── 사용자 앱 ──────────────────────────────────────────

  app.get('/api/status', async () => ({
    serviceName: config.serviceName,
    consentVersion: CONSENT_VERSION,
    // 고지 문구가 실제 보관 기간을 그대로 보여 주도록 알려 준다
    retention: config.retention,
    engine: engineStatus(),
    trends: trendStatus(),
  }))

  app.get('/api/trends', async () => {
    const items = trendStore.list({ status: 'approved', includeSeed: true }).map(publicTrend)
    return { items, status: trendStatus() }
  })

  // 직접 입력한 트렌드를 1차 금칙어 필터에 통과시킨다
  app.post('/api/trends/check', async (ctx) => {
    ctx.limit('trend-check', 30)
    let result
    try {
      result = await generator.checkCustomTrend(ctx.body)
    } catch (err) {
      const known = trendCheckErrorResponse(err)
      if (known) throw httpError(known)
      throw err
    }
    if (!result.ok) throw httpError(blockedTrendError(result.categories))
    return { trend: publicTrend(result.trend) }
  })

  app.post('/api/generate', async (ctx) => {
    ctx.limit('generate', config.limits.generatePerMinute)
    // 한 사람이 하루 AI 호출 한도를 다 써 버리지 않도록 손님마다 하루 횟수도 센다
    ctx.limit('generate-day', config.limits.generatePerDay, 24 * 3600 * 1000, '오늘은 유행어를 충분히 많이 만들었어요. 내일 다시 이용해 주세요.')
    const body = ctx.body
    let result
    try {
      result = await generator.generate({
        profile: body.profile,
        trendId: body.trendId,
        customTrend: body.customTrend,
        options: body.options,
        feedback: body.feedback,
      })
    } catch (err) {
      const known = generateErrorResponse(err)
      if (known) throw httpError(known)
      throw err
    }
    // 지표용 집계만 남긴다(문구·프로필 내용은 남기지 않는다). 기록 실패가 응답을 막지 않게 한다.
    events
      .recordGeneration({
        requestId: result.requestId,
        anonId: body.anonId,
        trend: result.trend,
        engine: result.engine,
        safety: result.safety,
        candidateCount: result.candidates.length,
        hasVoice: Boolean(body.profile?.hasVoice),
        hasText: Boolean(body.profile?.hasText),
        sample: body.sampleProfile === true,
      })
      .catch((err) => log.warn('[events] 생성 기록 실패:', err.message))
    return result
  })

  app.post('/api/events', async (ctx) => {
    ctx.limit('events', config.limits.eventsPerMinute)
    const ok = await events.recordClientEvent(ctx.body)
    if (!ok) throw new HttpError(400, '기록할 수 없는 반응입니다.', 'bad_event')
    return { ok: true }
  })

  app.post('/api/report', async (ctx) => {
    ctx.limit('report', 20)
    const ok = await events.recordReport(ctx.body)
    if (!ok) throw new HttpError(400, '신고 내용을 확인해 주세요.', 'bad_report')
    return { ok: true }
  })

  // ── 운영 화면 ──────────────────────────────────────────

  app.get('/api/ops/overview', async (ctx) => {
    ctx.requireAdmin()
    const latencyHours = trendStore.latencyHours()
    // 기록 파일은 한 번만 읽어 전체 기간과 최근 7일을 함께 계산한다
    const { all, recent: week } = await events.overview({ latencyHours, sinceMs: Date.now() - 7 * 24 * 3600 * 1000 })
    let igBudget = null
    if (instagram?.enabled) {
      try {
        igBudget = await instagram.budget()
      } catch {
        igBudget = null
      }
    }
    return {
      config: publicConfig(config),
      engine: { ...engineStatus(), llm: llm.status() },
      trends: trendStatus(),
      pipeline: pipeline.status(),
      instagram: { enabled: Boolean(instagram?.enabled), budget: igBudget },
      metrics: { all, week },
      targets: config.targets,
    }
  })

  app.get('/api/ops/trends', async (ctx) => {
    ctx.requireAdmin()
    const pick = (status) => trendStore.list({ status, includeSeed: false }).map(publicTrend)
    return { pending: pick('pending'), approved: pick('approved'), rejected: pick('rejected'), seedCount: trendStore.stats().seed }
  })

  app.post('/api/ops/trends/:id', async (ctx) => {
    ctx.requireAdmin()
    const status = String(ctx.body.status ?? '')
    if (!['approved', 'pending', 'rejected'].includes(status)) throw new HttpError(400, '상태 값이 올바르지 않습니다.', 'bad_status')
    const trend = trendStore.get(ctx.params.id)
    if (!trend) throw new HttpError(404, '트렌드를 찾을 수 없습니다.', 'not_found')
    if (trend.sample) throw new HttpError(400, '예시 데이터는 바꿀 수 없습니다.', 'seed_readonly')
    const edits = ctx.body.edits && typeof ctx.body.edits === 'object' ? ctx.body.edits : {}
    const updated = await trendStore.setStatus(ctx.params.id, status, edits)
    return { trend: publicTrend(updated) }
  })

  app.post('/api/ops/collect', async (ctx) => {
    ctx.requireAdmin()
    ctx.limit('collect', 6)
    const report = await pipeline.runOnce({ trigger: 'manual' })
    return { report }
  })

  app.get('/api/ops/reports', async (ctx) => {
    ctx.requireAdmin()
    return { reports: await events.listReports({ limit: 100 }) }
  })
}
