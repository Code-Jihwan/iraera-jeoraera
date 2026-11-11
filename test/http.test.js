// HTTP 계층: 라우팅, 정적 파일, 보안 헤더, 호스트·출처 검사, 본문 크기, 요청 제한, 운영 API 보호
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createApp, HttpError } from '../server/http.js'

const quiet = { info() {}, warn() {}, error() {} }

let dir
let app
let base
let port

function makeConfig(overrides = {}) {
  return {
    port: 0,
    host: '127.0.0.1',
    allowedHosts: new Set(['localhost', '127.0.0.1', '[::1]', '::1']),
    allowAnyHost: false,
    adminToken: '',
    limits: { bodyBytes: 1024, generatePerMinute: 3, eventsPerMinute: 100 },
    ...overrides,
  }
}

function buildApp(config) {
  const a = createApp({ config, log: quiet })
  a.get('/api/ping', async () => ({ pong: true }))
  a.get('/api/items/:id', async (ctx) => ({ id: ctx.params.id, q: ctx.query.get('q') }))
  a.post('/api/echo', async (ctx) => ({ got: ctx.body }))
  a.post('/api/limited', async (ctx) => {
    ctx.limit('limited', 2)
    return { ok: true }
  })
  a.get('/api/boom', async () => {
    throw new Error('내부 비밀 정보')
  })
  a.get('/api/teapot', async () => {
    throw new HttpError(418, '차 주전자입니다.', 'teapot')
  })
  a.get('/api/admin', async (ctx) => {
    ctx.requireAdmin()
    return { admin: true }
  })
  a.static('/', dir)
  return a
}

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'http-test-'))
  await mkdir(path.join(dir, 'js'), { recursive: true })
  await writeFile(path.join(dir, 'index.html'), '<!doctype html><title>t</title>')
  await writeFile(path.join(dir, 'js', 'a.js'), 'export const a = 1\n')
  await writeFile(path.join(dir, '.secret'), 'x')
  await writeFile(path.join(dir, 'data.bin'), 'x')
  app = buildApp(makeConfig())
  const address = await app.listen(0, '127.0.0.1')
  port = address.port
  base = `http://127.0.0.1:${port}`
})

after(async () => {
  await app.close()
  await rm(dir, { recursive: true, force: true })
})

test('GET 라우트와 경로 변수, 쿼리', async () => {
  const res = await fetch(`${base}/api/items/abc?q=hi`)
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { id: 'abc', q: 'hi' })
})

test('보안 헤더가 모든 응답에 붙는다', async () => {
  const res = await fetch(`${base}/api/ping`)
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(res.headers.get('x-frame-options'), 'DENY')
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/)
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/)
  assert.match(res.headers.get('permissions-policy'), /microphone=\(self\)/)
  assert.equal(res.headers.get('cache-control'), 'no-store')
})

test('정적 파일: index, 콘텐츠 형식, ETag 재검증', async () => {
  const res = await fetch(`${base}/`)
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/html/)
  const js = await fetch(`${base}/js/a.js`)
  assert.match(js.headers.get('content-type'), /text\/javascript/)
  const etag = js.headers.get('etag')
  assert.ok(etag)
  const again = await fetch(`${base}/js/a.js`, { headers: { 'If-None-Match': etag } })
  assert.equal(again.status, 304)
})

test('정적 파일: 숨김 파일, 허용하지 않은 확장자, 상위 경로는 내주지 않는다', async () => {
  assert.equal((await fetch(`${base}/.secret`)).status, 404)
  assert.equal((await fetch(`${base}/data.bin`)).status, 404)
  assert.equal((await fetch(`${base}/js/%2e%2e/%2e%2e/etc/passwd`)).status, 404)
  assert.equal((await fetch(`${base}/..%2f..%2fpackage.json`)).status, 404)
  assert.equal((await fetch(`${base}/nope.html`)).status, 404)
})

test('없는 API는 JSON 404', async () => {
  const res = await fetch(`${base}/api/nope`)
  assert.equal(res.status, 404)
  assert.equal((await res.json()).error.code, 'not_found')
})

