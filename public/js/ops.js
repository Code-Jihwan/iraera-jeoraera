// 운영 화면: 성공 지표 네 가지, 트렌드 수집 상태, 사람 검수, 신고 목록.
import { h, mount, icon, formatDateTime, formatNumber } from '/js/dom.js'
import { opsRequest, ApiError } from '/js/api.js'
import { toast } from '/js/ui.js'
import { REPORT_REASONS, TECHNIQUES, TREND_CATEGORIES } from '/shared/constants.js'
import { josa } from '/shared/hangul.js'

const TOKEN_KEY = 'my-catchphrase.ops-token'
const main = document.getElementById('main')
const ui = { period: 'all', busy: false }
let data = { overview: null, trends: null, reports: null }

function getToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY) || ''
  } catch {
    return ''
  }
}
function setToken(value) {
  try {
    if (value) sessionStorage.setItem(TOKEN_KEY, value)
    else sessionStorage.removeItem(TOKEN_KEY)
  } catch {
    // 저장소를 못 쓰면 이번 요청에만 쓴다
  }
}

const call = (path, opts = {}) => opsRequest(path, { ...opts, token: getToken() })

// ── 지표 타일 ──────────────────────────────────────────

/** 목표와 견줘 상태를 정한다. 색만으로 알리지 않고 아이콘과 글자를 함께 쓴다. */
function statusBadge(value, target, { higherIsBetter }) {
  if (value === null || value === undefined) return h('span', { class: 'badge status' }, icon('info', { size: 13 }), '아직 데이터 없음')
  const met = higherIsBetter ? value >= target : value <= target
  return met ? h('span', { class: 'badge live status' }, icon('check', { size: 13 }), '목표 달성') : h('span', { class: 'badge warn status' }, icon('alert', { size: 13 }), '목표 미달')
}

function meter(ratio, label) {
  const pct = Math.max(0, Math.min(100, Math.round((ratio || 0) * 100)))
  return h('div', { class: 'bar', role: 'img', 'aria-label': label }, h('span', { style: { width: `${pct}%` } }))
}

function kpiTile({ label, value, unit, detail, target, targetText, higherIsBetter, ratio, extra }) {
  return h(
    'article',
    { class: 'kpi' },
    h('p', { class: 'k' }, label),
    h('p', { class: 'v' }, value === null || value === undefined ? '—' : [String(value), unit ? h('span', { class: 'u' }, unit) : null]),
    ratio !== undefined ? meter(ratio, `${label} ${value ?? '없음'}${unit || ''}`) : null,
    h('p', { class: 't' }, detail),
    h('p', { class: 't' }, `임시 목표: ${targetText}`),
    statusBadge(value, target, { higherIsBetter }),
    extra || null,
  )
}

