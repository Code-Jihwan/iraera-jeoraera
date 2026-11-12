// 의존성 없는 작은 HTTP 계층: 라우팅, 정적 파일, JSON 본문, 보안 헤더, 요청 제한.
import http from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { timingSafeEqual, createHash } from 'node:crypto'
import { API_ERRORS } from '../shared/api-messages.js'

export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message 사용자에게 보여도 되는 메시지
   * @param {string} [code]
   */
  constructor(status, message, code) {
    super(message)
    this.status = status
    this.code = code || 'error'
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
}

/** 콘텐츠 보안 정책. 정적 배포 빌드(scripts/build-static.mjs)도 이 목록으로 <meta> 정책을 만든다. */
export const CSP_DIRECTIVES = Object.freeze([
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "media-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
])

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  // 마이크는 같은 출처에서만. 카메라·위치 등은 쓰지 않는다.
  'Permissions-Policy': 'microphone=(self), camera=(), geolocation=(), payment=(), usb=()',
  'Content-Security-Policy': CSP_DIRECTIVES.join('; '),
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])

/** 손님 주소. 프록시를 믿기로 했고 실제로 로컬 프록시를 거쳐 왔을 때만 X-Forwarded-For의 첫 주소를 쓴다. */
function clientAddress(req, socketIp, trustProxy) {
  if (!trustProxy || !LOOPBACK.has(socketIp)) return socketIp
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()
  return xff && xff.length <= 64 && /^[0-9a-fA-F:.]+$/.test(xff) ? xff : socketIp
}

/** 요청 제한 열쇠: IPv6는 한 사람이 /64를 통째로 받는 경우가 많아 /64로 묶는다. */
function rateKey(ip) {
  const s = String(ip || '')
  if (s.startsWith('::ffff:')) return s.slice(7)
  if (!s.includes(':')) return s
  // 생략형(::)을 펼쳐 앞의 네 묶음만 쓴다
  const [head, tail = ''] = s.split('::')
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const full = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right]
  return `${full.slice(0, 4).map((x) => x.toLowerCase().replace(/^0+(?=.)/, '')).join(':')}::/64`
}

function hostnameOf(hostHeader) {
  const h = String(hostHeader || '').trim().toLowerCase()
  if (!h) return ''
  if (h.startsWith('[')) {
    const end = h.indexOf(']')
    return end === -1 ? h : h.slice(0, end + 1)
  }
  const colon = h.lastIndexOf(':')
  return colon === -1 ? h : h.slice(0, colon)
}

function safeEqual(a, b) {
  const ha = createHash('sha256').update(String(a)).digest()
  const hb = createHash('sha256').update(String(b)).digest()
  return timingSafeEqual(ha, hb)
}

/** 고정 창 요청 제한기 */
export function createRateLimiter() {
  const buckets = new Map()
  const timer = setInterval(() => {
    const now = Date.now()
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k)
  }, 60_000)
  timer.unref?.()
  return {
    /** @returns {{ok:boolean, retryAfterSec:number}} */
    check(key, limit, windowMs = 60_000) {
      const now = Date.now()
      let b = buckets.get(key)
      if (!b || b.resetAt <= now) {
        b = { count: 0, resetAt: now + windowMs }
        buckets.set(key, b)
      }
      b.count++
      if (b.count > limit) return { ok: false, retryAfterSec: Math.max(1, Math.ceil((b.resetAt - now) / 1000)) }
      return { ok: true, retryAfterSec: 0 }
    },
    stop() {
      clearInterval(timer)
    },
  }
}

function compilePath(pattern) {
  const keys = []
  const source = pattern
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        keys.push(seg.slice(1))
        return '([^/]+)'
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    })
    .join('/')
  return { regex: new RegExp(`^${source}/?$`), keys }
}

/**
 * @param {{ config: any, log?: {info:Function, warn:Function, error:Function} }} deps
 */
