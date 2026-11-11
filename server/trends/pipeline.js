// 트렌드 수집 배치: 인기 차트 수집 → 키워드 추출 → 1차 금칙어 필터 → (선택) 인스타그램 반응 확인 → 저장 → 만료 정리.
import path from 'node:path'
import { readJson, writeJsonAtomic } from '../store.js'
import { extractKeywordTrends } from './extract.js'
import { extractMemeTrends } from './extract-llm.js'

const RUNS_FILE = 'trend-runs.json'
const RUNS_KEPT = 20
const CATEGORIES_MAX = 20
const CATEGORY_ID_MAX = 8
const DEFAULT_REFRESH_MINUTES = 180
const DEFAULT_MAX_PER_RUN = 30
// 설정이 잘못돼도 차트를 쉴 새 없이 두드리지 않게 하는 하한
const MIN_INTERVAL_MS = 60_000
// setTimeout이 받는 가장 긴 시간(약 24.8일). 넘기면 곧바로 실행돼 버린다.
const MAX_TIMER_MS = 2 ** 31 - 1
const NO_CHART_REASON = 'videoChartNotFound'
const TRIGGER = /^[a-z][a-z_-]{0,19}$/

const NO_KEY_MESSAGE = 'YOUTUBE_API_KEY가 없어 수집을 건너뜁니다.'
const LLM_FALLBACK_MESSAGE = 'AI 추출에 실패해 규칙 기반 추출로 대신했습니다.'
const UNEXPECTED_MESSAGE = '수집 중 예상하지 못한 오류가 났습니다. 서버 로그를 확인해 주세요.'

// 인스타그램 반응 확인 실패 가운데 운영자가 손써야 하는 것만 보고서에 알린다(태그 하나를 못 찾은 것 같은 일은 알리지 않는다)
const REACTION_NOTES = new Map([
  ['auth', '인스타그램 토큰이 만료됐거나 권한이 없어 반응 확인을 껐습니다. 토큰을 새로 넣고 서버를 다시 띄워 주세요.'],
  ['rate_limited', '인스타그램 호출 한도에 걸려 반응 확인을 한 시간 쉽니다.'],
  ['ledger', '인스타그램 해시태그 장부를 읽거나 쓸 수 없어 반응 확인을 건너뛰었습니다.'],
])

const positive = (value, fallback) => (Number.isFinite(value) && value > 0 ? value : fallback)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const toIso = (ms) => new Date(ms).toISOString()
const chartLabel = (categoryId) => (categoryId === '0' ? '전체 차트' : `분류 ${categoryId} 차트`)
const isReport = (run) => typeof run?.finishedAt === 'string' && typeof run.ok === 'boolean'

function readSettings(config, youtube, instagram) {
  const { youtube: chart = {}, trends = {}, instagram: reaction = {} } = config
  const categoryIds = (Array.isArray(chart.categoryIds) ? chart.categoryIds : []).map((id) => String(id).trim().slice(0, CATEGORY_ID_MAX)).filter(Boolean)
  return {
    enabled: Boolean(youtube && chart.apiKey),
    regionCode: chart.regionCode ?? 'KR',
    maxResults: chart.maxResults ?? 50,
    categoryIds: categoryIds.length > 0 ? [...new Set(categoryIds)].slice(0, CATEGORIES_MAX) : ['0'],
    intervalMs: Math.min(MAX_TIMER_MS, Math.max(MIN_INTERVAL_MS, positive(trends.refreshMinutes, DEFAULT_REFRESH_MINUTES) * 60_000)),
    reviewMode: trends.reviewMode === 'auto' ? 'auto' : 'manual',
    maxPerRun: Math.max(1, Math.floor(positive(trends.maxPerRun, DEFAULT_MAX_PER_RUN))),
    maxHashtags: instagram ? Math.floor(positive(reaction.maxHashtagsPerRun, 0)) : 0,
  }
}

/** 여러 차트에 함께 오른 영상은 한 번만 남기되, 더 높은 순위를 따른다. */
function mergeVideos(byId, videos) {
  for (const video of Array.isArray(videos) ? videos : []) {
    if (typeof video?.id !== 'string') continue
    const seen = byId.get(video.id)
    if (!seen || video.rank < seen.rank) byId.set(video.id, video)
  }
}

/**
 * @param {{ config: any, store: any, youtube?: any, instagram?: any, llm?: any, safety: { checkTrend: Function },
 *           log?: { info: Function, warn: Function, error: Function }, now?: () => number,
 *           startupDelayMs?: number, retryDelayMs?: number }} deps
 */