test('POST는 JSON 본문만 받는다', async () => {
  const ok = await fetch(`${base}/api/echo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ a: 1 }) })
  assert.deepEqual(await ok.json(), { got: { a: 1 } })
  const form = await fetch(`${base}/api/echo`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'a=1' })
  assert.equal(form.status, 415)
  const bad = await fetch(`${base}/api/echo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' })
  assert.equal(bad.status, 400)
  const arr = await fetch(`${base}/api/echo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '[1,2]' })
  assert.equal(arr.status, 400)
})

test('본문이 너무 크면 413', async () => {
  const res = await fetch(`${base}/api/echo`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ a: 'x'.repeat(5000) }) })
  assert.equal(res.status, 413)
})

test('다른 출처에서 온 POST는 막는다 (CSRF)', async () => {
  const headers = { 'Content-Type': 'application/json' }
  const evil = await fetch(`${base}/api/echo`, { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: '{}' })
  assert.equal(evil.status, 403)
  const crossSite = await fetch(`${base}/api/echo`, { method: 'POST', headers: { ...headers, 'Sec-Fetch-Site': 'cross-site' }, body: '{}' })
  assert.equal(crossSite.status, 403)
  const same = await fetch(`${base}/api/echo`, { method: 'POST', headers: { ...headers, Origin: base, 'Sec-Fetch-Site': 'same-origin' }, body: '{}' })
  assert.equal(same.status, 200)
})

test('허용하지 않은 Host 헤더는 거절한다 (DNS 리바인딩)', async () => {
  const http = await import('node:http')
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/ping', headers: { Host: 'attacker.example' } }, (res) => {
      res.resume()
      resolve(res.statusCode)
    })
    req.on('error', reject)
    req.end()
  })
  assert.equal(status, 421)
})

test('요청 제한을 넘으면 429와 Retry-After', async () => {
  const post = () => fetch(`${base}/api/limited`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal((await post()).status, 200)
  assert.equal((await post()).status, 200)
  const third = await post()
  assert.equal(third.status, 429)
  assert.ok(Number(third.headers.get('retry-after')) >= 1)
})

test('예상하지 못한 오류는 내용을 숨긴 500, HttpError는 그대로', async () => {
  const boom = await fetch(`${base}/api/boom`)
  assert.equal(boom.status, 500)
  const body = await boom.json()
  assert.equal(body.error.code, 'internal')
  assert.ok(!JSON.stringify(body).includes('내부 비밀 정보'))
  const teapot = await fetch(`${base}/api/teapot`)
  assert.equal(teapot.status, 418)
  assert.equal((await teapot.json()).error.code, 'teapot')
})

test('지원하지 않는 메서드는 405', async () => {
  const res = await fetch(`${base}/api/ping`, { method: 'DELETE' })
  assert.equal(res.status, 405)
})

test('운영 API: 토큰이 없으면 이 컴퓨터에서 온 요청만 허용', async () => {
  const res = await fetch(`${base}/api/admin`)
  assert.equal(res.status, 200)
})

test('운영 API: 같은 컴퓨터의 프록시를 거쳐 온 요청은 로컬로 보지 않는다', async () => {
  for (const headers of [{ 'X-Forwarded-For': '203.0.113.7' }, { Forwarded: 'for=203.0.113.7' }, { 'X-Real-IP': '203.0.113.7' }]) {
    const res = await fetch(`${base}/api/admin`, { headers })
    assert.equal(res.status, 403, JSON.stringify(headers))
  }
})

test('운영 API: 공개 호스트 이름으로 들어온 요청은 소켓이 로컬이어도 막는다', async () => {
  const pub = buildApp(makeConfig({ allowedHosts: new Set(['localhost', '127.0.0.1', '[::1]', '::1', 'demo.example.com']) }))
  const address = await pub.listen(0, '127.0.0.1')
  const http = await import('node:http')
  const get = (host) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: address.port, path: '/api/admin', headers: { Host: host } }, (res) => {
        res.resume()
        resolve(res.statusCode)
      })
      req.on('error', reject)
      req.end()
    })
  try {
    assert.equal(await get('demo.example.com'), 403)
    assert.equal(await get(`localhost:${address.port}`), 200)
  } finally {
    await pub.close()
  }
})

test('요청 제한: 시간 창을 따로 줄 수 있다(하루 한도)', async () => {
  const daily = createApp({ config: makeConfig(), log: quiet })
  daily.post('/api/daily', async (ctx) => {
    ctx.limit('daily', 1, 24 * 3600 * 1000, '오늘은 그만')
    return { ok: true }
  })
  const address = await daily.listen(0, '127.0.0.1')
  const post = () => fetch(`http://127.0.0.1:${address.port}/api/daily`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  try {
    assert.equal((await post()).status, 200)
    const second = await post()
    assert.equal(second.status, 429)
    assert.equal((await second.json()).error.message, '오늘은 그만')
    assert.ok(Number(second.headers.get('retry-after')) > 3600)
  } finally {
    await daily.close()
  }
})

test('운영 API: 토큰이 설정되면 토큰이 맞아야 한다', async () => {
  const secured = buildApp(makeConfig({ adminToken: 'test-token-123' }))
  const address = await secured.listen(0, '127.0.0.1')
  const url = `http://127.0.0.1:${address.port}/api/admin`
  try {
    assert.equal((await fetch(url)).status, 401)
    assert.equal((await fetch(url, { headers: { 'X-Admin-Token': 'wrong' } })).status, 401)
    assert.equal((await fetch(url, { headers: { 'X-Admin-Token': 'test-token-123' } })).status, 200)
  } finally {
    await secured.close()
  }
})
