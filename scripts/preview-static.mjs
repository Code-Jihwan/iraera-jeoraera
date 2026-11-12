// 정적 빌드 미리 보기: GitHub 프로젝트 사이트(https://<계정>.github.io/<저장소>/)처럼 하위 경로 아래에 결과물을 띄운다.
// 실행: npm run build:static && npm run preview:static  →  http://127.0.0.1:4173/preview/
// 환경변수: PORT(기본 4173, 0이면 빈 포트), BASE(기본 /preview/), DIR(기본 dist), HOST(기본 127.0.0.1)
import http from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CONTENT_TYPES, existsExact, isMainModule } from './lib/static-files.mjs'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

/** '/preview' · 'preview/' · '/' 같은 입력을 '/…/' 꼴로 맞춘다. */
export function normalizeBase(base = '/preview/') {
  const trimmed = String(base).trim().replace(/^\/+|\/+$/g, '')
  if (!/^[A-Za-z0-9._~\-/]*$/.test(trimmed) || trimmed.split('/').some((seg) => seg === '.' || seg === '..')) throw new Error(`BASE에 쓸 수 없는 경로예요: ${base}`)
  return trimmed ? `/${trimmed}/` : '/'
}

/**
 * 요청 경로를 결과물 폴더 안의 상대 경로로 바꾼다. 쓸 수 없는 경로면 null.
 * 상위 경로(.. · %2e%2e), 역슬래시, NUL, 숨김 파일(.으로 시작)은 받지 않는다.
 */
export function resolveRequestPath(rawUrl, base) {
  const raw = String(rawUrl || '/')
  // 주소 해석기가 ..를 접어 버리기 전에 원문에서 먼저 거른다
  if (/\\|%5c|%00|\0/i.test(raw)) return null
  const pathname = raw.split(/[?#]/)[0]
  if (!pathname.startsWith(base)) return null
  const segments = pathname.slice(base.length).split('/')
  const decoded = []
  for (const segment of segments) {
    let part
    try {
      part = decodeURIComponent(segment)
    } catch {
      return null
    }
    if (part.includes('/') || part.includes('\\') || part.includes('\0')) return null
    if (part === '.' || part === '..' || part.startsWith('.')) return null
    decoded.push(part)
  }
  // 빈 칸은 맨 끝(폴더 주소)에만 허용한다
  if (decoded.slice(0, -1).some((part) => part === '')) return null
  const rel = decoded.join('/')
  return rel === '' || rel.endsWith('/') ? `${rel}index.html` : rel
}

/**
 * @param {{ dir: string, base?: string }} opts
 */
export function createPreviewServer({ dir, base = '/preview/' }) {
  const root = path.resolve(dir)
  const prefix = normalizeBase(base)
  const notFound = (res) => {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end('찾을 수 없어요.')
  }

  return http.createServer(async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('지원하지 않는 메서드예요.')
        return
      }
      const pathname = String(req.url || '/').split(/[?#]/)[0]
      // 첫 화면과 끝 빗금이 빠진 하위 경로는 하위 경로 첫 화면으로 보낸다
      if (prefix !== '/' && (pathname === '/' || pathname === prefix.slice(0, -1))) {
        res.writeHead(302, { Location: prefix })
        res.end()
        return
      }
      const rel = resolveRequestPath(req.url, prefix)
      const type = rel ? CONTENT_TYPES[path.posix.extname(rel).toLowerCase()] : null
      // GitHub Pages(Linux)처럼 대소문자를 가린다. 폴더 목록은 보여 주지 않는다.
      if (!rel || !type || !(await existsExact(root, rel))) return notFound(res)
      const file = path.join(root, ...rel.split('/'))
      const info = await stat(file)
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': info.size, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' })
      if (req.method === 'HEAD') return res.end()
      createReadStream(file)
        .on('error', () => res.destroy())
        .pipe(res)
    } catch {
      if (!res.headersSent) notFound(res)
      else res.destroy()
    }
  })
}

if (isMainModule(import.meta.url)) {
  const dir = path.resolve(process.env.DIR || path.join(ROOT, 'dist'))
  const base = normalizeBase(process.env.BASE || '/preview/')
  const host = process.env.HOST || '127.0.0.1'
  const port = process.env.PORT === undefined || process.env.PORT === '' ? 4173 : Number(process.env.PORT)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`PORT가 올바르지 않아요: ${process.env.PORT}`)
    process.exit(1)
  }
  try {
    if (!(await stat(dir)).isDirectory()) throw new Error()
  } catch {
    console.error(`미리 볼 폴더가 없어요: ${dir}\n먼저 npm run build:static으로 만들어 주세요.`)
    process.exit(1)
  }
  const server = createPreviewServer({ dir, base })
  server.on('error', (err) => {
    console.error(err.code === 'EADDRINUSE' ? `포트 ${port}가 이미 쓰이고 있어요. PORT 환경변수로 다른 포트를 지정하세요.` : err)
    process.exit(1)
  })
  server.listen(port, host, () => {
    const { port: actual } = server.address()
    const shown = host.includes(':') ? `[${host}]` : host
    console.log(`정적 빌드 미리 보기: http://${shown}:${actual}${base}  (폴더 ${dir})`)
  })
  const stop = () => server.close(() => process.exit(0))
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}