export function createTrendPipeline({ config, store, youtube = null, instagram = null, llm = null, safety, log = console, now = () => Date.now(), startupDelayMs = 5_000, retryDelayMs = 1_500 } = {}) {
  if (typeof config?.dataDir !== 'string' || !config.dataDir) throw new TypeError('config.dataDir가 필요합니다.')
  if (typeof store?.upsertDrafts !== 'function' || typeof store.purgeExpired !== 'function') throw new TypeError('트렌드 저장소(store)가 필요합니다.')
  if (typeof safety?.checkTrend !== 'function') throw new TypeError('금칙어 필터(safety.checkTrend)가 필요합니다.')

  const settings = readSettings(config, youtube, instagram)
  const runsFile = path.join(config.dataDir, RUNS_FILE)
  const startDelayMs = Number.isFinite(startupDelayMs) && startupDelayMs >= 0 ? startupDelayMs : 0
  const retryWaitMs = Number.isFinite(retryDelayMs) && retryDelayMs >= 0 ? retryDelayMs : 0

  let runs = []
  let runsLoaded = null
  let inFlight = null
  let started = false
  let timer = null
  let nextRunAt = null

  const blankReport = (trigger) => ({
    startedAt: toIso(now()),
    finishedAt: null,
    trigger,
    ok: false,
    videos: 0,
    drafts: 0,
    blocked: 0,
    added: 0,
    updated: 0,
    purged: 0,
    extractor: 'none',
    igChecked: 0,
    errors: [],
    unitsUsed: 0,
  })

  /** 지난 실행 기록을 한 번만 읽는다. 읽지 못해도 수집은 계속한다. */
  function loadRuns() {
    runsLoaded ??= readJson(runsFile, null).then(
      (saved) => {
        runs = (Array.isArray(saved?.runs) ? saved.runs : []).filter(isReport).slice(-RUNS_KEPT)
      },
      (err) => log.warn(`[trends] 실행 기록을 읽지 못했습니다: ${err.message}`),
    )
    return runsLoaded
  }

  async function remember(report) {
    await loadRuns()
    // 돌려준 보고서를 받은 쪽에서 고쳐도 기록은 그대로이도록 복사해 둔다
    runs = [...runs, structuredClone(report)].slice(-RUNS_KEPT)
    try {
      await writeJsonAtomic(runsFile, { runs })
    } catch (err) {
      log.warn(`[trends] 실행 기록을 저장하지 못했습니다: ${err.message}`)
    }
  }

  const spentUnits = () => (Number.isFinite(youtube.requestCount) ? youtube.requestCount : 0)

  async function fetchChart(categoryId) {
    const request = { regionCode: settings.regionCode, categoryId, maxResults: settings.maxResults }
    try {
      return await youtube.mostPopular(request)
    } catch (err) {
      if (!err?.retryable) throw err
      // 일시적인 오류(연결 실패, 요청 제한)만 잠깐 쉬고 한 번 더 해 본다. 다시 보낼 때마다 할당량이 든다.
      await sleep(retryWaitMs)
      return youtube.mostPopular(request)
    }
  }

  /** API 오류와 설정 오류는 우리가 쓴 문구라 그대로 보여 주고, 그 밖의 오류는 로그에만 남긴다. */
  function describeError(err) {
    if (typeof err?.reason === 'string' || err instanceof TypeError) return err.message
    log.error('[trends] 차트 요청 중 오류:', err)
    return '요청을 처리하지 못했습니다.'
  }

  /** 분류별 차트를 차례로 받는다. 한 분류의 실패는 건너뛰고, 할당량·키 문제면 거기서 멈춘다. */
  async function fetchCharts(report) {
    const byId = new Map()
    let failures = 0
    for (const categoryId of settings.categoryIds) {
      try {
        mergeVideos(byId, await fetchChart(categoryId))
      } catch (err) {
        // 차트가 없는 분류는 오류가 아니다
        if (err?.reason === NO_CHART_REASON) continue
        failures++
        report.errors.push(`${chartLabel(categoryId)}: ${describeError(err)}`)
        if (err?.fatal) return { videos: [...byId.values()], complete: false }
      }
    }
    return { videos: [...byId.values()], complete: failures < settings.categoryIds.length }
  }

  async function extractDrafts(videos, report) {
    if (videos.length === 0) return []
    const at = now()
    if (llm?.available?.()) {
      try {
        const drafts = await extractMemeTrends(videos, llm, { now: at, max: settings.maxPerRun })
        report.extractor = 'llm'
        return drafts
      } catch (err) {
        report.errors.push(LLM_FALLBACK_MESSAGE)
        log.warn(`[trends] AI 추출 실패(${err?.kind ?? err?.name ?? 'error'}) — 규칙 기반 추출로 대신합니다.`)
      }
    }
    report.extractor = 'rules'
    // 필터에서 빠질 몫을 감안해 넉넉히 뽑는다
    return extractKeywordTrends(videos, { now: at, max: settings.maxPerRun * 2 })
  }

  /** 1차 금칙어 필터. 통과가 분명한 초안만 남긴다. 무엇이 걸렸는지는 세기만 하고 남기지 않는다. */
  function screen(drafts, report) {
    const passed = drafts.filter((draft) => safety.checkTrend(draft)?.ok === true)
    report.drafts = drafts.length
    report.blocked = drafts.length - passed.length
    return passed.slice(0, settings.maxPerRun)
  }

  async function reactionOf(draft) {
    try {
      return await instagram.checkHashtag(draft.keyword)
    } catch {
      return null
    }
  }

  /** 위쪽 몇 개만 인스타그램 반응을 확인한다. 결과는 점수에 섞지 않고 따로 붙인다. 실패해도 수집은 계속한다. */
  async function checkReactions(drafts, report) {
    if (!instagram?.enabled) return
    for (const draft of drafts.slice(0, settings.maxHashtags)) {
      const reaction = await reactionOf(draft)
      if (!reaction) continue
      draft.instagram = { tag: reaction.tag, mediaCount: reaction.mediaCount, checkedAt: reaction.checkedAt }
      report.igChecked++
    }
    const failure = instagram.lastError
    const note = REACTION_NOTES.get(failure?.kind)
    if (note && failure.at >= report.startedAt) report.errors.push(note)
  }

  async function collect(report) {
    const spentBefore = spentUnits()
    try {
      const charts = await fetchCharts(report)
      report.videos = charts.videos.length
      const drafts = screen(await extractDrafts(charts.videos, report), report)
      await checkReactions(drafts, report)
      const { added, updated } = await store.upsertDrafts(drafts, { reviewMode: settings.reviewMode })
      report.added = added
      report.updated = updated
      report.ok = charts.complete
    } finally {
      report.unitsUsed = spentUnits() - spentBefore
      // 수집이 실패해도 보관 기간이 지난 데이터는 지운다(YouTube 정책의 보관 한도)
      report.purged = await store.purgeExpired()
    }
  }

  async function execute(trigger) {
    const report = blankReport(trigger)
    try {
      await collect(report)
    } catch (err) {
      report.ok = false
      report.errors.push(UNEXPECTED_MESSAGE)
      log.error('[trends] 수집 중 오류:', err)
    }
    report.finishedAt = toIso(now())
    await remember(report)
    log.info(
      `[trends] 수집 ${report.ok ? '완료' : '실패'}(${report.trigger}): 영상 ${report.videos}개, 키워드 ${report.drafts}개(차단 ${report.blocked}), 새로 ${report.added}건, 갱신 ${report.updated}건, 정리 ${report.purged}건, 할당량 ${report.unitsUsed}단위`,
    )
    return report
  }

  function skippedReport(trigger) {
    const report = blankReport(trigger)
    report.finishedAt = report.startedAt
    report.errors.push(NO_KEY_MESSAGE)
    return report
  }

  /**
   * 수집을 한 번 돌린다. 예외를 던지지 않고 결과를 보고서로 돌려준다.
   * 이미 돌고 있으면 그 실행의 프라미스를 그대로 돌려준다.
   * @param {{ trigger?: string }} [options]
   */
  function runOnce(options) {
    const trigger = TRIGGER.test(String(options?.trigger ?? '')) ? options.trigger : 'manual'
    if (!settings.enabled) return Promise.resolve(skippedReport(trigger))
    inFlight ??= execute(trigger).finally(() => {
      inFlight = null
    })
    return inFlight
  }

  function sinceLastRun() {
    const finished = Date.parse(runs.at(-1)?.finishedAt ?? '')
    return Number.isNaN(finished) ? Infinity : Math.max(0, now() - finished)
  }

  function schedule(delayMs) {
    // 예약은 언제나 하나만 둔다(도는 중에 껐다 켜도 겹치지 않게)
    clearTimeout(timer)
    nextRunAt = now() + delayMs
    timer = setTimeout(() => {
      nextRunAt = null
      const again = () => {
        if (started) schedule(settings.intervalMs)
      }
      runOnce({ trigger: 'schedule' }).then(again, again)
    }, delayMs)
    // 수집 예약 때문에 프로세스가 끝나지 못하는 일이 없게 한다
    timer.unref?.()
  }

  return {
    runOnce,

    /** 주기 수집을 켠다. 마지막 수집이 주기보다 오래됐으면 곧 한 번 돌고, 아니면 남은 시간만큼 기다린다. */
    start() {
      if (!settings.enabled || started) return
      started = true
      loadRuns().then(() => {
        if (started && !timer) schedule(Math.max(startDelayMs, settings.intervalMs - sinceLastRun()))
      })
    },

    stop() {
      started = false
      clearTimeout(timer)
      timer = null
      nextRunAt = null
    },

    /** @returns {{ enabled: boolean, running: boolean, lastRun: object|null, nextRunAt: string|null, quota: { day: string, used: number, budget: number }|null }} */
    status() {
      return {
        enabled: settings.enabled,
        running: Boolean(inFlight),
        lastRun: runs.length > 0 ? structuredClone(runs.at(-1)) : null,
        nextRunAt: nextRunAt === null ? null : toIso(nextRunAt),
        quota: youtube?.quota?.() ?? null,
      }
    },
  }
}