function metricsSection() {
  const o = data.overview
  const m = o.metrics[ui.period]
  const t = o.targets
  const byProfile = m.styleScore.byProfile
  const profileRow = (label, x) => h('tr', null, h('td', null, label), h('td', { class: 'num' }, x.average ?? '—'), h('td', { class: 'num' }, formatNumber(x.n)))

  return h(
    'section',
    { class: 'stack', 'aria-labelledby': 'm-title' },
    h(
      'div',
      { class: 'row between' },
      h('h2', { class: 'section-title', id: 'm-title' }, '성공 지표'),
      h(
        'div',
        { class: 'tabs', role: 'tablist', 'aria-label': '기간' },
        [
          ['all', '전체 기간'],
          ['week', '최근 7일'],
        ].map(([id, label]) =>
          h(
            'button',
            {
              class: 'tab',
              type: 'button',
              role: 'tab',
              'aria-selected': String(ui.period === id),
              onClick: () => {
                ui.period = id
                render()
              },
            },
            label,
          ),
        ),
      ),
    ),
    h(
      'div',
      { class: 'kpis' },
      kpiTile({
        label: '내 말투 같다 (5점 척도 평균)',
        value: m.styleScore.average,
        unit: '점',
        ratio: m.styleScore.average ? m.styleScore.average / 5 : 0,
        detail: `평가 ${formatNumber(m.styleScore.n)}건`,
        target: t.styleScore,
        targetText: `${t.styleScore}점 이상`,
        higherIsBetter: true,
      }),
      kpiTile({
        label: '저장·공유율',
        value: m.saveShareRate.percent,
        unit: '%',
        ratio: m.saveShareRate.percent ? m.saveShareRate.percent / 100 : 0,
        detail: `보여 준 후보 ${formatNumber(m.saveShareRate.shown)}개 중 ${formatNumber(m.saveShareRate.savedOrShared)}개를 저장하거나 공유`,
        target: t.saveShareRate,
        targetText: `${t.saveShareRate}% 이상`,
        higherIsBetter: true,
      }),
      kpiTile({
        label: '트렌드 반영 속도 (수집 → 노출, 중앙값)',
        value: m.trendLatency.medianHours,
        unit: '시간',
        detail: m.trendLatency.n ? `실수집 트렌드 ${formatNumber(m.trendLatency.n)}건 · 느린 쪽 10% ${m.trendLatency.p90Hours}시간` : '실제 수집해 노출한 트렌드가 아직 없어요(예시 데이터는 제외)',
        target: t.trendLatencyHours,
        targetText: `${t.trendLatencyHours}시간 이내`,
        higherIsBetter: false,
      }),
      kpiTile({
        label: '유해 생성물 비율',
        value: m.harmfulRate.percent,
        unit: '%',
        ratio: m.harmfulRate.percent ? Math.min(1, m.harmfulRate.percent / 100) : 0,
        detail: `만든 후보 ${formatNumber(m.harmfulRate.generated)}개 중 필터 차단 ${formatNumber(m.harmfulRate.blocked)}개 · 신고 ${formatNumber(m.harmfulRate.reported)}개`,
        target: t.harmfulRate,
        targetText: `${t.harmfulRate}% 이하`,
        higherIsBetter: false,
      }),
    ),
    h('p', { class: 'tiny muted' }, '목표값은 기획안에서 비워 둔 값이라 임시로 잡았어요. TARGET_* 환경변수로 바꿀 수 있어요.'),
    h(
      'div',
      { class: 'grid-2' },
      h(
        'div',
        { class: 'card stack-s' },
        h('h3', { class: 'card-title' }, '음성을 더하면 더 내 말투 같을까'),
        h('p', { class: 'card-sub' }, '기획안의 검증 과제예요. 프로필에 쓰인 재료별 ‘내 말투 같다’ 평균을 견줘요.'),
        h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            { class: 'data' },
            h('thead', null, h('tr', null, h('th', { scope: 'col' }, '프로필 재료'), h('th', { scope: 'col', class: 'num' }, '평균(점)'), h('th', { scope: 'col', class: 'num' }, '평가 수'))),
            h('tbody', null, profileRow('글 + 목소리', byProfile.voiceAndText), profileRow('글만', byProfile.textOnly), profileRow('목소리만', byProfile.voiceOnly), m.styleScore.samplePersona ? profileRow('예시 말투(지표에서 뺌)', m.styleScore.samplePersona) : null),
          ),
        ),
        h('p', { class: 'tiny muted' }, '평가 수가 적을 때는 차이를 믿기 어려워요.'),
      ),
      h(
        'div',
        { class: 'card stack-s' },
        h('h3', { class: 'card-title' }, '만드는 방식별 반응'),
        h('p', { class: 'card-sub' }, '좋아요·별로예요가 방식별로 쌓여 랭킹에 반영돼요.'),
        h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            { class: 'data' },
            h('thead', null, h('tr', null, h('th', { scope: 'col' }, '방식'), h('th', { scope: 'col', class: 'num' }, '좋아요'), h('th', { scope: 'col', class: 'num' }, '별로예요'), h('th', { scope: 'col', class: 'num' }, '좋아요 비율'))),
            h(
              'tbody',
              null,
              Object.entries(TECHNIQUES).map(([id, meta]) => {
                const x = m.techniques[id] || { up: 0, down: 0 }
                const total = x.up + x.down
                return h('tr', null, h('td', null, meta.label), h('td', { class: 'num' }, formatNumber(x.up)), h('td', { class: 'num' }, formatNumber(x.down)), h('td', { class: 'num' }, total ? `${Math.round((x.up / total) * 100)}%` : '—'))
              }),
            ),
          ),
        ),
        h(
          'p',
          { class: 'tiny muted' },
          `생성 ${formatNumber(m.counts.generations)}회 · AI 엔진 ${formatNumber(m.counts.llmRuns)}회 · 기본 엔진 대체 ${formatNumber(m.counts.fallbacks)}회 · 좋아요 ${formatNumber(m.counts.likes)} · 별로예요 ${formatNumber(m.counts.dislikes)}`,
        ),
      ),
    ),
  )
}

// ── 엔진·수집 상태 ──────────────────────────────────────────

