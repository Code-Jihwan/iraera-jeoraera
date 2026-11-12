// 정적 배포(GitHub Pages) 빌드와 브라우저 안 백엔드: 임시 폴더에 빌드한 결과물을 그대로 불러 검사한다.
// 결과물이 서버 없이 같은 모양의 응답을 내고, 서버와 같은 오류 문구를 쓰며, 서버 전용 파일을 싣지 않는지 본다.
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { BuildError, STATIC_CSP, assertSafeOutDir, buildStatic, cssUrls, validateStatic } from '../scripts/build-static.mjs'
import { scanModuleSpecifiers } from '../scripts/lib/module-scan.mjs'
import { existsExact, listFiles } from '../scripts/lib/static-files.mjs'
import { buildServer } from '../server/main.js'
import { analyzeStyle, splitUtterances, profileToPayload } from '../shared/style-analyzer.js'
import { API_ERRORS, blockedInputError, blockedTrendError } from '../shared/api-messages.js'
import { CONSENT_VERSION, DEFAULT_SERVICE_NAME, LIMITS } from '../shared/constants.js'
import { SAMPLE_PERSONAS } from '../public/js/samples.js'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const quiet = { info() {}, warn() {}, error() {}, log() {} }
const json = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
const payloadFor = (persona) => profileToPayload(analyzeStyle({ textUtterances: splitUtterances(persona.text), sample: true }))
const BAD_WORD = '씨발'
const FAKE_SHA = 'abcdef0123456789abcdef0123456789abcdef01'

let tmp
let out
let built
let server
let base
let mod
let ApiError
let fetchCalls

/** 결과물의 trends.json을 파일에서 읽어 주는 가짜 fetch. 부른 주소를 모두 남긴다. */
function fileFetch(calls) {
  return async (url) => {
    calls.push(String(url))
    const text = await readFile(fileURLToPath(String(url)), 'utf8')
    return { ok: true, status: 200, json: async () => JSON.parse(text) }
  }
}

const importBuilt = (rel) => import(pathToFileURL(path.join(out, ...rel.split('/'))).href)

before(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'static-build-test-'))
  out = path.join(tmp, 'site')
  built = await buildStatic({ outDir: out, root: ROOT, env: { GITHUB_SHA: FAKE_SHA } })
  mod = await importBuilt('js/static-backend.js')
  ApiError = (await importBuilt('js/api-error.js')).ApiError
  fetchCalls = []

  server = await buildServer({
    env: { DATA_DIR: path.join(tmp, 'data'), PORT: '0', HOST: '127.0.0.1', LLM_MODE: 'off', GENERATE_RATE_LIMIT_PER_MIN: '10000', GENERATE_DAILY_LIMIT_PER_CLIENT: '10000', EVENTS_RATE_LIMIT_PER_MIN: '10000' },
    loadDotEnv: false,
    log: quiet,
  })
  const address = await server.start()
  base = `http://127.0.0.1:${address.port}`
})

after(async () => {
  await server?.stop()
  if (tmp) await rm(tmp, { recursive: true, force: true })
})

