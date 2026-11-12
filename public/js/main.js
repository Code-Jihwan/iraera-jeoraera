// 앱 시작점: 틀(머리글·단계 표시·바닥글)을 그리고, 주소(#/…)에 맞는 화면을 붙인다.
import { h, mount, icon } from './dom.js'
import { getState, subscribe, hasConsent, onExternalChange } from './store.js'
import { api } from './api.js'
import { toast, closeModals } from './ui.js'
import { DEFAULT_SERVICE_NAME, TEAM_LABEL } from '../shared/constants.js'
import { RUNTIME } from './runtime.js'
import { isUsableProfile } from '../shared/style-analyzer.js'
import { startView } from './views/start.js'
import { registerView } from './views/register.js'
import { profileView } from './views/profile.js'
import { trendsView } from './views/trends.js'
import { generateView } from './views/generate.js'
import { resultView } from './views/result.js'
import { savedView } from './views/saved.js'
import { dataView } from './views/data.js'
import { policyView } from './views/policy.js'

const STEPS = [
  { n: 1, route: 'register', label: '말투 등록' },
  { n: 2, route: 'profile', label: '말투 프로필' },
  { n: 3, route: 'trends', label: '트렌드 고르기' },
  { n: 4, route: 'generate', label: '유행어 생성' },
  { n: 5, route: 'result', label: '반응·공유' },
]

const ROUTES = {
  '': { view: startView, step: 0, title: '' },
  register: { view: registerView, step: 1, title: '말투 등록' },
  profile: { view: profileView, step: 2, title: '말투 프로필', needs: ['consent', 'profile'] },
  trends: { view: trendsView, step: 3, title: '트렌드 고르기', needs: ['consent', 'profile'] },
  generate: { view: generateView, step: 4, title: '유행어 생성', needs: ['consent', 'profile', 'trend'] },
  result: { view: resultView, step: 5, title: '반응·공유', needs: ['consent', 'profile', 'result'] },
  saved: { view: savedView, step: 0, title: '보관함' },
  data: { view: dataView, step: 0, title: '내 데이터' },
  policy: { view: policyView, step: 0, title: '이용 안내' },
}

// GitHub Pages 정적 데모: 서버·운영 화면이 없다
const IS_STATIC = RUNTIME.mode === 'static'

const runtime = {
  status: null,
  statusError: false,
  serviceName: DEFAULT_SERVICE_NAME,
}

let leaveCallbacks = []
let currentRoute = null