function systemSection() {
  const o = data.overview
  const p = o.pipeline || {}
  const last = p.lastRun
  const llm = o.engine.llm || {}
  const ig = o.instagram
  const row = (k, v) => h('tr', null, h('th', { scope: 'row' }, k), h('td', null, v))

  async function collect() {
    if (ui.busy) return
    ui.busy = true
    render()
    try {
      const { report } = await call('/api/ops/collect', { method: 'POST', body: {} })
      toast(report.ok ? `수집 완료 · 새 트렌드 ${report.added}건, 갱신 ${report.updated}건, 필터 차단 ${report.blocked}건` : `수집하지 못했어요: ${(report.errors || []).join(' / ') || '원인 미상'}`, { type: report.ok ? 'ok' : 'error', ms: 6000 })
    } catch (err) {
      toast(err.message, { type: 'error', ms: 6000 })
    } finally {
      ui.busy = false
      await load()
    }
  }

  return h(
    'section',
    { class: 'stack', 'aria-labelledby': 's-title' },
    h('h2', { class: 'section-title', id: 's-title' }, '엔진과 트렌드 수집'),
    h(
      'div',
      { class: 'grid-2' },
      h(
        'div',
        { class: 'card stack-s' },
        h('h3', { class: 'card-title' }, '생성 엔진'),
        h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            { class: 'plain' },
            h(
              'tbody',
              null,
              row('지금 엔진', o.engine.label),
              row('모델', llm.enabled ? llm.model || '—' : `— (키를 넣으면 ${llm.model || 'claude-opus-5-5'})`),
              row('상태', o.engine.mode === 'llm' ? '사용 가능' : llm.enabled ? `사용 불가 — ${llm.reason || '원인 미상'}` : '키 없음(기본 엔진으로 동작)'),
              row('오늘 호출', `${formatNumber(llm.callsToday || 0)} / ${formatNumber(llm.dailyCap || 0)}회`),
              row('AI 안전 심사', o.config.llm.safetyJudge ? '켜짐' : '꺼짐'),
            ),
          ),
        ),
      ),
      h(
        'div',
        { class: 'card stack-s' },
        h('h3', { class: 'card-title' }, '트렌드 수집'),
        h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            { class: 'plain' },
            h(
              'tbody',
              null,
              row('YouTube 수집', p.enabled ? `켜짐 · ${o.config.trends.refreshMinutes}분마다` : '꺼짐(YOUTUBE_API_KEY 없음) — 예시 데이터만 노출'),
              row('검수 방식', o.config.trends.reviewMode === 'manual' ? '사람 검수 후 노출' : '금칙어 필터만 통과하면 자동 노출'),
              row('마지막 수집', last ? `${formatDateTime(last.finishedAt)} · ${last.ok ? '성공' : '실패'} · 영상 ${last.videos ?? 0}개 → 키워드 ${last.drafts ?? 0}개(차단 ${last.blocked ?? 0}) · 추출 ${last.extractor === 'llm' ? 'AI' : last.extractor === 'rules' ? '규칙' : '없음'}` : '아직 없음'),
              last && last.errors?.length ? row('오류', last.errors.join(' / ')) : null,
              row('다음 수집', p.nextRunAt ? formatDateTime(p.nextRunAt) : '—'),
              row('YouTube 쿼터', p.quota ? `오늘 ${formatNumber(p.quota.used)} / ${formatNumber(p.quota.budget)} 단위 사용` : '—'),
              row('보관 기간', `트렌드 ${o.config.trends.ttlDays}일(YouTube 정책상 30일 이내) · 반응·생성 기록 ${o.config.retention?.events ?? '-'}일 · 신고 ${o.config.retention?.reports ?? '-'}일`),
              row('운영 화면 보호', o.config.security?.adminToken ? '운영 토큰 사용' : '토큰 없음 — 이 컴퓨터에서 localhost로 연 경우에만 열림'),
              row('인스타그램', ig.enabled ? (ig.budget ? `켜짐 · 최근 7일 해시태그 ${ig.budget.used} / ${ig.budget.limit}개 사용` : '켜짐') : '꺼짐'),
            ),
          ),
        ),
        h('div', null, h('button', { class: 'btn dark small', type: 'button', disabled: ui.busy || !p.enabled, onClick: collect }, icon('refresh'), ui.busy ? '수집하는 중…' : '지금 수집하기')),
      ),
    ),
  )
}

// ── 트렌드 검수 ──────────────────────────────────────────

async function setTrendStatus(trend, status, edits) {
  try {
    await call(`/api/ops/trends/${encodeURIComponent(trend.id)}`, { method: 'POST', body: { status, edits } })
    toast(status === 'approved' ? `‘${trend.keyword}’${josa(trend.keyword, '을/를')} 노출했어요.` : status === 'rejected' ? `‘${trend.keyword}’${josa(trend.keyword, '을/를')} 숨겼어요.` : `‘${trend.keyword}’${josa(trend.keyword, '을/를')} 검수 대기로 돌렸어요.`, { type: 'ok' })
  } catch (err) {
    toast(err.message, { type: 'error' })
  }
  await load()
}

