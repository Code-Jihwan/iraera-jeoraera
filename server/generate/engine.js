// 생성 엔진의 지휘자: 입력 다듬기 → 후보 만들기(LLM 또는 규칙) → 안전 필터 → 순위.
// 기록에는 개수와 걸린 시간만 남긴다. 프로필 내용·후보 문구·직접 입력한 트렌드는 남기지 않는다.
import { LIMITS, TECHNIQUE_IDS } from '../../shared/constants.js'
import { randomUUID, sha256Hex } from '../../shared/crypto-lite.js'
import { charLength } from '../../shared/hangul.js'
import { generateLocal } from './local-engine.js'
// SDK를 부르는 llm.js 대신 오류 클래스만 불러온다 — 정적 배포에는 llm.js를 싣지 않는다
import { LlmError } from './llm-error.js'
import { buildGenerationRequest, buildSafetyRequest } from './prompt.js'
import { rankCandidates } from './ranking.js'
import { MAX_TEXT_CHARS, cleanText, isRecord, sanitizeCustomTrend, sanitizeFeedback, sanitizeOptions, sanitizeProfilePayload, textKey } from './sanitize.js'

const LLM_COUNT = 8
const LOCAL_COUNT = 10
// 안전 필터를 통과한 LLM 후보가 이보다 적으면 규칙 엔진 후보로 채운다
const MIN_SURVIVORS = 3
const TREND_ID_MAX_CHARS = 100
const LLM_CAPS = Object.freeze({ candidates: 16, example: 120, why: 120, memeElement: 60, styleElements: 4, styleElement: 24 })
const { examplesPerCandidate: EXAMPLES } = LIMITS.candidates

const ENGINE_LABELS = Object.freeze({ llm: 'AI 엔진(Claude)', local: '기본 엔진(규칙 기반)' })

/** LLM을 못 쓴 까닭을 사용자에게 알리는 문장 (오류 종류별) */
const FALLBACK_REASONS = Object.freeze({
  auth: 'AI 엔진 인증에 실패해 기본 엔진으로 만들었어요',
  rate_limit: 'AI 엔진 사용량 한도에 걸려 기본 엔진으로 만들었어요',
  daily_cap: 'AI 엔진 사용량 한도에 걸려 기본 엔진으로 만들었어요',
  refusal: 'AI 엔진이 이 요청을 거절해 기본 엔진으로 만들었어요',
})
const DEFAULT_FALLBACK_REASON = 'AI 엔진이 응답하지 않아 기본 엔진으로 만들었어요'
const JUDGE_FALLBACK_REASON = 'AI 안전 심사가 응답하지 않아 기본 엔진으로 만들었어요'

const ERROR_MESSAGES = Object.freeze({
  trend_not_found: '고른 트렌드를 찾을 수 없어요.',
  blocked_input: '입력한 말에 쓸 수 없는 표현이 있어요.',
})

export class GenerateError extends Error {
  /**
   * @param {'trend_not_found'|'blocked_input'} code
   * @param {string[]} [categories] 안전 필터에 걸린 범주(SAFETY_CATEGORIES의 키). 걸린 낱말은 담지 않는다.
   */
  constructor(code, categories = []) {
    super(ERROR_MESSAGES[code] ?? code)
    this.name = 'GenerateError'
    this.code = code
    this.categories = categories
  }
}

const fallbackReasonOf = (err) => (err instanceof LlmError && Object.hasOwn(FALLBACK_REASONS, err.kind) ? FALLBACK_REASONS[err.kind] : DEFAULT_FALLBACK_REASON)
const strings = (value) => (Array.isArray(value) ? value : [])

/** LLM이 준 후보 하나를 믿고 쓸 수 있는 모양으로 읽는다. 문구가 없거나, 너무 길거나, 빈칸 표시가 남아 있으면 버린다. */
function readLlmCandidate(item, trend) {
  if (!isRecord(item)) return null
  const text = cleanText(item.text, MAX_TEXT_CHARS + 1)
  if (!text || charLength(text) > MAX_TEXT_CHARS || /[{}]/.test(text)) return null
  const examples = strings(item.examples)
    .map((example) => cleanText(example, LLM_CAPS.example))
    .filter(Boolean)
    .slice(0, EXAMPLES)
  return {
    text,
    // 예문은 꼭 정해진 개수로 맞춘다: 모자라면 마지막 예문(없으면 문구)으로 채운다
    examples: Array.from({ length: EXAMPLES }, (_, i) => examples[i] ?? examples.at(-1) ?? text),
    technique: TECHNIQUE_IDS.includes(item.technique) ? item.technique : 'twist',
    styleElements: strings(item.styleElements)
      .map((element) => cleanText(element, LLM_CAPS.styleElement))
      .filter(Boolean)
      .slice(0, LLM_CAPS.styleElements),
    memeElement: cleanText(item.memeElement, LLM_CAPS.memeElement) || trend.pattern || trend.keyword,
    why: cleanText(item.why, LLM_CAPS.why),
    engine: 'llm',
  }
}

