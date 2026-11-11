// 인스타그램 해시태그 "반응 확인" (선택 기능). IG_ACCESS_TOKEN과 IG_USER_ID가 모두 있을 때만 켜진다.
// 공식 Graph API의 해시태그 검색만 쓰고, 게시물 내용은 받지 않는다. 결과는 유튜브 데이터와 섞지 않고 따로 보여 준다.
import { readFile } from 'node:fs/promises'
import { writeJsonAtomic } from '../store.js'
import { withFileLock } from './quota.js'

// 해시태그 검색은 graph.facebook.com에서만 제공된다
const GRAPH_URL = 'https://graph.facebook.com'
const DEFAULT_API_VERSION = 'v27.0'
// 데이터 최소화: 캡션·미디어 주소·퍼머링크는 요청하지 않는다
const MEDIA_FIELDS = 'id,media_type,comments_count,like_count,timestamp'
const PAGE_LIMIT = 50

// 계정 하나가 7일(이동 구간) 동안 조회할 수 있는 서로 다른 해시태그는 30개다.
// 칸은 그 태그를 처음 조회한 때 잡히고, 그로부터 7일 뒤에 풀린다. 그 안에 다시 조회해도 칸을 더 쓰지 않고 기한도 늘지 않는다.
const HASHTAG_LIMIT = 30
const WINDOW_DAYS = 7
const WINDOW_MS = WINDOW_DAYS * 86_400_000
// 우리 시계와 Meta 쪽 시계가 조금 어긋나도 30개를 넘지 않도록, 창이 끝나는 때 앞뒤 5분은 보수적으로 센다
const CLOCK_SKEW_MS = 5 * 60_000
// 같은 태그는 한 시간에 한 번만 다시 묻는다(실패한 조회도 마찬가지). 앱 단위 호출 한도를 아끼기 위해서다.
const RECHECK_MS = 60 * 60_000
const PAUSE_MS = 60 * 60_000

const TAG_MAX = 100
const GRAPH_ID = /^\d{5,25}$/
const VERSION = /^v\d{1,3}\.\d{1,2}$/

// Graph API 오류 코드별 대응. 여기에 없는 코드는 "이 태그는 지금 확인할 수 없음"으로만 처리한다
// (민감한 해시태그 등에는 문서에 없는 일반 오류가 온다).
const AUTH_CODES = new Set([10, 102, 190, 368]) // 권한 없음·세션 만료·토큰 만료·정책 차단 → 고칠 때까지 끈다
const RATE_CODES = new Set([4, 17, 32, 341, 613, 80004]) // 호출 한도 → 한 시간 쉰다

function errorKind(code) {
  if (AUTH_CODES.has(code) || (code >= 200 && code <= 299)) return 'auth'
  return RATE_CODES.has(code) ? 'rate_limited' : 'unavailable'
}

/**
 * 해시태그 이름을 조회할 수 있는 꼴로 맞춘다. 쓸 수 없는 이름이면 null.
 * @param {unknown} raw '#먹방', '두바이 초콜릿' …
 * @returns {string|null}
 */