function pendingCard(trend) {
  const fid = (name) => `t-${trend.id}-${name}`
  const readEdits = () => ({
    meaning: document.getElementById(fid('meaning'))?.value || '',
    origin: document.getElementById(fid('origin'))?.value || '',
    caution: document.getElementById(fid('caution'))?.value || '',
    category: document.getElementById(fid('category'))?.value || trend.category,
  })
  return h(
    'article',
    { class: 'card stack-s', 'aria-label': trend.keyword },
    h('div', { class: 'row' }, h('span', { class: 'badge live' }, 'YouTube 인기 차트'), h('span', { class: 'badge' }, trend.kind), h('span', { class: 'tiny muted' }, `수집 ${formatDateTime(trend.collectedAt)}`)),
    h('h3', { class: 'card-title' }, trend.keyword),
    trend.source?.url ? h('a', { class: 'linkish', href: trend.source.url, target: '_blank', rel: 'noopener noreferrer' }, 'YouTube에서 영상 보기', icon('external', { size: 13 })) : null,
    h('div', { class: 'field' }, h('label', { for: fid('meaning') }, '뜻 요약'), h('input', { class: 'input', id: fid('meaning'), type: 'text', maxLength: 300, value: trend.meaning || '', placeholder: '영상을 확인하고 뜻을 적어 주세요' })),
    h('div', { class: 'field' }, h('label', { for: fid('origin') }, '유래·맥락'), h('input', { class: 'input', id: fid('origin'), type: 'text', maxLength: 300, value: trend.origin || '' })),
    h('div', { class: 'field' }, h('label', { for: fid('caution') }, '쓸 때 주의'), h('input', { class: 'input', id: fid('caution'), type: 'text', maxLength: 300, value: trend.caution || '' })),
    h(
      'div',
      { class: 'field' },
      h('label', { for: fid('category') }, '분류'),
      h('select', { class: 'select', id: fid('category') }, TREND_CATEGORIES.map((c) => h('option', { value: c, selected: c === trend.category }, c))),
    ),
    h(
      'div',
      { class: 'row end' },
      h('button', { class: 'btn danger small', type: 'button', onClick: () => setTrendStatus(trend, 'rejected', {}) }, '숨기기'),
      h('button', { class: 'btn dark small', type: 'button', onClick: () => setTrendStatus(trend, 'approved', readEdits()) }, icon('check'), '승인하고 노출'),
    ),
  )
}

function reviewSection() {
  const t = data.trends
  const smallTable = (list, action) =>
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        { class: 'data' },
        h('thead', null, h('tr', null, h('th', { scope: 'col' }, '키워드'), h('th', { scope: 'col' }, '뜻'), h('th', { scope: 'col' }, '수집'), h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, '작업')))),
        h(
          'tbody',
          null,
          list.map((trend) =>
            h(
              'tr',
              null,
              h('td', null, trend.keyword),
              h('td', null, trend.meaning || h('span', { class: 'muted' }, '뜻 없음')),
              h('td', { class: 'nowrap' }, formatDateTime(trend.collectedAt)),
              h('td', null, h('button', { class: 'btn ghost small', type: 'button', onClick: () => setTrendStatus(trend, action.status, {}) }, action.label)),
            ),
          ),
        ),
      ),
    )

  return h(
    'section',
    { class: 'stack', 'aria-labelledby': 'r-title' },
    h('h2', { class: 'section-title', id: 'r-title' }, '트렌드 검수'),
    h('p', { class: 'muted' }, `수집한 키워드는 금칙어 필터를 거친 뒤 여기에서 사람이 확인해요. 뜻과 유래를 모르는 말, 실존 인물 이름, 사건·사고는 숨겨 주세요. 예시 데이터 ${t.seedCount}건은 따로 관리돼요.`),
    h('h3', { class: 'card-title' }, `검수 대기 ${t.pending.length}건`),
    t.pending.length ? h('div', { class: 'grid-cards' }, t.pending.map(pendingCard)) : h('p', { class: 'muted' }, '검수할 트렌드가 없어요.'),
    h('details', { class: 'fold' }, h('summary', null, `노출 중 ${t.approved.length}건`), h('div', { class: 'fold-body' }, t.approved.length ? smallTable(t.approved, { status: 'rejected', label: '숨기기' }) : h('p', { class: 'muted' }, '없음'))),
    h('details', { class: 'fold' }, h('summary', null, `숨김 ${t.rejected.length}건`), h('div', { class: 'fold-body' }, t.rejected.length ? smallTable(t.rejected, { status: 'pending', label: '검수 대기로' }) : h('p', { class: 'muted' }, '없음'))),
  )
}