const readLlmCandidates = (payload, trend) =>
  strings(payload?.candidates)
    .slice(0, LLM_CAPS.candidates)
    .map((item) => readLlmCandidate(item, trend))
    .filter(Boolean)

/** 심사 결과에서 이 후보가 분명히 안전하다고 했는지. 답이 없거나 엇갈리면 안전하지 않은 것으로 본다. */
function isCleared(results, index) {
  const mine = results.filter((result) => result?.index === index)
  return mine.length > 0 && mine.every((result) => result.safe === true)
}

/**
 * @param {{ config: object, llm: object|null, safety: object, trendStore: object,
 *           log?: { info: Function, warn: Function }, now?: () => number, newId?: () => string }} deps
 */
export function createGenerator({ config, llm, safety, trendStore, log = console, now = () => Date.now(), newId = () => randomUUID() }) {
  /** 글 가운데 안전 필터에 막힌 것이 있으면 걸린 범주들을, 없으면 null을 돌려준다. 걸린 낱말은 필터가 알려 주지 않는다. */
  function blockedBy(texts, context) {
    const blocked = texts
      .filter(Boolean)
      .map((text) => safety.checkText(text, { context }))
      .filter((verdict) => !verdict.ok)
    return blocked.length ? [...new Set(blocked.flatMap((verdict) => strings(verdict.categories)))] : null
  }

  /** 직접 입력한 트렌드를 다듬고 1차 금칙어 필터에 통과시킨다. 키워드가 비어 있으면 TypeError. */
  async function checkCustomTrend(raw) {
    const { keyword, meaning } = sanitizeCustomTrend(raw)
    const categories = blockedBy([keyword, meaning], 'trend')
    if (categories) return { ok: false, categories }
    const id = `custom-${sha256Hex(keyword).slice(0, 10)}`
    return {
      ok: true,
      trend: {
        id,
        keyword,
        kind: 'keyword',
        pattern: null,
        meaning,
        origin: '',
        caution: '',
        category: '일상',
        source: { type: 'custom', label: '직접 입력', url: null, title: null },
        stats: null,
        collectedAt: null,
        publishedAt: null,
        status: 'approved',
        sample: false,
        meaningVerified: false,
        engine: null,
      },
    }
  }

  async function resolveTrend(trendId, customTrend) {
    if (typeof trendId === 'string' && trendId && trendId.length <= TREND_ID_MAX_CHARS) {
      const found = trendStore.get(trendId)
      if (!found || found.status !== 'approved') throw new GenerateError('trend_not_found')
      return found
    }
    if (customTrend == null) throw new GenerateError('trend_not_found')
    const checked = await checkCustomTrend(customTrend)
    if (!checked.ok) throw new GenerateError('blocked_input', checked.categories)
    return checked.trend
  }

  /** 프로필에서 안전 필터에 걸리는 말투 요소와 대표 문장을 뺀다 — 프롬프트와 후보에 섞여 들어가지 않게. */
  function safeProfile(profile) {
    const keep = (terms) => safety.filterStyleTerms(terms)
    const { tail } = profile
    return {
      ...profile,
      endings: keep(profile.endings),
      fillers: keep(profile.fillers),
      expressions: keep(profile.expressions),
      tail: { ...tail, emoji: keep(tail.emoji), emoticons: keep(tail.emoticons), punct: keep(tail.punct), choseong: keep(tail.choseong) },
      samples: profile.samples.filter((sample) => !blockedBy([sample], 'input')),
    }
  }

  async function prepare({ profile, trendId, customTrend, options, feedback }) {
    const cleanOptions = sanitizeOptions(options)
    const trend = await resolveTrend(trendId, customTrend)
    const blockedTopic = blockedBy([cleanOptions.topic], 'input')
    if (blockedTopic) throw new GenerateError('blocked_input', blockedTopic)
    return { profile: safeProfile(sanitizeProfilePayload(profile)), trend, options: cleanOptions, feedback: sanitizeFeedback(feedback) }
  }

  /** 금칙어 필터를 통과한 후보만 남기고, 본 개수와 막은 개수를 센다. */
  function ruleFilter(candidates, tally) {
    const passed = candidates.filter((candidate) => safety.checkCandidate(candidate).ok)
    tally.generated += candidates.length
    tally.blocked += candidates.length - passed.length
    return passed
  }

  /**
   * 규칙 엔진 후보. 이미 보여 준 문구를 빼고 나면 needed개도 안 될 때는 빈손으로 돌려보내지 않도록,
   * 오래전에 보여 준 문구부터 다시 쓸 수 있게 되풀이 방지 목록을 반씩 덜어 내며 다시 만든다.
   * @returns {{ candidates: object[], feedback: object }} feedback은 실제로 적용한 되풀이 방지 목록이 담긴 것
   */
  function localCandidates(request, tally, needed) {
    let { feedback } = request
    for (;;) {
      const counts = { generated: 0, blocked: 0 }
      const made = ruleFilter(generateLocal({ ...request, feedback, frames: trendStore.frames(), count: LOCAL_COUNT }), counts)
      if (made.length >= needed || !feedback.shown.length) {
        tally.generated += counts.generated
        tally.blocked += counts.blocked
        return { candidates: made.map((candidate) => ({ ...candidate, engine: 'local' })), feedback }
      }
      // shown은 최근 것이 앞에 있으므로 뒤쪽(오래된 것) 절반을 잊는다
      feedback = { ...feedback, shown: feedback.shown.slice(0, feedback.shown.length >> 1) }
    }
  }

  /** LLM 안전 심사. 심사를 받지 못하면 후보를 내보내지 않는다(막힌 것으로 센다). */
  async function judged(candidates, trend, tally) {
    let results = null
    try {
      const verdict = await llm.generateJson({ ...buildSafetyRequest(candidates, trend), effort: 'low', model: config.llm.safetyModel, purpose: 'safety' })
      results = Array.isArray(verdict?.results) ? verdict.results : null
    } catch {
      results = null
    }
    const cleared = results ? candidates.filter((_, index) => isCleared(results, index)) : []
    tally.blocked += candidates.length - cleared.length
    return { candidates: cleared, fallbackReason: results ? null : JUDGE_FALLBACK_REASON, judged: Boolean(results) }
  }

  async function llmCandidates(request, tally) {
    let payload
    try {
      payload = await llm.generateJson(buildGenerationRequest({ ...request, count: LLM_COUNT }))
    } catch (err) {
      return { candidates: [], fallbackReason: fallbackReasonOf(err), judged: false }
    }
    const read = readLlmCandidates(payload, request.trend)
    if (!read.length) return { candidates: [], fallbackReason: DEFAULT_FALLBACK_REASON, judged: false }
    const passed = ruleFilter(read, tally)
    if (!config.llm?.safetyJudge || !passed.length) return { candidates: passed, fallbackReason: null, judged: false }
    return judged(passed, request.trend, tally)
  }

  /** 순위를 매길 후보를 모은다. 살아남은 LLM 후보가 모자라면 규칙 엔진 후보로 채운다. */
  async function gather(request, tally) {
    const fromLlm = llm?.available() ? await llmCandidates(request, tally) : { candidates: [], fallbackReason: null, judged: false }
    // LLM이 이미 보여 준 문구를 또 냈다면 살아남은 것으로 치지 않는다
    const shown = new Set(request.feedback.shown.map(textKey))
    const survivors = fromLlm.candidates.filter((candidate) => !shown.has(textKey(candidate.text)))
    if (survivors.length >= MIN_SURVIVORS) return { ...fromLlm, candidates: survivors, feedback: request.feedback }
    const local = localCandidates(request, tally, MIN_SURVIVORS - survivors.length)
    return { ...fromLlm, candidates: [...survivors, ...local.candidates], feedback: local.feedback }
  }

  /** 돌려줄 후보의 절반 넘게가 LLM이 만든 것일 때만 AI 엔진이 만들었다고 표시한다. */
  function engineInfo(candidates, fallbackReason) {
    const mode = candidates.filter((candidate) => candidate.engine === 'llm').length * 2 > candidates.length ? 'llm' : 'local'
    return { mode, label: ENGINE_LABELS[mode], model: mode === 'llm' ? (config.llm?.model ?? null) : null, fallbackReason }
  }

  /**
   * @param {{ profile?: unknown, trendId?: unknown, customTrend?: unknown, options?: unknown, feedback?: unknown }} input 요청 본문 그대로
   * @returns {Promise<import('../../shared/types.js').GenerateResult>}
   * @throws {GenerateError} 트렌드를 찾을 수 없거나(trend_not_found) 입력이 안전 필터에 걸렸을 때(blocked_input)
   * @throws {TypeError} 직접 입력한 트렌드의 키워드가 비어 있을 때
   */
  async function generate(input) {
    const started = now()
    const request = await prepare(input ?? {})
    const tally = { generated: 0, blocked: 0 }
    const pool = await gather(request, tally)
    const requestId = String(newId())
    const candidates = rankCandidates(pool.candidates, { ...request, feedback: pool.feedback, count: LIMITS.candidates.count, requestId })
    const engine = engineInfo(candidates, pool.fallbackReason)
    const { generated, blocked } = tally
    const safetyReport = { generated, blocked, passed: generated - blocked, judge: pool.judged ? 'rules+llm' : 'rules' }
    // 규칙 엔진용 힌트는 서버 안에서만 쓰고 브라우저로 보내지 않는다
    const trend = Object.fromEntries(Object.entries(request.trend).filter(([key]) => key !== 'engine'))
    const counts = `후보 ${candidates.length}개 · 생성 ${generated} · 차단 ${blocked} · 대체 ${engine.fallbackReason ? '있음' : '없음'}`
    log.info(`[generate] ${engine.mode} · ${counts} · ${now() - started}ms`)
    return { requestId, engine, candidates, safety: safetyReport, trend, createdAt: new Date(now()).toISOString() }
  }

  return { generate, checkCustomTrend }
}