function routeName() {
  const hash = location.hash.replace(/^#\/?/, '')
  const name = hash.split(/[/?]/)[0]
  return Object.hasOwn(ROUTES, name) ? name : ''
}

export function navigate(hash) {
  const target = hash.startsWith('#') ? hash : `#/${hash}`
  if (location.hash === target) render()
  else location.hash = target
}

function reachable(stepRoute, s = getState()) {
  const hasProfile = isUsableProfile(s.profile)
  switch (stepRoute) {
    case 'register':
      return true
    case 'profile':
    case 'trends':
      return hasProfile
    case 'generate':
      return hasProfile && Boolean(s.selectedTrendId)
    case 'result':
      return hasProfile && Boolean(s.result)
    default:
      return true
  }
}

/** 조건이 안 맞으면 먼저 가야 할 화면을 돌려준다. */
function guard(name) {
  const route = ROUTES[name]
  const s = getState()
  for (const need of route.needs || []) {
    // 동의 문구가 바뀌었거나(버전), AI 엔진이 켜져 국외 이전 안내를 새로 봐야 하면 다시 동의를 받는다
    if (need === 'consent' && !hasConsent(s, runtime.status)) return { to: 'register', message: s.consent ? '안내 내용이 바뀌어 다시 동의가 필요해요.' : '먼저 동의 내용을 확인해 주세요.' }
    if (need === 'profile' && !isUsableProfile(s.profile)) return { to: 'register', message: '먼저 말투를 등록해 주세요.' }
    if (need === 'trend' && !s.selectedTrendId) return { to: 'trends', message: '트렌드를 먼저 골라 주세요.' }
    if (need === 'result' && !s.result) return { to: 'generate', message: '아직 만든 유행어가 없어요.' }
  }
  return null
}

function renderTopbar() {
  const s = getState()
  const engine = runtime.status?.engine
  const name = runtime.serviceName
  const page = routeName()
  mount(
    document.getElementById('topbar'),
    h(
      'div',
      { class: 'wrap topbar-inner' },
      h(
        'a',
        { class: 'brand', href: '#/', 'aria-label': `${name} 처음 화면` },
        h('span', { class: 'brand-name' }, name),
        h('span', { class: 'brand-tag' }, '가칭'),
      ),
      h('span', { class: 'topbar-space' }),
      engine
        ? h(
            'span',
            { class: 'engine-chip', dataset: { mode: engine.mode }, title: engine.mode === 'llm' ? `모델: ${engine.model || ''}` : engine.configured ? `AI 엔진을 쓸 수 없어 규칙 기반 엔진으로 동작합니다${engine.reason ? ` (${engine.reason})` : ''}` : IS_STATIC ? 'GitHub Pages 데모라 규칙 기반 엔진으로 동작합니다' : 'LLM 키가 없어 규칙 기반 엔진으로 동작합니다' },
            h('span', { class: 'dot' }),
            engine.label,
          )
        : null,
      h(
        'nav',
        { class: 'topnav', 'aria-label': '바로 가기' },
        h(
          'a',
          { href: '#/saved', 'aria-current': page === 'saved' ? 'page' : null },
          icon('bookmark'),
          h('span', { class: 'label' }, '보관함'),
          s.saved.length ? h('span', { class: 'count', 'aria-label': `${s.saved.length}개` }, s.saved.length) : null,
        ),
        h('a', { href: '#/data', 'aria-current': page === 'data' ? 'page' : null }, icon('user'), h('span', { class: 'label' }, '내 데이터')),
      ),
    ),
  )
}

function renderStepper() {
  const el = document.getElementById('stepper')
  const route = ROUTES[routeName()]
  // 단계 화면이 아닌 곳(보관함·내 데이터·안내)에서는 숨긴다
  if (!route.step && routeName() !== '') {
    el.hidden = true
    return
  }
  el.hidden = false
  const s = getState()
  mount(
    el,
    h(
      'div',
      { class: 'wrap' },
      h(
        'ol',
        null,
        STEPS.map((step) => {
          const can = reachable(step.route, s)
          const current = route.step === step.n
          const done = !current && can && step.n < (route.step || 0)
          return h(
            'li',
            null,
            h(
              'a',
              {
                class: 'step',
                href: can ? `#/${step.route}` : null,
                'aria-current': current ? 'step' : null,
                'aria-disabled': can ? null : 'true',
                dataset: { state: done ? 'done' : current ? 'current' : 'todo' },
                onClick: (e) => {
                  if (!can) {
                    e.preventDefault()
                    toast('앞 단계를 먼저 마쳐 주세요.')
                  }
                },
                tabIndex: can ? 0 : -1,
              },
              h('span', { class: 'num', 'aria-hidden': 'true' }, done ? icon('check', { size: 16 }) : step.n),
              h('span', { class: 'step-label' }, h('span', { class: 'sr-only' }, `${step.n}단계 `), step.label),
            ),
          )
        }),
      ),
    ),
  )
}

function renderFooter() {
  mount(
    document.getElementById('footer'),
    h(
      'div',
      { class: 'wrap stack-s' },
      h('p', null, '이 서비스는 생성형 AI를 기반으로 유행어를 만듭니다. 결과와 공유 이미지에는 ‘AI 생성’ 표시가 붙습니다.'),
      h(
        'div',
        { class: 'row' },
        h('a', { href: '#/policy' }, '이용 안내 · 개인정보 처리'),
        h('a', { href: '#/data' }, '내 데이터 관리'),
        // 운영 화면은 서버 모드에만 있다
        IS_STATIC ? h('span', null, 'GitHub Pages 데모 · 기본 엔진(규칙 기반)') : h('a', { href: 'ops.html' }, '운영 화면'),
        h('span', null, TEAM_LABEL),
      ),
    ),
  )
}

function render() {
  const name = routeName()
  // 같은 화면을 다시 그리는 것인지, 다른 화면으로 떠나는 것인지 알려 준다
  const leaving = currentRoute !== null && currentRoute !== name
  for (const fn of leaveCallbacks) {
    try {
      fn(leaving)
    } catch {
      // 화면 정리 중 오류가 다음 화면을 막지 않게 한다
    }
  }
  leaveCallbacks = []

  const blocked = guard(name)
  if (blocked) {
    toast(blocked.message)
    location.replace(`#/${blocked.to}`)
    return
  }
  const route = ROUTES[name]
  const changed = currentRoute !== name
  currentRoute = name
  // 다른 화면으로 가면 열려 있던 창(모달)을 닫는다. 같은 화면을 다시 그릴 때는 초점 자리를 기억해 둔다.
  if (changed) closeModals()
  const focus = changed ? null : captureFocus()

  const ctx = {
    get state() {
      return getState()
    },
    get status() {
      return runtime.status
    },
    get serviceName() {
      return runtime.serviceName
    },
    navigate,
    rerender: render,
    onLeave: (fn) => leaveCallbacks.push(fn),
    refreshStatus,
  }

  const main = document.getElementById('main')
  let content
  try {
    content = route.view(ctx)
  } catch (err) {
    console.error(err)
    content = h(
      'div',
      { class: 'wrap' },
      h('div', { class: 'notice danger' }, icon('alert'), h('p', null, '화면을 그리는 중 문제가 생겼어요. 새로 고침해 주세요.')),
    )
  }
  mount(main, content)
  renderTopbar()
  renderStepper()
  document.title = route.title ? `${route.title} · ${runtime.serviceName}` : `${runtime.serviceName} — 내 말투 × 떠오르는 밈`
  if (changed) {
    window.scrollTo(0, 0)
    main.focus({ preventScroll: true })
  } else {
    restoreFocus(focus)
  }
}

const FOCUSABLE = 'a[href], button, input, textarea, select, [tabindex]:not([tabindex="-1"])'
const labelOf = (el) => (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 40)

/** 화면을 다시 그리기 전에 초점이 어디 있었는지 기억한다(id → 이름 → 순서). */
function captureFocus() {
  const main = document.getElementById('main')
  const el = document.activeElement
  if (!el || el === document.body || el === main || !main.contains(el)) return null
  const all = [...main.querySelectorAll(FOCUSABLE)]
  const label = labelOf(el)
  const same = all.filter((x) => x.tagName === el.tagName && labelOf(x) === label)
  return {
    id: el.id || null,
    tag: el.tagName,
    label,
    nth: same.indexOf(el),
    order: all.indexOf(el),
    selection: typeof el.selectionStart === 'number' ? [el.selectionStart, el.selectionEnd] : null,
  }
}

/** 다시 그린 뒤 같은(또는 같은 자리의) 요소로 초점을 돌려놓는다. 버튼을 누를 때마다 초점이 맨 위로 튀지 않게. */
function restoreFocus(key) {
  if (!key) return
  const main = document.getElementById('main')
  const all = [...main.querySelectorAll(FOCUSABLE)]
  let target = key.id ? document.getElementById(key.id) : null
  if (!target) target = all.filter((x) => x.tagName === key.tag && labelOf(x) === key.label)[key.nth] || null
  if (!target && key.order >= 0) target = all[Math.min(key.order, all.length - 1)] || null
  if (!target || !main.contains(target)) return
  target.focus({ preventScroll: true })
  if (key.selection && typeof target.setSelectionRange === 'function') {
    try {
      target.setSelectionRange(key.selection[0], key.selection[1])
    } catch {
      // 선택 범위를 못 쓰는 입력(숫자 등)은 건너뛴다
    }
  }
}

async function refreshStatus() {
  try {
    runtime.status = await api.status()
    runtime.statusError = false
    if (runtime.status.serviceName) runtime.serviceName = runtime.status.serviceName
  } catch {
    runtime.statusError = true
  }
  renderTopbar()
  return runtime.status
}

/** 다른 페이지의 프레임(iframe) 안에서 열렸는지. 바깥 창을 볼 수 없으면 프레임 안으로 본다. */
function isFramed() {
  try {
    return window.top !== window.self
  } catch {
    return true
  }
}

/** 프레임 안에서는 앱을 띄우지 않고 직접 열 수 있는 링크만 보여 준다(클릭재킹 방지) */
function renderFramedNotice() {
  document.getElementById('stepper').hidden = true
  mount(
    document.getElementById('main'),
    h(
      'div',
      { class: 'wrap' },
      h(
        'div',
        { class: 'notice danger' },
        icon('alert'),
        h('p', null, '안전을 위해 이 데모는 다른 페이지 안에서는 열리지 않아요. ', h('a', { href: location.href, target: '_blank', rel: 'noopener noreferrer' }, '새 창에서 직접 열기')),
      ),
    ),
  )
}

// GitHub Pages는 X-Frame-Options·frame-ancestors 헤더를 보낼 수 없어(<meta> CSP의 frame-ancestors는 무시된다), 정적 데모는 스스로 프레임 안 실행을 막는다
if (IS_STATIC && isFramed()) {
  renderFramedNotice()
} else {
  window.addEventListener('hashchange', render)
  subscribe(() => {
    renderTopbar()
    renderStepper()
  })
  // 다른 탭에서 지우거나 바꾸면 이 탭의 화면도 다시 그린다
  onExternalChange(() => render())

  renderFooter()
  // 고지 문구가 엔진 상태(AI 엔진 사용 여부)에 따라 달라지므로, 첫 화면은 서버 상태를 잠깐 기다렸다 그린다
  const firstStatus = refreshStatus()
  let statusArrived = false
  firstStatus.then(() => {
    statusArrived = true
  })
  await Promise.race([firstStatus, new Promise((resolve) => setTimeout(resolve, 2500))])
  const renderedWithStatus = statusArrived
  render()
  firstStatus.then((status) => {
    if (!status) {
      toast(IS_STATIC ? '데모 데이터를 불러오지 못했어요. 새로 고침해 주세요.' : '서버 상태를 확인하지 못했어요. 서버가 켜져 있는지 확인해 주세요.', { type: 'error', ms: 5000 })
      return
    }
    // 상태가 늦게 왔으면 안내 문구가 맞도록 한 번 다시 그린다(입력 중인 내용과 초점은 유지된다)
    if (!renderedWithStatus) render()
  })
}
