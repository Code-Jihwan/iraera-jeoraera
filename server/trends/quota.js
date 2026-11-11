// YouTube Data API 할당량 장부.
// 실패한 요청도 1단위 이상 차감되므로, 요청을 보내기 전에 여기에서 먼저 센다.
import { mkdir, open, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { readJson, writeJsonAtomic } from '../store.js'

// 일일 할당량은 태평양 시간(PT) 자정에 초기화된다. 서머타임이 있어 고정 시차로 계산하면 틀린다.
const QUOTA_TIME_ZONE = 'America/Los_Angeles'

const NO_CHART_KEYS_MAX = 200

// 장부 잠금: 서버와 수집 CLI(npm run collect)가 같은 장부 파일을 함께 쓰므로, 읽고 → 고치고 → 쓰는 동안 파일을 잠근다.
// 잠금을 쥔 채 꺼진 프로세스가 남긴 잠금은 이만큼 지나면 치운다. 잠금 안에서는 파일만 다루므로 이보다 훨씬 짧게 끝난다.
const LOCK_STALE_MS = 30_000
const LOCK_WAIT_MS = 15_000
const LOCK_RETRY_MS = 20

const lockQueues = new Map()

async function acquireLock(lockFile) {
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      await (await open(lockFile, 'wx')).close()
      return
    } catch (err) {
      // Windows에서는 지워지는 중인 잠금 파일을 열려고 하면 EPERM이 난다
      if (err.code !== 'EEXIST' && err.code !== 'EPERM') throw err
    }
    const info = await stat(lockFile).catch(() => null)
    if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) {
      await unlink(lockFile).catch(() => {})
      continue
    }
    if (Date.now() > deadline) throw new Error('장부 파일이 너무 오래 잠겨 있습니다.')
    await delay(LOCK_RETRY_MS)
  }
}

/**
 * 장부 파일을 잠근 채 task를 돌린다. 같은 프로세스 안에서는 차례를 세우고, 다른 프로세스와는 잠금 파일(<file>.lock)로 겨룬다.
 * task 안에서는 파일만 다룬다(네트워크 요청을 기다리지 않는다).
 * @template T
 * @param {string} file
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
export function withFileLock(file, task) {
  if (typeof file !== 'string' || !file) throw new TypeError('잠글 파일 경로가 필요합니다.')
  if (typeof task !== 'function') throw new TypeError('task는 함수여야 합니다.')
  const key = path.resolve(file)
  const run = (lockQueues.get(key) ?? Promise.resolve()).then(async () => {
    const lockFile = `${key}.lock`
    await mkdir(path.dirname(key), { recursive: true })
    await acquireLock(lockFile)
    try {
      return await task()
    } finally {
      await unlink(lockFile).catch(() => {})
    }
  })
  const tail = run.then(
    () => {},
    () => {},
  )
  lockQueues.set(key, tail)
  tail.then(() => {
    if (lockQueues.get(key) === tail) lockQueues.delete(key)
  })
  return run
}

const dayFormat = new Intl.DateTimeFormat('en-US', { timeZone: QUOTA_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' })

/**
 * 그 시각이 속한 할당량 날짜.
 * @param {number} ms 밀리초 시각
 * @returns {string} 태평양 시간 기준 YYYY-MM-DD
 */