export function createApp({ config, log = console }) {
  const routes = []
  const statics = []
  const limiter = createRateLimiter()

  function addRoute(method, pattern, handler) {
    routes.push({ method, ...compilePath(pattern), handler })
  }

  /**
   * 정적 폴더를 URL 접두사에 연결한다.
   * @param {string} prefix 예: '/shared/'
   * @param {string} dir 절대 경로
   * @param {{ immutable?: boolean, extensions?: string[], index?: string }} [opts]
   */
  function mountStatic(prefix, dir, opts = {}) {
    statics.push({ prefix, dir: path.resolve(dir), opts })
    // 더 구체적인 접두사가 먼저 걸리도록
    statics.sort((a, b) => b.prefix.length - a.prefix.length)
  }

  function sendJson(res, status, obj, extraHeaders = {}) {
    const body = JSON.stringify(obj)
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      ...extraHeaders,
    })
    res.end(body)
  }

  function readBody(req, maxBytes) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      let done = false
      req.on('data', (chunk) => {
        if (done) return
        size += chunk.length
        if (size > maxBytes) {
          done = true
          reject(new HttpError(413, '요청이 너무 큽니다.', 'payload_too_large'))
          req.resume()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        if (done) return
        done = true
        resolve(Buffer.concat(chunks).toString('utf8'))
      })
      req.on('error', (err) => {
        if (done) return
        done = true
        reject(err)
      })
    })
  }

  async function serveStatic(req, res, pathname) {
    for (const { prefix, dir, opts } of statics) {
      if (!pathname.startsWith(prefix)) continue
      let rel = pathname.slice(prefix.length)
      if (rel === '' || rel.endsWith('/')) rel += opts.index || 'index.html'
      // 숨김 파일·상위 경로 차단
      if (rel.split('/').some((seg) => seg === '..' || seg.startsWith('.'))) return false
      const file = path.resolve(dir, rel)
      if (file !== dir && !file.startsWith(dir + path.sep)) return false
      const ext = path.extname(file).toLowerCase()
      if (!MIME[ext]) return false
      if (opts.extensions && !opts.extensions.includes(ext)) return false
      let info
      try {
        info = await stat(file)
      } catch {
        continue
      }
      if (!info.isFile()) continue
      const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`
      const headers = {
        'Content-Type': MIME[ext],
        ETag: etag,
        'Cache-Control': opts.immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      }
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, headers)
        res.end()
        return true
      }
      headers['Content-Length'] = info.size
      res.writeHead(200, headers)
      if (req.method === 'HEAD') {
        res.end()
        return true
      }
      await new Promise((resolve) => {
        const stream = createReadStream(file)
        stream.on('error', () => {
          res.destroy()
          resolve()
        })
        stream.on('end', resolve)
        res.on('close', resolve)
        stream.pipe(res)
      })
      return true
    }
    return false
  }

  async function handle(req, res) {
    const started = Date.now()
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v)

    let pathname = '/'
    let isApi = false
    try {
      // DNS 리바인딩 방지: 허용한 호스트 이름으로 온 요청만 받는다
      const hostname = hostnameOf(req.headers.host)
      if (!config.allowAnyHost && !config.allowedHosts.has(hostname)) {
        throw new HttpError(421, '허용되지 않은 호스트입니다. PUBLIC_HOSTS 환경변수를 확인하세요.', 'bad_host')
      }

      const url = new URL(req.url || '/', 'http://local')
      try {
        pathname = decodeURIComponent(url.pathname)
      } catch {
        throw new HttpError(400, '잘못된 주소입니다.', 'bad_path')
      }
      if (pathname.includes('\0')) throw new HttpError(400, '잘못된 주소입니다.', 'bad_path')
      isApi = pathname.startsWith('/api/')

      const method = req.method || 'GET'
      if (!['GET', 'HEAD', 'POST'].includes(method)) throw new HttpError(405, '지원하지 않는 메서드입니다.', 'method_not_allowed')

      const socketIp = req.socket.remoteAddress || ''
      const forwarded = Boolean(req.headers['x-forwarded-for'] || req.headers.forwarded || req.headers['x-real-ip'])
      // 같은 컴퓨터의 프록시를 거쳐 온 요청도 소켓 주소는 127.0.0.1이다.
      // 그래서 ‘이 컴퓨터에서 직접 연 요청’은 소켓·호스트 이름이 모두 로컬이고 전달 헤더가 없을 때만으로 본다.
      const isLocal = LOOPBACK.has(socketIp) && LOCAL_HOSTNAMES.has(hostname) && !forwarded
      const ip = clientAddress(req, socketIp, config.trustProxy)

      if (isApi) {
        const route = routes.find((r) => r.method === (method === 'HEAD' ? 'GET' : method) && r.regex.test(pathname))
        if (!route) throw new HttpError(404, '없는 API입니다.', 'not_found')

        let body = null
        if (method === 'POST') {
          // 다른 사이트에서 보낸 요청(CSRF) 차단: JSON 본문 + 같은 출처만 허용
          const ctype = String(req.headers['content-type'] || '').toLowerCase()
          if (!ctype.startsWith('application/json')) throw new HttpError(415, 'Content-Type은 application/json이어야 합니다.', 'bad_content_type')
          const fetchSite = req.headers['sec-fetch-site']
          if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') throw new HttpError(403, '다른 출처의 요청은 받지 않습니다.', 'cross_site')
          const origin = req.headers.origin
          if (origin) {
            let originHost = ''
            try {
              originHost = new URL(origin).host.toLowerCase()
            } catch {
              originHost = ''
            }
            if (originHost !== String(req.headers.host || '').toLowerCase()) throw new HttpError(403, '다른 출처의 요청은 받지 않습니다.', 'cross_site')
          }
          const raw = await readBody(req, config.limits.bodyBytes)
          try {
            body = raw ? JSON.parse(raw) : {}
          } catch {
            throw new HttpError(400, 'JSON 형식이 아닙니다.', 'bad_json')
          }
          if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(API_ERRORS.badJsonObject.status, API_ERRORS.badJsonObject.message, API_ERRORS.badJsonObject.code)
        }

        const m = route.regex.exec(pathname)
        const params = {}
        route.keys.forEach((k, i) => {
          params[k] = m[i + 1]
        })

        const ctx = {
          req,
          res,
          method,
          pathname,
          params,
          query: url.searchParams,
          body,
          ip,
          isLocal,
          /** 요청 제한(기본 1분 창). 넘으면 429를 던진다. IPv6는 /64 단위로 묶어 센다. */
          limit(name, max, windowMs = 60_000, message = null) {
            const r = limiter.check(`${name}:${rateKey(ip)}`, max, windowMs)
            if (!r.ok) {
              res.setHeader('Retry-After', String(r.retryAfterSec))
              throw new HttpError(429, message || `요청이 너무 잦습니다. ${r.retryAfterSec}초 뒤에 다시 시도해 주세요.`, 'rate_limited')
            }
          },
          /** 운영 API 보호: ADMIN_TOKEN이 있으면 토큰, 없으면 이 컴퓨터에서 온 요청만 */
          requireAdmin() {
            if (config.adminToken) {
              const given = req.headers['x-admin-token']
              if (!given || Array.isArray(given) || !safeEqual(given, config.adminToken)) {
                throw new HttpError(401, '운영 토큰이 필요합니다.', 'admin_token_required')
              }
              return
            }
            if (!isLocal) throw new HttpError(403, '운영 화면은 서버를 띄운 컴퓨터에서만 열 수 있습니다. 원격에서 쓰려면 ADMIN_TOKEN을 설정하세요.', 'admin_local_only')
          },
        }

        const result = await route.handler(ctx)
        if (!res.writableEnded) sendJson(res, 200, result ?? { ok: true })
        return
      }

      if (method === 'POST') throw new HttpError(405, '지원하지 않는 메서드입니다.', 'method_not_allowed')
      const served = await serveStatic(req, res, pathname)
      if (!served) throw new HttpError(404, '페이지를 찾을 수 없습니다.', 'not_found')
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500
      if (!(err instanceof HttpError)) log.error(`[http] ${req.method} ${pathname} 처리 중 오류:`, err)
      if (res.headersSent) {
        res.destroy()
      } else if (isApi || status !== 404) {
        sendJson(res, status, {
          error: {
            code: err instanceof HttpError ? err.code : 'internal',
            message: err instanceof HttpError ? err.message : '서버에서 문제가 생겼습니다. 잠시 뒤 다시 시도해 주세요.',
          },
        })
      } else {
        const body = '페이지를 찾을 수 없습니다.'
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' })
        res.end(body)
      }
    } finally {
      if (isApi) log.info(`[http] ${req.method} ${pathname} ${res.statusCode} ${Date.now() - started}ms`)
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      log.error('[http] 처리되지 않은 오류:', err)
      if (!res.headersSent) res.writeHead(500)
      res.end()
    })
  })
  server.requestTimeout = 120_000
  server.headersTimeout = 30_000

  return {
    get: (pattern, handler) => addRoute('GET', pattern, handler),
    post: (pattern, handler) => addRoute('POST', pattern, handler),
    static: mountStatic,
    handle,
    server,
    listen(port = config.port, host = config.host) {
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
          server.off('error', reject)
          resolve(server.address())
        })
      })
    },
    close() {
      limiter.stop()
      return new Promise((resolve) => server.close(() => resolve()))
    },
  }
}