describe('정적 빌드 결과물', () => {
  test('꼭 있어야 하는 파일이 있다', async () => {
    const files = await listFiles(out)
    for (const rel of ['index.html', '.nojekyll', 'favicon.svg', 'css/app.css', 'js/main.js', 'js/api.js', 'js/runtime.js', 'js/static-backend.js', 'js/views/register.js', 'shared/constants.js', 'shared/crypto-lite.js', 'shared/api-messages.js', 'engine/generate/engine.js', 'engine/generate/llm-error.js', 'engine/generate/local-engine.js', 'engine/safety/filter.js', 'engine/safety/lexicon.js', 'data/trends.json']) {
      assert.ok(files.includes(rel), rel)
    }
    assert.equal(built.files, files.length)
    assert.ok(built.bytes > 0)
  })

  test('서버 전용 파일은 싣지 않는다', async () => {
    const files = await listFiles(out)
    const names = files.map((rel) => rel.split('/').at(-1))
    for (const name of ['llm.js', 'config.js', 'http.js', 'events.js', 'pipeline.js', 'youtube.js', 'instagram.js', 'quota.js', 'extract.js', 'extract-llm.js', 'trend-store.js', 'ops.html', 'ops.js', 'server.js', 'package.json', 'seed-trends.json']) {
      assert.ok(!names.includes(name), name)
    }
    assert.ok(!files.some((rel) => rel.startsWith('engine/') && /\/(api|store|main)\.js$/.test(rel)), '서버의 api.js·store.js·main.js')
    assert.ok(!files.some((rel) => rel.startsWith('engine/trends/')), '트렌드 수집 모듈')
    assert.ok(!files.some((rel) => rel.split('/').some((part) => part === 'node_modules' || part === 'test' || part.startsWith('.env'))))
    assert.ok(!files.some((rel) => rel.endsWith('.test.js')))
    assert.deepEqual(built.engine, ['generate/engine.js', 'generate/llm-error.js', 'generate/local-engine.js', 'generate/prompt.js', 'generate/ranking.js', 'generate/sanitize.js', 'generate/template.js', 'safety/filter.js', 'safety/lexicon.js'])
  })

  test('index.html에 CSP와 referrer <meta>가 들어간다(frame-ancestors 제외)', async () => {
    const html = await readFile(path.join(out, 'index.html'), 'utf8')
    assert.ok(html.includes(`<meta http-equiv="Content-Security-Policy" content="${STATIC_CSP}" />`))
    assert.ok(html.includes('<meta name="referrer" content="no-referrer" />'))
    assert.match(STATIC_CSP, /default-src 'self'/)
    assert.match(STATIC_CSP, /script-src 'self'/)
    assert.doesNotMatch(STATIC_CSP, /frame-ancestors/)
    // CSP는 다른 자원보다 먼저 와야 한다
    assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<link'))
  })

  test('runtime.js는 정적 모드이고 빌드 시각과 커밋을 담는다', async () => {
    const { RUNTIME } = await importBuilt('js/runtime.js')
    assert.equal(RUNTIME.mode, 'static')
    assert.ok(!Number.isNaN(Date.parse(RUNTIME.builtAt)))
    assert.equal(RUNTIME.commit, FAKE_SHA)
    assert.ok(Object.isFrozen(RUNTIME))
    // 원본은 서버 모드 그대로다
    const { RUNTIME: original } = await import('../public/js/runtime.js')
    assert.equal(original.mode, 'server')
  })

  test('trends.json: 승인된 예시 트렌드(엔진 힌트 포함), 틀, 통계', async () => {
    const data = JSON.parse(await readFile(path.join(out, 'data', 'trends.json'), 'utf8'))
    assert.ok(!Number.isNaN(Date.parse(data.generatedAt)))
    assert.ok(Array.isArray(data.items) && data.items.length >= 20)
    assert.equal(built.trends, data.items.length)
    for (const item of data.items) {
      assert.equal(item.status, 'approved')
      assert.equal(typeof item.id, 'string')
    }
    assert.ok(data.items.some((item) => item.engine), '규칙 엔진 힌트를 함께 싣는다')
    assert.ok(Array.isArray(data.frames) && data.frames.length > 0)
    assert.deepEqual(Object.keys(data.stats).sort(), ['approved', 'lastCollectedAt', 'live', 'pending', 'rejected', 'seed'])
    assert.equal(data.stats.seed, data.items.length)
  })

  test('글꼴 CSS와 그 CSS가 가리키는 파일이 모두 있다', async () => {
    for (const css of ['vendor/pretendard/pretendardvariable-dynamic-subset.css', 'vendor/black-han-sans/index.css']) {
      const text = await readFile(path.join(out, ...css.split('/')), 'utf8')
      const urls = cssUrls(text)
      assert.ok(urls.length > 0, css)
      for (const url of urls) assert.ok(await existsExact(out, path.posix.normalize(path.posix.join(path.posix.dirname(css), url))), `${css} → ${url}`)
    }
  })

  test('모든 JS의 import가 상대 경로이고 대소문자까지 같은 파일을 가리킨다', async () => {
    const files = (await listFiles(out)).filter((rel) => rel.endsWith('.js'))
    let count = 0
    for (const rel of files) {
      const { static: statics, dynamic } = scanModuleSpecifiers(await readFile(path.join(out, ...rel.split('/')), 'utf8'))
      for (const spec of [...statics, ...dynamic]) {
        assert.ok(spec.startsWith('./') || spec.startsWith('../'), `${rel}: ${spec}`)
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec))
        assert.ok(!target.startsWith('..'), `${rel}: ${spec}`)
        assert.ok(await existsExact(out, target), `${rel}: ${spec}`)
        count++
      }
    }
    assert.ok(count > 50)
    // 정적 모드에서만 불러오는 브라우저 안 백엔드는 문자열 import()로 이어져 있다
    assert.deepEqual(scanModuleSpecifiers(await readFile(path.join(out, 'js', 'api.js'), 'utf8')).dynamic, ['./static-backend.js'])
  })

  test('HTML·JS에 같은 출처의 절대 경로가 없다', async () => {
    const html = await readFile(path.join(out, 'index.html'), 'utf8')
    for (const match of html.matchAll(/\s(?:href|src)="([^"]*)"/g)) assert.ok(!match[1].startsWith('/'), match[1])
    for (const rel of (await listFiles(out)).filter((f) => f.endsWith('.js'))) {
      const source = await readFile(path.join(out, ...rel.split('/')), 'utf8')
      assert.doesNotMatch(source, /from\s+['"]\//, rel)
      assert.doesNotMatch(source, /href:\s*['"]\/(?!\/)/, rel)
    }
  })

  test('검사기는 대소문자가 다른 import, 절대 경로, 서버 전용 파일을 잡아낸다', async () => {
    const copy = path.join(tmp, 'broken')
    await cp(out, copy, { recursive: true })
    const ui = path.join(copy, 'js', 'ui.js')
    await writeFile(ui, (await readFile(ui, 'utf8')).replace("from './dom.js'", "from './Dom.js'"))
    const index = path.join(copy, 'index.html')
    await writeFile(index, (await readFile(index, 'utf8')).replace('href="css/app.css"', 'href="/css/app.css"'))
    await mkdir(path.join(copy, 'engine', 'generate'), { recursive: true })
    await writeFile(path.join(copy, 'engine', 'generate', 'llm.js'), 'export {}\n')
    await assert.rejects(validateStatic(copy), (err) => {
      assert.ok(err instanceof BuildError)
      assert.ok(err.problems.some((p) => p.includes('js/ui.js') && p.includes('./Dom.js')), 'Dom.js')
      assert.ok(err.problems.some((p) => p.includes("'/css/app.css'")), '절대 경로')
      assert.ok(err.problems.some((p) => p.includes('engine/generate/llm.js')), 'llm.js')
      return true
    })
  })

  test('저장소 원본을 지울 수 있는 결과물 폴더는 거절한다', async () => {
    const refuse = (dir) => assert.throws(() => assertSafeOutDir(dir, ROOT), BuildError, dir)
    refuse(ROOT)
    refuse(path.dirname(ROOT))
    for (const name of ['public', 'shared', 'server', 'test', 'scripts', 'node_modules']) {
      refuse(path.join(ROOT, name))
      refuse(path.join(ROOT, name, 'out'))
    }
    if (process.platform === 'win32') refuse(path.join(ROOT, 'PUBLIC', 'out'))
    const withPackage = path.join(tmp, 'has-package')
    await mkdir(withPackage, { recursive: true })
    await writeFile(path.join(withPackage, 'package.json'), '{}')
    refuse(withPackage)
    assert.equal(assertSafeOutDir(path.join(ROOT, 'dist'), ROOT), path.join(ROOT, 'dist'))
    assert.ok(existsSync(path.join(withPackage, 'package.json')), '거절한 폴더는 건드리지 않는다')
  })

  test('홈 폴더·.git이 있는 폴더·관계없는 내용이 든 폴더는 거절하고, 예전 결과물 폴더는 다시 쓴다', async () => {
    const refuse = (dir) => assert.throws(() => assertSafeOutDir(dir, ROOT), BuildError, dir)
    refuse(os.homedir())
    refuse(path.dirname(os.homedir()))
    refuse(path.join(ROOT, '.claude'))
    const withGit = path.join(tmp, 'has-git')
    await mkdir(path.join(withGit, '.git'), { recursive: true })
    refuse(withGit)
    const unrelated = path.join(tmp, 'unrelated')
    await mkdir(unrelated, { recursive: true })
    await writeFile(path.join(unrelated, 'keep.txt'), '지우면 안 돼요')
    refuse(unrelated)
    assert.ok(existsSync(path.join(unrelated, 'keep.txt')), '거절한 폴더는 건드리지 않는다')
    // 빈 폴더와 예전 빌드 결과물(.nojekyll이 있는 폴더)은 괜찮다
    const empty = path.join(tmp, 'empty-out')
    await mkdir(empty, { recursive: true })
    assert.equal(assertSafeOutDir(empty, ROOT), empty)
    assert.equal(assertSafeOutDir(out, ROOT), out)
  })

  test('링크(정션·심볼릭 링크)를 거친 경로로도 저장소 원본 폴더를 결과물로 쓸 수 없다', async (t) => {
    // 저장소를 흉내 낸 임시 폴더와 그곳을 가리키는 링크(실제 저장소는 가리키지 않는다)
    const fakeRoot = path.join(tmp, 'fake-root')
    await mkdir(path.join(fakeRoot, 'public', 'js'), { recursive: true })
    await writeFile(path.join(fakeRoot, 'package.json'), '{}')
    await writeFile(path.join(fakeRoot, 'public', 'js', 'keep.js'), '')
    const alias = path.join(tmp, 'alias-root')
    const { symlink, unlink } = await import('node:fs/promises')
    try {
      await symlink(fakeRoot, alias, 'junction')
    } catch (err) {
      t.skip(`링크를 만들 수 없어요: ${err.code}`)
      return
    }
    t.after(() => unlink(alias).catch(() => {}))
    for (const dir of [path.join(alias, 'public'), path.join(alias, 'public', 'out'), alias]) {
      assert.throws(() => assertSafeOutDir(dir, fakeRoot), BuildError, dir)
      assert.throws(() => assertSafeOutDir(path.join(fakeRoot, path.relative(alias, dir)), alias), BuildError, dir)
    }
    assert.ok(existsSync(path.join(fakeRoot, 'public', 'js', 'keep.js')))
  })

  test('스크립트를 링크(정션·심볼릭 링크)를 거친 경로로 실행해도 직접 실행으로 알아본다', async (t) => {
    const { spawnSync } = await import('node:child_process')
    const { symlink, unlink } = await import('node:fs/promises')
    const realDir = path.join(tmp, 'main-real')
    await mkdir(realDir, { recursive: true })
    const lib = pathToFileURL(path.join(ROOT, 'scripts', 'lib', 'static-files.mjs')).href
    await writeFile(path.join(realDir, 'entry.mjs'), `import { isMainModule } from ${JSON.stringify(lib)}\nconsole.log(isMainModule(import.meta.url) ? 'main' : 'not-main')\n`)
    const run = (file) => spawnSync(process.execPath, [file], { encoding: 'utf8' }).stdout.trim()
    assert.equal(run(path.join(realDir, 'entry.mjs')), 'main')
    const alias = path.join(tmp, 'main-alias')
    try {
      await symlink(realDir, alias, 'junction')
    } catch (err) {
      t.skip(`링크를 만들 수 없어요: ${err.code}`)
      return
    }
    t.after(() => unlink(alias).catch(() => {}))
    assert.equal(run(path.join(alias, 'entry.mjs')), 'main')
  })
})

describe('브라우저 안 백엔드(static-backend.js)', () => {
  let backend
  let trendsJson

  before(async () => {
    backend = mod.createStaticBackend({ fetchImpl: fileFetch(fetchCalls) })
    trendsJson = JSON.parse(await readFile(path.join(out, 'data', 'trends.json'), 'utf8'))
  })

  test('status: /api/status와 같은 모양, 정적 호스팅·기본 엔진·보관 기록 없음', async () => {
    const s = await backend.status()
    assert.equal(s.serviceName, DEFAULT_SERVICE_NAME)
    assert.equal(s.consentVersion, CONSENT_VERSION)
    assert.equal(s.retention, null)
    assert.equal(s.hosting, 'static')
    assert.deepEqual(s.engine, { mode: 'local', label: '기본 엔진(규칙 기반)', model: null, reason: null, configured: false })
    assert.deepEqual(s.trends, { ...trendsJson.stats, youtubeEnabled: false, instagramEnabled: false, reviewMode: 'manual', refreshMinutes: null, ttlDays: null, lastRunAt: null, lastRunOk: null, nextRunAt: null })
    // 서버 응답과 같은 칸을 갖는다(hosting만 더 있다)
    const live = await (await fetch(`${base}/api/status`)).json()
    assert.deepEqual(Object.keys(s).filter((k) => k !== 'hosting').sort(), Object.keys(live).sort())
    assert.deepEqual(Object.keys(s.engine).sort(), Object.keys(live.engine).sort())
    assert.deepEqual(Object.keys(s.trends).sort(), Object.keys(live.trends).sort())
    assert.deepEqual(s.trends.seed, live.trends.seed)
  })

  test('trends: 서버와 같은 항목·순서, 엔진 힌트는 뺀다', async () => {
    const { items, status } = await backend.trends()
    const live = await (await fetch(`${base}/api/trends`)).json()
    assert.deepEqual(items, live.items)
    for (const item of items) assert.ok(!('engine' in item))
    assert.equal(status.reviewMode, 'manual')
  })

  test('trends.json은 한 번만 받는다', () => {
    assert.equal(fetchCalls.length, 1)
    assert.ok(fetchCalls[0].endsWith('/data/trends.json'), fetchCalls[0])
  })

  /** 생성 결과가 서버 /api/generate와 같은 모양인지 */
  function assertGenerateShape(r, live) {
    assert.deepEqual(Object.keys(r).sort(), ['candidates', 'createdAt', 'engine', 'requestId', 'safety', 'trend'])
    assert.deepEqual(Object.keys(r).sort(), Object.keys(live).sort())
    assert.match(r.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    assert.equal(r.engine.mode, 'local')
    assert.deepEqual(Object.keys(r.engine).sort(), Object.keys(live.engine).sort())
    assert.equal(r.candidates.length, LIMITS.candidates.count)
    r.candidates.forEach((c, i) => {
      assert.equal(c.id, `${r.requestId}-${i + 1}`)
      assert.equal(c.examples.length, LIMITS.candidates.examplesPerCandidate)
      assert.ok(c.text)
      assert.deepEqual(Object.keys(c).sort(), Object.keys(live.candidates[0]).sort())
    })
    assert.deepEqual(Object.keys(r.safety).sort(), Object.keys(live.safety).sort())
    assert.equal(r.safety.judge, 'rules')
    assert.ok(!('engine' in r.trend))
    assert.deepEqual(r.trend, live.trend)
    assert.ok(!Number.isNaN(Date.parse(r.createdAt)))
  }

  test('generate(예시 트렌드): 서버와 같은 모양', async () => {
    const trend = trendsJson.items.find((t) => t.kind === 'pattern') ?? trendsJson.items[0]
    const body = { anonId: 'static-test', profile: payloadFor(SAMPLE_PERSONAS[0]), trendId: trend.id, options: { situation: 'chat', spice: 'medium', topic: '' }, feedback: {} }
    const r = await backend.generate(body)
    const live = await (await fetch(`${base}/api/generate`, json(body))).json()
    assertGenerateShape(r, live)
    assert.equal(r.trend.id, trend.id)
  })

  test('generate(직접 입력한 트렌드): 서버와 같은 모양, id는 키워드의 SHA-256', async () => {
    const keyword = '주말 등산'
    const body = { anonId: 'static-test', profile: payloadFor(SAMPLE_PERSONAS[1]), customTrend: { keyword, meaning: '주말마다 산에 가는 것' }, options: { situation: 'sns', spice: 'hot', topic: '' }, feedback: {} }
    const r = await backend.generate(body)
    const live = await (await fetch(`${base}/api/generate`, json(body))).json()
    assertGenerateShape(r, live)
    assert.equal(r.trend.id, `custom-${createHash('sha256').update(keyword).digest('hex').slice(0, 10)}`)
    assert.equal(r.trend.source.type, 'custom')

    const checked = await backend.checkTrend({ keyword, meaning: '주말마다 산에 가는 것' })
    const liveChecked = await (await fetch(`${base}/api/trends/check`, json({ keyword, meaning: '주말마다 산에 가는 것' }))).json()
    assert.deepEqual(checked, liveChecked)
  })

  /** 서버와 정적 백엔드가 같은 상태 코드·코드·문구로 거절하는지 */
  async function assertSameError(staticCall, path, body) {
    const res = await fetch(`${base}${path}`, json(body))
    const { error } = await res.json()
    let caught = null
    try {
      await staticCall(body)
    } catch (err) {
      caught = err
    }
    assert.ok(caught instanceof ApiError, `${path}: ApiError`)
    assert.equal(caught.status, res.status, path)
    assert.equal(caught.code, error.code, path)
    assert.equal(caught.message, error.message, path)
    return caught
  }

  test('막힌 키워드: 422 blocked_input, 걸린 낱말은 문구에 넣지 않는다(서버와 같은 문구)', async () => {
    const err = await assertSameError((b) => backend.generate(b), '/api/generate', { anonId: 'static-test', profile: payloadFor(SAMPLE_PERSONAS[0]), customTrend: { keyword: BAD_WORD, meaning: '' }, options: {}, feedback: {} })
    assert.equal(err.status, 422)
    assert.equal(err.code, 'blocked_input')
    assert.ok(!err.message.includes(BAD_WORD))
    assert.match(err.message, /^입력한 말에 쓸 수 없는 표현이 있어요/)

    const checkErr = await assertSameError((b) => backend.checkTrend(b), '/api/trends/check', { keyword: BAD_WORD, meaning: '' })
    assert.equal(checkErr.status, 422)
    assert.ok(checkErr.message.startsWith('이 키워드는 쓸 수 없어요'))
    assert.ok(!checkErr.message.includes(BAD_WORD))

    const trend = trendsJson.items[0]
    const topicErr = await assertSameError((b) => backend.generate(b), '/api/generate', { profile: payloadFor(SAMPLE_PERSONAS[0]), trendId: trend.id, options: { situation: 'chat', spice: 'medium', topic: BAD_WORD }, feedback: {} })
    assert.equal(topicErr.code, 'blocked_input')
  })

  test('없는 트렌드: 404 trend_not_found(서버와 같은 문구)', async () => {
    const err = await assertSameError((b) => backend.generate(b), '/api/generate', { profile: payloadFor(SAMPLE_PERSONAS[0]), trendId: 'no-such-trend', options: {}, feedback: {} })
    assert.equal(err.status, 404)
    assert.equal(err.code, 'trend_not_found')
    assert.equal(err.message, API_ERRORS.trendNotFound.message)
    // 트렌드를 아예 고르지 않아도 같다
    await assertSameError((b) => backend.generate(b), '/api/generate', { profile: payloadFor(SAMPLE_PERSONAS[0]) })
  })

  test('빈 키워드: 400 bad_request(서버와 같은 문구)', async () => {
    const err = await assertSameError((b) => backend.checkTrend(b), '/api/trends/check', { keyword: '   ' })
    assert.equal(err.status, 400)
    assert.equal(err.message, API_ERRORS.trendKeywordMissing.message)
    await assertSameError((b) => backend.generate(b), '/api/generate', { profile: payloadFor(SAMPLE_PERSONAS[0]), customTrend: { keyword: '  ' } })
  })

  test('객체가 아닌 본문은 400 bad_json(서버와 같은 문구)', async () => {
    await assert.rejects(backend.generate([1, 2]), (err) => err instanceof ApiError && err.status === 400 && err.code === 'bad_json' && err.message === API_ERRORS.badJsonObject.message)
    const res = await fetch(`${base}/api/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '[1,2]' })
    assert.deepEqual((await res.json()).error, { code: 'bad_json', message: API_ERRORS.badJsonObject.message })
  })

  test('event·report는 네트워크를 쓰지 않는다', async () => {
    const before = fetchCalls.length
    assert.deepEqual(await backend.event({ type: 'like', requestId: 'r', candidateId: 'r-1' }), { ok: true })
    assert.deepEqual(await backend.report({ reason: 'offensive', text: '문구', note: '연락처 010-1234-5678' }), { ok: true, delivered: false })
    assert.equal(fetchCalls.length, before)
    // 처음 만든 백엔드도 trends.json을 받기 전에는 아무것도 부르지 않는다
    const calls = []
    const fresh = mod.createStaticBackend({ fetchImpl: fileFetch(calls) })
    await fresh.event({})
    await fresh.report({})
    assert.equal(calls.length, 0)
  })

  test('trends.json을 받지 못하면 network ApiError, 다음 호출 때 다시 받는다', async () => {
    let fail = true
    const calls = []
    const good = fileFetch(calls)
    const flaky = mod.createStaticBackend({
      fetchImpl: async (url) => {
        if (fail) {
          calls.push('fail')
          throw new TypeError('Failed to fetch')
        }
        return good(url)
      },
    })
    await assert.rejects(flaky.status(), (err) => err instanceof ApiError && err.code === 'network')
    fail = false
    const s = await flaky.status()
    assert.equal(s.hosting, 'static')
    assert.equal(calls.length, 2)
    // HTTP 오류도 같은 방식으로 다룬다
    const notFound = mod.createStaticBackend({ fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({}) }) })
    await assert.rejects(notFound.trends(), (err) => err instanceof ApiError && err.code === 'network')
  })

  test('생성 결과는 JSON으로 한 번 오간 값이라 백엔드 내부 상태와 이어지지 않는다', async () => {
    const trend = trendsJson.items[0]
    const body = { profile: payloadFor(SAMPLE_PERSONAS[2]), trendId: trend.id, options: { situation: 'chat', spice: 'mild', topic: '' }, feedback: {} }
    const a = await backend.generate(body)
    a.trend.keyword = '바꿈'
    const { items } = await backend.trends()
    assert.equal(items.find((t) => t.id === trend.id).keyword, trend.keyword)
  })
})

describe('화면의 api.js', () => {
  test('정적 모드: 브라우저 안 백엔드로 응답하고 /api/*를 부르지 않는다', async (t) => {
    const calls = []
    const original = globalThis.fetch
    globalThis.fetch = fileFetch(calls)
    t.after(() => {
      globalThis.fetch = original
    })
    const { api, ApiError: Exported } = await importBuilt('js/api.js')
    assert.equal(Exported, ApiError, 'api.js는 api-error.js의 ApiError를 다시 내보낸다')
    const s = await api.status()
    assert.equal(s.hosting, 'static')
    const { items } = await api.trends()
    assert.ok(items.length > 0)
    assert.deepEqual(await api.report({}), { ok: true, delivered: false })
    assert.deepEqual(await api.event({}), { ok: true })
    assert.ok(calls.every((url) => url.endsWith('/data/trends.json')), calls.join())
    assert.equal(calls.length, 1)
  })

  test('서버 모드(원본): /api/*로 요청한다', async (t) => {
    const calls = []
    const original = globalThis.fetch
    globalThis.fetch = async (url) => {
      calls.push(String(url))
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }
    t.after(() => {
      globalThis.fetch = original
    })
    const { api, ApiError: Exported } = await import('../public/js/api.js')
    const { ApiError: Original } = await import('../public/js/api-error.js')
    assert.equal(Exported, Original)
    await api.status()
    await api.report({ reason: 'x' })
    assert.deepEqual(calls, ['/api/status', '/api/report'])
  })
})

test('서버 오류 문구는 shared/api-messages.js에서 온다', () => {
  assert.deepEqual(blockedTrendError([]), { status: 422, code: 'blocked_input', message: '이 키워드는 쓸 수 없어요. 다른 말로 바꿔 주세요.' })
  assert.match(blockedInputError(['hate']).message, /^입력한 말에 쓸 수 없는 표현이 있어요 \(.+\)\. 바꿔서 다시 시도해 주세요\.$/)
})