export function quotaDay(ms) {
  if (typeof ms !== 'number' || Number.isNaN(new Date(ms).getTime())) throw new TypeError('시각은 밀리초 숫자여야 합니다.')
  const parts = Object.fromEntries(dayFormat.formatToParts(ms).map((part) => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

const isUnits = (value) => Number.isInteger(value) && value >= 0
const emptyDay = (day) => ({ day, used: 0, noChart: new Set() })

/**
 * @param {{ file: string, dailyBudget: number, now?: () => number }} opts
 */
export function createQuotaLedger({ file, dailyBudget, now = () => Date.now() } = {}) {
  if (typeof file !== 'string' || !file) throw new TypeError('할당량 장부 파일 경로(file)가 필요합니다.')
  if (!Number.isInteger(dailyBudget) || dailyBudget < 1) throw new TypeError('dailyBudget은 1 이상의 정수여야 합니다.')

  let state = emptyDay(quotaDay(now()))

  /** 오늘 장을 돌려준다. 할당량 날짜가 바뀌었으면 새 장으로 넘긴다. */
  function today() {
    const day = quotaDay(now())
    if (state.day !== day) state = emptyDay(day)
    return state
  }

  /** 파일에 적힌 오늘 기록을 메모리 장부에 합친다. 다른 프로세스가 쓴 만큼도 세도록 큰 쪽을 따른다. */
  async function mergeSaved() {
    const saved = await readJson(file, null)
    const current = today()
    if (saved?.day !== current.day) return current
    if (isUnits(saved.used)) current.used = Math.max(current.used, saved.used)
    const keys = Array.isArray(saved.noChart) ? saved.noChart.filter((key) => typeof key === 'string') : []
    for (const key of keys) {
      if (current.noChart.size >= NO_CHART_KEYS_MAX) break
      current.noChart.add(key)
    }
    return current
  }

  /**
   * 잠근 채 파일을 다시 읽어 합치고, change를 적용한 뒤 쓴다.
   * 읽은 뒤 따로 더해 덮어쓰면 다른 프로세스가 그사이 쓴 단위를 잃기 때문이다.
   */
  function update(change) {
    return withFileLock(file, async () => {
      const current = await mergeSaved()
      const result = change(current)
      if (result?.write !== false) await writeJsonAtomic(file, { day: current.day, used: current.used, noChart: [...current.noChart] })
      return result?.value
    })
  }

  return {
    /** 저장된 장부를 읽어 지금 상태와 합친다. 다른 프로세스(수집 CLI)가 쓴 만큼도 반영되도록 요청 전에 다시 불러도 된다. */
    async load() {
      await withFileLock(file, mergeSaved)
    },

    /** 오늘 예산 안에서 units만큼 더 쓸 수 있는지(메모리 장부 기준. 요청 직전에는 trySpend를 쓴다) */
    canSpend(units = 1) {
      return isUnits(units) && today().used + units <= dailyBudget
    },

    /** 쓴 만큼 적는다. 예산을 넘는지는 canSpend로 먼저 확인한다. */
    async spend(units = 1) {
      if (!isUnits(units)) throw new TypeError('units는 0 이상의 정수여야 합니다.')
      await update((current) => {
        current.used += units
      })
    },

    /**
     * 파일을 잠근 채 예산을 확인하고, 남아 있으면 그 자리에서 적는다.
     * 확인과 기록 사이에 다른 프로세스가 끼어들어 예산을 넘기는 일을 막는다.
     * @returns {Promise<boolean>} 적었으면 true, 예산이 모자라면 false
     */
    async trySpend(units = 1) {
      if (!isUnits(units)) throw new TypeError('units는 0 이상의 정수여야 합니다.')
      return update((current) => {
        if (current.used + units > dailyBudget) return { write: false, value: false }
        current.used += units
        return { value: true }
      })
    },

    /** API가 할당량 소진을 알려 왔을 때: 다음 초기화까지 요청을 더 보내지 않도록 오늘 예산을 다 쓴 것으로 적는다. */
    async markExhausted() {
      await update((current) => {
        current.used = Math.max(current.used, dailyBudget)
      })
    },

    /** 오늘 이 차트(예: 'KR:23')가 없다고 확인했는지 */
    hasNoChart(key) {
      return today().noChart.has(key)
    },

    /** 차트가 없는 분류를 오늘 하루 기억한다. 물어볼 때마다 할당량이 들기 때문이다. */
    async markNoChart(key) {
      if (typeof key !== 'string' || !key) throw new TypeError('차트 이름(key)은 비어 있지 않은 문자열이어야 합니다.')
      await update((current) => {
        if (current.noChart.has(key) || current.noChart.size >= NO_CHART_KEYS_MAX) return { write: false }
        current.noChart.add(key)
      })
    },

    /** @returns {{ day: string, used: number, budget: number }} */
    status() {
      const { day, used } = today()
      return { day, used, budget: dailyBudget }
    },
  }
}
