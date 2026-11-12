// 정적 배포(GitHub Pages) 빌드: 서버 없이 돌아가는 사이트를 한 폴더(기본 dist/)에 만든다.
// 실행: node scripts/build-static.mjs [--out <폴더>]   (또는 npm run build:static)
//
// - public/ 화면(운영 화면 제외), shared/ 모듈, 규칙 기반 엔진(server/generate·server/safety 중 실제로 불러오는 것만), 글꼴을 복사한다.
// - 예시 트렌드를 data/trends.json으로 묶고, js/runtime.js를 정적 모드로 덮어쓴다.
// - 프로젝트 사이트(https://<계정>.github.io/<저장소>/)의 하위 경로에서도 돌도록 모든 경로가 상대 경로인지 검사한다.
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CSP_DIRECTIVES } from '../server/http.js'
import { createTrendStore } from '../server/trends/trend-store.js'
import { scanModuleSpecifiers } from './lib/module-scan.mjs'
import { existsExact, isMainModule, listFiles } from './lib/static-files.mjs'

const DEFAULT_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

/** 결과물에 싣지 않는 화면(서버 전용 운영 화면) */
const SKIP_PUBLIC = new Set(['ops.html', 'js/ops.js'])
/** 결과물로 쓰면 안 되는 폴더(저장소 안의 원본·설정) */
const PROTECTED_DIRS = ['public', 'shared', 'server', 'test', 'scripts', 'node_modules', 'data', '.git', '.github', '.claude']
/** 엔진 모듈을 모으기 시작하는 곳 */
const ENGINE_ENTRIES = ['server/generate/engine.js', 'server/safety/filter.js']
const FONTS = [
  { name: 'pretendard', dir: 'node_modules/pretendard/dist/web/variable', css: 'pretendardvariable-dynamic-subset.css' },
  { name: 'black-han-sans', dir: 'node_modules/@fontsource/black-han-sans', css: 'index.css', license: 'LICENSE' },
]
/** 정적 사이트에 있어야 하는 파일 */
const REQUIRED_FILES = [
  'index.html',
  '.nojekyll',
  'favicon.svg',
  'css/app.css',
  'js/main.js',
  'js/api.js',
  'js/api-error.js',
  'js/runtime.js',
  'js/static-backend.js',
  'shared/constants.js',
  'shared/api-messages.js',
  'shared/crypto-lite.js',
  'engine/generate/engine.js',
  'engine/generate/llm-error.js',
  'engine/safety/filter.js',
  'data/trends.json',
  'vendor/pretendard/pretendardvariable-dynamic-subset.css',
  'vendor/black-han-sans/index.css',
]
/** 어디에 있든 결과물에 있으면 안 되는 파일 이름(서버 전용 코드·설정) */
const FORBIDDEN_NAMES = new Set([
  'llm.js',
  'config.js',
  'http.js',
  'events.js',
  'pipeline.js',
  'youtube.js',
  'instagram.js',
  'quota.js',
  'extract.js',
  'extract-llm.js',
  'run-collect.js',
  'trend-store.js',
  'seed-trends.json',
  'ops.html',
  'ops.js',
  'server.js',
  'package.json',
  'package-lock.json',
])
/** engine/ 아래에 있으면 안 되는 이름(서버 쪽 api.js·store.js·main.js. 화면용 js/api.js·js/store.js는 괜찮다) */
const FORBIDDEN_ENGINE_NAMES = new Set(['api.js', 'store.js', 'main.js'])

export class BuildError extends Error {
  constructor(message, problems = []) {
    super(problems.length ? `${message}\n  - ${problems.join('\n  - ')}` : message)
    this.name = 'BuildError'
    this.problems = problems
  }
}

