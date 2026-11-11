// 파일 기반 저장소 도우미. MVP는 DB 대신 data/ 아래 JSON·JSONL 파일을 쓴다.
import { mkdir, readFile, rename, writeFile, appendFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

const queues = new Map()

/** 같은 파일에 대한 쓰기를 한 줄로 세운다. */
function enqueue(file, task) {
  const prev = queues.get(file) || Promise.resolve()
  const next = prev.then(task, task)
  queues.set(file, next.catch(() => {}))
  return next
}

export async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (err) {
    if (err.code === 'ENOENT') return fallback
    if (err instanceof SyntaxError) {
      console.warn(`[store] ${path.basename(file)} 내용이 깨져 있어 기본값으로 시작합니다.`)
      return fallback
    }
    throw err
  }
}

/** 임시 파일에 쓰고 이름을 바꿔, 쓰는 도중에 꺼져도 파일이 깨지지 않게 한다. */
export function writeJsonAtomic(file, data) {
  return enqueue(file, async () => {
    await mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
    try {
      await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
      await rename(tmp, file)
    } catch (err) {
      await unlink(tmp).catch(() => {})
      throw err
    }
  })
}

export function appendJsonl(file, obj) {
  return enqueue(file, async () => {
    await mkdir(path.dirname(file), { recursive: true })
    await appendFile(file, JSON.stringify(obj) + '\n', 'utf8')
  })
}

/** JSONL 파일을 읽는다. 깨진 줄은 건너뛴다. */
export async function readJsonl(file, { limit = Infinity } = {}) {
  let raw
  try {
    raw = await readFile(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return []
    throw err
  }
  const out = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // 깨진 줄은 무시
    }
  }
  return Number.isFinite(limit) && out.length > limit ? out.slice(out.length - limit) : out
}

/**
 * JSONL 파일에서 keep이 true인 줄만 남긴다. 덧붙이기와 같은 줄에 세워, 고르는 사이에 들어온 줄을 잃지 않는다.
 * @returns {Promise<{kept:number, removed:number}>}
 */
export function rewriteJsonl(file, keep) {
  return enqueue(file, async () => {
    let raw
    try {
      raw = await readFile(file, 'utf8')
    } catch (err) {
      if (err.code === 'ENOENT') return { kept: 0, removed: 0 }
      throw err
    }
    const lines = raw.split('\n').filter((l) => l.trim())
    const kept = []
    for (const line of lines) {
      let row
      try {
        row = JSON.parse(line)
      } catch {
        continue
      }
      if (keep(row)) kept.push(line)
    }
    if (kept.length === lines.length) return { kept: kept.length, removed: 0 }
    const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
    try {
      await writeFile(tmp, kept.length ? kept.join('\n') + '\n' : '', 'utf8')
      await rename(tmp, file)
    } catch (err) {
      await unlink(tmp).catch(() => {})
      throw err
    }
    return { kept: kept.length, removed: lines.length - kept.length }
  })
}

/** 대기 중인 쓰기가 끝날 때까지 기다린다(테스트·종료용). */
export async function flushWrites() {
  await Promise.all([...queues.values()])
}