// ── 신고 ──────────────────────────────────────────

function reportsSection() {
  const reasons = Object.fromEntries(REPORT_REASONS.map((r) => [r.id, r.label]))
  const list = data.reports || []
  return h(
    'section',
    { class: 'stack', 'aria-labelledby': 'rp-title' },
    h('h2', { class: 'section-title', id: 'rp-title' }, `신고 ${list.length}건`),
    list.length
      ? h(
          'div',
          { class: 'card table-wrap' },
          h(
            'table',
            { class: 'data' },
            h('thead', null, h('tr', null, ['시각', '사유', '문구', '밈', '엔진', '덧붙인 말'].map((x) => h('th', { scope: 'col' }, x)))),
            h(
              'tbody',
              null,
              list.map((r) =>
                h('tr', null, h('td', { class: 'nowrap' }, formatDateTime(new Date(r.ts).toISOString())), h('td', null, reasons[r.reason] || r.reason), h('td', null, r.text), h('td', null, r.trendKeyword || '—'), h('td', null, r.engine === 'llm' ? 'AI' : '기본'), h('td', null, r.note || '—')),
              ),
            ),
          ),
        )
      : h('p', { class: 'muted' }, '접수된 신고가 없어요.'),
  )
}

// ── 화면 ──────────────────────────────────────────

function tokenForm(message) {
  return h(
    'div',
    { class: 'wrap stack' },
    h(
      'form',
      {
        class: 'card stack',
        onSubmit: (e) => {
          e.preventDefault()
          setToken(document.getElementById('ops-token')?.value || '')
          load()
        },
      },
      h('h1', { class: 'card-title' }, '운영 토큰이 필요해요'),
      h('p', { class: 'muted' }, message),
      h('div', { class: 'field' }, h('label', { for: 'ops-token' }, '운영 토큰(ADMIN_TOKEN)'), h('input', { class: 'input', id: 'ops-token', type: 'password', autocomplete: 'off', required: true })),
      h('div', { class: 'row end' }, h('button', { class: 'btn dark', type: 'submit' }, '확인')),
    ),
  )
}

/** 검수 카드에 적고 있던 내용(뜻·유래·주의·분류)을 다시 그려도 잃지 않도록 모아 둔다. */
function collectReviewDrafts() {
  const drafts = new Map()
  for (const el of main.querySelectorAll('input[id^="t-"], select[id^="t-"]')) drafts.set(el.id, el.value)
  return drafts
}

function restoreReviewDrafts(drafts) {
  for (const [id, value] of drafts) {
    const el = document.getElementById(id)
    if (el) el.value = value
  }
}

function render() {
  if (!data.overview) return
  const drafts = collectReviewDrafts()
  const o = data.overview
  const brand = document.getElementById('ops-brand')
  if (brand) brand.textContent = o.config.serviceName
  document.title = `운영 화면 · ${o.config.serviceName}`
  mount(
    main,
    h(
      'div',
      { class: 'wrap stack-l' },
      h(
        'header',
        { class: 'page-head' },
        h('h1', null, '운영 화면'),
        h('p', null, '사용자 테스트 지표를 재고, 수집한 트렌드를 검수하고, 신고를 확인해요.'),
        h(
          'div',
          null,
          h(
            'button',
            { class: 'btn outline small', type: 'button', onClick: () => load().then(() => toast('새로 불러왔어요.')) },
            icon('refresh'),
            '새로 고침',
          ),
        ),
      ),
      metricsSection(),
      systemSection(),
      reviewSection(),
      reportsSection(),
    ),
  )
  restoreReviewDrafts(drafts)
}

async function load() {
  try {
    const [overview, trends, reports] = await Promise.all([call('/api/ops/overview'), call('/api/ops/trends'), call('/api/ops/reports')])
    data = { overview, trends, reports: reports.reports }
    render()
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      setToken('')
      mount(main, tokenForm('서버에 ADMIN_TOKEN이 설정돼 있어요. 토큰을 입력해 주세요.'))
      return
    }
    mount(main, h('div', { class: 'wrap' }, h('div', { class: 'notice danger' }, icon('alert'), h('p', null, err.message || '운영 정보를 불러오지 못했어요.'))))
  }
}

load()
