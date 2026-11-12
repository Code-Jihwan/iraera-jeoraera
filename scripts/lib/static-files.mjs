// 정적 배포 빌드와 미리 보기 서버가 함께 쓰는 파일 도구.
import { realpathSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 이 모듈(metaUrl)이 `node <파일>`로 직접 실행됐는지.
 * 저장소를 심볼릭 링크·정션으로 거쳐 실행해도 알아보도록 양쪽 모두 실제 경로로 견준다(Windows·macOS는 대소문자 무시).
 * @param {string} metaUrl import.meta.url
 */
export function isMainModule(metaUrl) {
  if (!process.argv[1]) return false
  const real = (p) => {
    let resolved
    try {
      resolved = realpathSync.native(p)
    } catch {
      resolved = path.resolve(p)
    }
    return process.platform === 'win32' || process.platform === 'darwin' ? resolved.toLowerCase() : resolved
  }
  return real(fileURLToPath(metaUrl)) === real(path.resolve(process.argv[1]))
}

/** 미리 보기 서버가 내줄 수 있는 확장자와 Content-Type */
export const CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
})

/**
 * root 아래 상대 경로(rel, '/'로 구분)가 대소문자까지 똑같은 이름으로 있는 파일인지.
 * Windows·macOS는 대소문자를 가리지 않지만 GitHub Actions(Linux)와 GitHub Pages는 가리므로, existsSync 대신 폴더 목록과 견준다.
 * @param {string} root
 * @param {string} rel
 * @param {Map<string, Set<string>|null>} [cache] 폴더 목록 캐시
 */
export async function existsExact(root, rel, cache = new Map()) {
  const parts = rel.split('/').filter((part) => part !== '' && part !== '.')
  if (!parts.length || parts.some((part) => part === '..')) return false
  let dir = root
  for (const part of parts) {
    if (!cache.has(dir)) {
      try {
        cache.set(dir, new Set(await readdir(dir)))
      } catch {
        cache.set(dir, null)
      }
    }
    const names = cache.get(dir)
    if (!names || !names.has(part)) return false
    dir = path.join(dir, part)
  }
  try {
    return (await stat(dir)).isFile()
  } catch {
    return false
  }
}

/** 폴더 안의 모든 파일을 root 기준 상대 경로('/' 구분)로 돌려준다. */
export async function listFiles(root) {
  const out = []
  async function walk(dir, prefix) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel)
      else if (entry.isFile()) out.push(rel)
    }
  }
  await walk(root, '')
  return out.sort()
}