const toPosix = (p) => p.split(path.sep).join('/')
const sameCase = (p) => (process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p)
/** child가 parent와 같거나 그 안에 있는지 */
function isWithin(child, parent) {
  const rel = path.relative(sameCase(parent), sameCase(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}
const isRelativeSpecifier = (spec) => spec.startsWith('./') || spec.startsWith('../')

/**
 * 심볼릭 링크·정션·subst 드라이브를 따라간 실제 경로. 아직 없는 경로는 가장 가까운 기존 상위 폴더의 실제 경로에 나머지를 붙인다.
 * 링크를 거쳐 저장소 원본을 가리키는 경로가 검사를 빠져나가지 못하게 한다.
 */
function canonicalPath(p) {
  let current = path.resolve(p)
  const rest = []
  for (;;) {
    try {
      return path.join(realpathSync.native(current), ...rest.reverse())
    } catch {
      const parent = path.dirname(current)
      if (parent === current) return path.resolve(p)
      rest.push(path.basename(current))
      current = parent
    }
  }
}

/** 예전 빌드 결과물처럼 보이는지(빌드는 처음에 .nojekyll부터 쓴다) */
const looksLikeBuild = (dir) => existsSync(path.join(dir, '.nojekyll'))

/** 결과물 폴더로 써도 되는지. 지우고 다시 만들기 때문에 저장소의 원본이나 관계없는 폴더를 지우지 않도록 막는다. */
export function assertSafeOutDir(outDir, root) {
  const out = path.resolve(outDir)
  // 검사는 링크를 따라간 실제 경로로 한다
  const real = canonicalPath(out)
  const base = canonicalPath(root)
  if (isWithin(base, real)) throw new BuildError(`결과물 폴더로 저장소 폴더나 그 상위 폴더는 쓸 수 없어요: ${out}`)
  for (const name of PROTECTED_DIRS) {
    if (isWithin(real, path.join(base, name))) throw new BuildError(`결과물 폴더로 저장소의 ${name}/ 안은 쓸 수 없어요: ${out}`)
  }
  if (isWithin(canonicalPath(os.homedir()), real)) throw new BuildError(`결과물 폴더로 홈 폴더나 그 상위 폴더는 쓸 수 없어요: ${out}`)
  if (existsSync(real)) {
    if (!statSync(real).isDirectory()) throw new BuildError(`결과물 경로가 폴더가 아니에요: ${out}`)
    if (existsSync(path.join(real, 'package.json'))) throw new BuildError(`package.json이 있는 폴더는 결과물 폴더로 쓸 수 없어요: ${out}`)
    if (existsSync(path.join(real, '.git'))) throw new BuildError(`.git이 있는 폴더는 결과물 폴더로 쓸 수 없어요: ${out}`)
    let entries
    try {
      entries = readdirSync(real)
    } catch (err) {
      throw new BuildError(`결과물 폴더를 읽을 수 없어요(${err.code}): ${out}`)
    }
    if (entries.length && !looksLikeBuild(real)) {
      throw new BuildError(`비어 있지 않고 예전 빌드 결과물(.nojekyll)도 아닌 폴더는 지우지 않아요. 빈 폴더나 새 폴더를 골라 주세요: ${out}`)
    }
  }
  return out
}

async function copyFile(from, to) {
  await mkdir(path.dirname(to), { recursive: true })
  await cp(from, to)
}

/** public/의 화면 파일을 복사한다(운영 화면 제외). */
async function copyPublic(root, out) {
  const dir = path.join(root, 'public')
  const files = (await listFiles(dir)).filter((rel) => !SKIP_PUBLIC.has(rel))
  for (const rel of files) await copyFile(path.join(dir, rel), path.join(out, rel))
  return files.length
}

/** shared/의 모듈을 복사한다. */
async function copyShared(root, out) {
  const dir = path.join(root, 'shared')
  const files = (await listFiles(dir)).filter((rel) => !rel.includes('/') && rel.endsWith('.js'))
  for (const rel of files) await copyFile(path.join(dir, rel), path.join(out, 'shared', rel))
  return files.length
}

/**
 * 엔진 입구(engine.js, filter.js)에서 상대 경로로 불러오는 모듈을 따라가 server/ 쪽 파일만 모은다(llm.js처럼 부르지 않는 파일은 빠진다).
 * shared/ 쪽은 통째로 복사하므로 따라가지 않는다. 패키지·node: 모듈을 부르면 브라우저에서 돌 수 없으므로 실패로 본다.
 * @returns {Promise<string[]>} server/ 기준 상대 경로('/' 구분)
 */
export async function engineClosure(root) {
  const serverDir = path.join(root, 'server')
  const sharedDir = path.join(root, 'shared')
  const seen = new Set()
  const files = []
  const queue = ENGINE_ENTRIES.map((rel) => path.join(root, ...rel.split('/')))
  const problems = []
  while (queue.length) {
    const file = queue.shift()
    const key = sameCase(file)
    if (seen.has(key)) continue
    seen.add(key)
    files.push(file)
    let source
    try {
      source = await readFile(file, 'utf8')
    } catch {
      problems.push(`엔진 모듈을 읽지 못했어요: ${toPosix(path.relative(root, file))}`)
      continue
    }
    const { static: statics, dynamic, dynamicNonLiteral } = scanModuleSpecifiers(source)
    const from = toPosix(path.relative(root, file))
    if (dynamicNonLiteral) problems.push(`${from}: 경로를 미리 알 수 없는 import()가 있어요`)
    for (const spec of [...statics, ...dynamic]) {
      if (!isRelativeSpecifier(spec)) {
        problems.push(`${from}: 브라우저에서 불러올 수 없는 모듈 '${spec}'`)
        continue
      }
      const target = path.resolve(path.dirname(file), spec)
      if (isWithin(target, serverDir)) queue.push(target)
      else if (!isWithin(target, sharedDir)) problems.push(`${from}: server/·shared/ 밖의 모듈 '${spec}'`)
    }
  }
  if (problems.length) throw new BuildError('엔진 모듈을 모으지 못했어요.', problems)
  return files.map((file) => toPosix(path.relative(serverDir, file))).sort()
}

/** 모은 엔진 모듈을 out/engine/ 아래에 server/ 기준 같은 상대 경로로 복사한다. */
async function copyEngine(root, out) {
  const files = await engineClosure(root)
  for (const rel of files) await copyFile(path.join(root, 'server', ...rel.split('/')), path.join(out, 'engine', ...rel.split('/')))
  return files
}

/** CSS의 url(…) 가운데 상대 경로만 돌려준다(쿼리·조각 제외). */
export function cssUrls(css) {
  const urls = []
  for (const match of css.matchAll(/url\(\s*(['"]?)([^'")]+?)\1\s*\)/g)) {
    const raw = match[2].trim()
    if (/^(data:|https?:|\/\/|#)/i.test(raw)) continue
    urls.push(raw.split(/[?#]/)[0])
  }
  return [...new Set(urls)]
}

/** 글꼴 CSS와 그 CSS가 가리키는 파일을 같은 상대 경로로 복사한다. 빠진 파일이 있으면 실패. */
async function copyFonts(root, out) {
  let count = 0
  const problems = []
  for (const font of FONTS) {
    const dir = path.join(root, ...font.dir.split('/'))
    const cssFile = path.join(dir, font.css)
    let css
    try {
      css = await readFile(cssFile, 'utf8')
    } catch {
      problems.push(`글꼴 CSS가 없어요: ${font.dir}/${font.css} (npm ci를 먼저 실행하세요)`)
      continue
    }
    const target = path.join(out, 'vendor', font.name)
    await copyFile(cssFile, path.join(target, font.css))
    count++
    for (const url of cssUrls(css)) {
      const from = path.resolve(dir, url)
      if (!isWithin(from, dir)) {
        problems.push(`${font.css}: 글꼴 폴더 밖을 가리켜요 (${url})`)
        continue
      }
      const rel = toPosix(path.relative(dir, from))
      if (!(await existsExact(dir, rel))) {
        problems.push(`${font.css}: 가리키는 파일이 없어요 (${url})`)
        continue
      }
      await copyFile(from, path.join(target, rel))
      count++
    }
    // 글꼴 라이선스(OFL)를 함께 싣는다
    if (font.license && existsSync(path.join(dir, font.license))) {
      await copyFile(path.join(dir, font.license), path.join(target, `${font.license}.txt`))
      count++
    }
  }
  if (problems.length) throw new BuildError('글꼴을 복사하지 못했어요.', problems)
  return count
}

/** 예시 트렌드를 묶는다. 저장소의 data/ 대신 새 임시 폴더를 쓰고, 실패해도 지운다. */
async function writeTrends(root, out) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'catchphrase-static-trends-'))
  try {
    const store = createTrendStore({ dataDir: tmp, seedPath: path.join(root, 'server', 'trends', 'seed-trends.json') })
    await store.init()
    const items = store.list({ status: 'approved', includeSeed: true })
    if (!items.length) throw new BuildError('묶을 트렌드가 없어요(server/trends/seed-trends.json 확인).')
    const data = { generatedAt: new Date().toISOString(), items, frames: store.frames(), stats: store.stats() }
    await mkdir(path.join(out, 'data'), { recursive: true })
    await writeFile(path.join(out, 'data', 'trends.json'), JSON.stringify(data))
    return items.length
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

/** 화면이 정적 모드로 돌도록 runtime.js를 덮어쓴다. */
async function writeRuntime(out, env) {
  const runtime = { mode: 'static', builtAt: new Date().toISOString() }
  const sha = String(env.GITHUB_SHA ?? '').trim()
  if (/^[0-9a-f]{7,64}$/i.test(sha)) runtime.commit = sha.toLowerCase()
  const source = [
    '// 정적 배포 빌드(scripts/build-static.mjs)가 만든 파일이에요. 원본은 public/js/runtime.js예요.',
    `export const RUNTIME = Object.freeze(${JSON.stringify(runtime)})`,
    '',
  ].join('\n')
  await writeFile(path.join(out, 'js', 'runtime.js'), source)
  return runtime
}

/** 정적 호스팅은 응답 헤더를 정할 수 없으므로 서버와 같은 정책을 <meta>로 넣는다(frame-ancestors는 <meta>에서 무시돼 뺀다). */
export const STATIC_CSP = CSP_DIRECTIVES.filter((directive) => !directive.startsWith('frame-ancestors')).join('; ')

async function injectHead(out) {
  const file = path.join(out, 'index.html')
  const html = await readFile(file, 'utf8')
  const charset = /<meta charset="utf-8"\s*\/?>/i
  if (!charset.test(html)) throw new BuildError('index.html에서 <meta charset="utf-8" />를 찾지 못했어요.')
  if (html.includes('http-equiv="Content-Security-Policy"')) throw new BuildError('index.html에 이미 CSP <meta>가 있어요.')
  const head = `$&\n    <meta http-equiv="Content-Security-Policy" content="${STATIC_CSP}" />\n    <meta name="referrer" content="no-referrer" />`
  await writeFile(file, html.replace(charset, head))
}

/** 결과물에 서버 전용 파일이 섞였는지 */
function forbiddenProblems(files) {
  const problems = []
  for (const rel of files) {
    const parts = rel.split('/')
    const name = parts.at(-1)
    const why =
      FORBIDDEN_NAMES.has(name) ? '서버 전용 파일'
      : parts[0] === 'engine' && FORBIDDEN_ENGINE_NAMES.has(name) ? '서버 전용 파일'
      : parts[0] === 'engine' && !['generate', 'safety'].includes(parts[1]) ? '엔진 밖의 서버 모듈'
      : name.startsWith('.env') ? '환경 설정 파일'
      : /\.test\.(m?js)$/.test(name) || parts.includes('test') ? '테스트 파일'
      : parts.includes('node_modules') ? 'node_modules'
      : parts.includes('server') || parts.includes('scripts') ? '저장소 원본 폴더'
      : null
    if (why) problems.push(`${why}: ${rel}`)
  }
  return problems
}

/** 결과물 안 JS의 모든 import가 상대 경로이고, 대소문자까지 똑같은 파일을 가리키는지 */
async function importProblems(out, files) {
  const problems = []
  const cache = new Map()
  for (const rel of files.filter((f) => f.endsWith('.js') || f.endsWith('.mjs'))) {
    const { static: statics, dynamic } = scanModuleSpecifiers(await readFile(path.join(out, rel), 'utf8'))
    for (const spec of [...statics, ...dynamic]) {
      if (!isRelativeSpecifier(spec)) {
        problems.push(`${rel}: 상대 경로가 아닌 import '${spec}'`)
        continue
      }
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec.split(/[?#]/)[0]))
      if (target.startsWith('../') || target === '..') problems.push(`${rel}: 결과물 밖을 가리키는 import '${spec}'`)
      else if (!(await existsExact(out, target, cache))) problems.push(`${rel}: 없는 파일(대소문자 포함)을 가리키는 import '${spec}'`)
    }
  }
  return problems
}

/** HTML의 href/src와 CSS의 url()이 상대 경로이고 실제로 있는지(바깥 https 링크와 #조각은 괜찮다) */
async function linkProblems(out, files) {
  const problems = []
  const cache = new Map()
  const check = async (rel, ref) => {
    if (ref.startsWith('#') || /^https:\/\//i.test(ref) || /^data:/i.test(ref)) return
    if (ref.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(ref)) {
      problems.push(`${rel}: 상대 경로가 아닌 주소 '${ref}'`)
      return
    }
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), ref.split(/[?#]/)[0]))
    if (target.startsWith('../')) problems.push(`${rel}: 결과물 밖을 가리키는 주소 '${ref}'`)
    else if (!(await existsExact(out, target, cache))) problems.push(`${rel}: 없는 파일(대소문자 포함)을 가리키는 주소 '${ref}'`)
  }
  for (const rel of files) {
    if (rel.endsWith('.html')) {
      const html = await readFile(path.join(out, rel), 'utf8')
      for (const match of html.matchAll(/\s(?:href|src)\s*=\s*(["'])(.*?)\1/gi)) await check(rel, match[2])
    } else if (rel.endsWith('.css')) {
      const css = await readFile(path.join(out, rel), 'utf8')
      for (const ref of cssUrls(css)) await check(rel, ref)
    }
  }
  return problems
}

/** 빌드한 결과물을 검사한다. 문제가 있으면 BuildError. */
export async function validateStatic(out) {
  const files = await listFiles(out)
  const problems = []
  for (const rel of REQUIRED_FILES) if (!files.includes(rel)) problems.push(`꼭 있어야 하는 파일이 없어요: ${rel}`)
  problems.push(...forbiddenProblems(files))
  problems.push(...(await importProblems(out, files)))
  problems.push(...(await linkProblems(out, files)))
  if (files.includes('js/runtime.js') && !/"mode":"static"/.test(await readFile(path.join(out, 'js', 'runtime.js'), 'utf8'))) problems.push('js/runtime.js가 정적 모드가 아니에요')
  if (files.includes('index.html')) {
    const html = await readFile(path.join(out, 'index.html'), 'utf8')
    if (!html.includes(`<meta http-equiv="Content-Security-Policy" content="${STATIC_CSP}" />`)) problems.push('index.html에 CSP <meta>가 없어요')
    if (!html.includes('<meta name="referrer" content="no-referrer" />')) problems.push('index.html에 referrer <meta>가 없어요')
  }
  if (problems.length) throw new BuildError('정적 사이트 검사에서 문제를 찾았어요.', problems)
  return files
}

/**
 * @param {{ outDir?: string, root?: string, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {Promise<{ outDir: string, files: number, bytes: number, trends: number, engine: string[], runtime: object }>}
 */
export async function buildStatic({ outDir, root = DEFAULT_ROOT, env = process.env } = {}) {
  const base = path.resolve(root)
  const out = assertSafeOutDir(outDir ?? path.join(base, 'dist'), base)
  await rm(out, { recursive: true, force: true })
  await mkdir(out, { recursive: true })
  // Jekyll이 밑줄(_)로 시작하는 파일을 빼거나 바꾸지 않도록 끈다. 가장 먼저 써서, 중간에 실패한 결과물도 다음 빌드가 예전 결과물로 알아보게 한다.
  await writeFile(path.join(out, '.nojekyll'), '')

  await copyPublic(base, out)
  await copyShared(base, out)
  const engine = await copyEngine(base, out)
  await copyFonts(base, out)
  const trends = await writeTrends(base, out)
  const runtime = await writeRuntime(out, env)
  await injectHead(out)

  const files = await validateStatic(out)
  let bytes = 0
  for (const rel of files) bytes += (await stat(path.join(out, rel))).size
  return { outDir: out, files: files.length, bytes, trends, engine, runtime }
}

function parseArgs(argv) {
  const args = { outDir: undefined }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--out') {
      if (!argv[i + 1]) throw new BuildError('--out 뒤에 폴더를 적어 주세요.')
      args.outDir = argv[++i]
    } else if (arg.startsWith('--out=')) {
      args.outDir = arg.slice('--out='.length)
    } else {
      throw new BuildError(`알 수 없는 인자예요: ${arg}  (사용법: node scripts/build-static.mjs [--out <폴더>])`)
    }
  }
  return args
}

if (isMainModule(import.meta.url)) {
  try {
    const { outDir } = parseArgs(process.argv.slice(2))
    const result = await buildStatic({ outDir: outDir ? path.resolve(outDir) : undefined })
    console.log(`정적 사이트를 만들었어요: ${result.outDir}`)
    console.log(`  파일 ${result.files}개 · 총 ${(result.bytes / 1024).toFixed(1)} KB · 트렌드 ${result.trends}개 · 엔진 모듈 ${result.engine.length}개 · 검사 통과`)
  } catch (err) {
    console.error(err instanceof BuildError ? err.message : err)
    process.exitCode = 1
  }
}