export function normalizeTag(raw) {
  if (typeof raw !== 'string' || raw.length > TAG_MAX * 4) return null
  const tag = raw.normalize('NFC').trim().replace(/^#+/, '').replace(/\s+/g, '').toLowerCase()
  // 이모지는 조회할 수 없다. 키캡·국기 이모지는 아래 허용 목록에서 걸러진다.
  if (!tag || /\p{Extended_Pictographic}/u.test(tag)) return null
  return /^[\p{L}\p{N}_]{1,100}$/u.test(tag) ? tag : null
}

const isSlot = (slot) =>
  typeof slot?.userId === 'string' &&
  typeof slot.tag === 'string' &&
  Number.isFinite(slot.firstQueriedAt) &&
  (slot.hashtagId === null || (typeof slot.hashtagId === 'string' && GRAPH_ID.test(slot.hashtagId))) &&
  (slot.checkedAt === null || Number.isFinite(slot.checkedAt)) &&
  (slot.mediaCount === null || Number.isInteger(slot.mediaCount))

/**
 * @param {{ accessToken: string, userId: string, apiVersion?: string, fetchImpl?: typeof fetch, ledgerFile: string, now?: () => number, timeoutMs?: number }} opts
 */
export function createInstagramClient({ accessToken, userId, apiVersion, fetchImpl = fetch, ledgerFile, now = () => Date.now(), timeoutMs = 10_000 } = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl은 함수여야 합니다.')
  const token = typeof accessToken === 'string' ? accessToken.trim() : ''
  const account = GRAPH_ID.test(String(userId ?? '').trim()) ? String(userId).trim() : ''
  // 버전을 빼고 부르면 어떤 버전으로 처리될지 문서마다 설명이 달라서, 항상 버전을 적어 보낸다
  const baseUrl = `${GRAPH_URL}/${VERSION.test(String(apiVersion ?? '')) ? apiVersion : DEFAULT_API_VERSION}`
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.ceil(timeoutMs) : 10_000
  const configured = Boolean(token && account && typeof ledgerFile === 'string' && ledgerFile)

  let disabled = false
  let pausedUntil = 0
  let lastError = null
  let queue = Promise.resolve()

  /** 이 클라이언트의 조회를 한 줄로 세운다: 같은 태그를 잇달아 물으면 앞 조회가 끝난 뒤 그 결과를 그대로 쓴다. 장부 자체는 파일 잠금이 지킨다. */
  function exclusive(task) {
    const run = queue.then(task)
    queue = run.catch(() => {})
    return run
  }

  /** 실패는 종류와 숫자 코드로만 남긴다. 요청 주소(토큰이 들어 있다)와 응답 문구는 어디에도 싣지 않는다. */
  function fail(kind, code = null, subcode = null) {
    lastError = { kind, code, subcode, at: new Date(now()).toISOString() }
    if (kind === 'auth') disabled = true
    if (kind === 'rate_limited') pausedUntil = now() + PAUSE_MS
    return null
  }

  /** Graph API를 한 번 부른다. 토큰은 문서에 나온 대로 access_token 쿼리로 보낸다. 실패하면 null. */
  async function callGraph(pathname, params) {
    const query = new URLSearchParams({ ...params, access_token: token })
    let res
    try {
      res = await fetchImpl(`${baseUrl}/${pathname}?${query}`, { method: 'GET', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeout) })
    } catch {
      return fail('network')
    }
    let body
    try {
      body = await res.json()
    } catch {
      return fail('bad_response')
    }
    const status = Number(res.status) || 0
    if (status >= 200 && status < 300 && body && !body.error) return body
    const code = Number(body?.error?.code)
    const subcode = Number(body?.error?.error_subcode)
    return fail(status === 429 ? 'rate_limited' : errorKind(code), Number.isFinite(code) ? code : null, Number.isFinite(subcode) ? subcode : null)
  }

  async function findHashtagId(tag) {
    const body = await callGraph('ig_hashtag_search', { user_id: account, q: tag })
    if (!body) return null
    // 문서마다 응답 모양이 다르다: { data: [{ id }] } 또는 { id }
    const id = body.data?.[0]?.id ?? body.id
    return GRAPH_ID.test(String(id ?? '')) ? String(id) : fail('unavailable')
  }

  /** 인기 게시물 한 쪽(최대 50개)의 개수만 센다. paging.next는 토큰이 든 주소라 읽지도 따라가지도 않는다. */
  async function countTopMedia(hashtagId) {
    const body = await callGraph(`${hashtagId}/top_media`, { user_id: account, fields: MEDIA_FIELDS, limit: String(PAGE_LIMIT) })
    if (!body) return null
    return Array.isArray(body.data) ? Math.min(body.data.length, PAGE_LIMIT) : fail('bad_response')
  }

  /** 아직 칸을 차지하고 있는 조회 기록을 읽는다. 장부가 깨져 있으면 예외 — 얼마나 썼는지 모르는 채로 조회하지 않는다. */
  async function loadSlots(at) {
    let raw
    try {
      raw = await readFile(ledgerFile, 'utf8')
    } catch (err) {
      if (err.code === 'ENOENT') return []
      throw err
    }
    const saved = JSON.parse(raw)
    if (!Array.isArray(saved?.slots) || !saved.slots.every(isSlot)) throw new TypeError('해시태그 장부의 형식이 올바르지 않습니다.')
    return saved.slots.filter((slot) => at - slot.firstQueriedAt < WINDOW_MS + CLOCK_SKEW_MS)
  }

  const saveSlots = (slots) => writeJsonAtomic(ledgerFile, { version: 1, slots })

  /**
   * 이 태그가 쓸 칸을 돌려준다. 창 안에서 다시 묻는 것이면 있던 칸을 그대로 쓰고,
   * 처음이거나 창이 끝나 가면 새로 잡는다. 빈칸이 없으면 null.
   */
  function claimSlot(slots, tag, at) {
    const mine = slots.filter((slot) => slot.userId === account)
    const held = mine.find((slot) => slot.tag === tag)
    if (held && at - held.firstQueriedAt < WINDOW_MS - CLOCK_SKEW_MS) return held
    if (mine.length - (held ? 1 : 0) >= HASHTAG_LIMIT) return null
    if (held) slots.splice(slots.indexOf(held), 1)
    const slot = { userId: account, tag, hashtagId: held?.hashtagId ?? null, firstQueriedAt: at, checkedAt: null, mediaCount: null }
    slots.push(slot)
    return slot
  }

  const toResult = (slot) =>
    slot.mediaCount === null ? null : { tag: slot.tag, hashtagId: slot.hashtagId, mediaCount: slot.mediaCount, checkedAt: new Date(slot.checkedAt).toISOString() }

  /**
   * 장부를 잠근 채 칸을 잡고, 요청을 보내기 전에 적어 둔다(도중에 꺼지거나 요청이 실패해도 조회한 것으로 센다).
   * 서버와 수집 CLI가 같은 장부를 쓰므로, 잠그지 않으면 읽고 → 판단하고 → 쓰는 사이에 다른 쪽이 끼어들어 30칸을 넘길 수 있다.
   * @returns {Promise<{ slot: object, cached: boolean }|null>} 빈칸이 없으면 null
   */
  function reserve(tag, at) {
    return withFileLock(ledgerFile, async () => {
      const slots = await loadSlots(at)
      const slot = claimSlot(slots, tag, at)
      if (!slot) return null
      if (slot.checkedAt !== null && at - slot.checkedAt < RECHECK_MS) return { slot: { ...slot }, cached: true }
      slot.checkedAt = at
      slot.mediaCount = null
      await saveSlots(slots)
      return { slot: { ...slot }, cached: false }
    })
  }

  /** 조회 결과를 적는다. 그사이 다른 쪽이 적은 칸을 덮어 지우지 않도록, 장부를 다시 읽고 이 태그의 칸만 고친다. */
  function record(result) {
    return withFileLock(ledgerFile, async () => {
      const slots = await loadSlots(now())
      const index = slots.findIndex((slot) => slot.userId === account && slot.tag === result.tag)
      if (index === -1) slots.push(result)
      else slots[index] = { ...slots[index], hashtagId: result.hashtagId, checkedAt: result.checkedAt, mediaCount: result.mediaCount }
      await saveSlots(slots)
    })
  }

  async function check(raw) {
    const tag = normalizeTag(raw)
    const at = now()
    if (!tag || !configured || disabled || at < pausedUntil) return null
    const reserved = await reserve(tag, at)
    if (!reserved) return null
    const { slot, cached } = reserved
    if (cached) return toResult(slot)
    // 해시태그 ID는 바뀌지 않으므로 한 번 찾으면 다시 찾지 않는다
    slot.hashtagId ??= await findHashtagId(tag)
    if (slot.hashtagId) slot.mediaCount = await countTopMedia(slot.hashtagId)
    await record(slot)
    return toResult(slot)
  }

  return {
    /** 설정이 갖춰졌고, 토큰·권한 오류로 꺼지지 않았는지 */
    get enabled() {
      return configured && !disabled
    },

    /** 마지막 실패의 종류와 Graph 오류 코드(운영 상태 확인용). 주소·토큰·응답 문구는 들어 있지 않다. */
    get lastError() {
      return lastError
    },

    /**
     * 최근 7일 동안 조회한 서로 다른 해시태그 수.
     * @returns {Promise<{ used: number, limit: number, windowDays: number, remaining: number }>}
     */
    budget() {
      return exclusive(async () => {
        // 장부를 읽지 못하면 다 쓴 것으로 본다
        const used = configured ? await withFileLock(ledgerFile, () => loadSlots(now())).then((slots) => slots.filter((slot) => slot.userId === account).length, () => HASHTAG_LIMIT) : 0
        return { used, limit: HASHTAG_LIMIT, windowDays: WINDOW_DAYS, remaining: Math.max(0, HASHTAG_LIMIT - used) }
      })
    },

    /**
     * 해시태그의 인기 게시물이 몇 개 잡히는지 확인한다. 예외를 던지지 않는다.
     * @param {string} tag
     * @returns {Promise<{ tag: string, hashtagId: string, mediaCount: number, checkedAt: string }|null>}
     *   한도를 다 썼거나, 쓸 수 없는 태그이거나, 찾지 못했거나, API가 거절하면 null
     */
    checkHashtag(tag) {
      return exclusive(() => check(tag)).catch(() => fail('ledger'))
    },
  }
}
