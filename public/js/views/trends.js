// 3단계 · 트렌드 고르기: 오늘의 이슈·밈 목록에서 하나를 고른다. 출처 링크와 뜻 요약을 함께 보여 준다.
import { h, icon, formatDateTime, mount } from '/js/dom.js'
import { getState, update } from '/js/store.js'
import { api } from '/js/api.js'
import { toast } from '/js/ui.js'
import { LIMITS } from '/shared/constants.js'
import { josa } from '/shared/hangul.js'

// 화면을 오갈 때마다 다시 받지 않도록 잠깐 기억해 둔다
const cache = { items: null, status: null, at: 0, loading: false, error: '' }
const ui = { query: '', category: '전체', customOpen: false }
const CACHE_MS = 60_000

export function findTrend(id, s = getState()) {
  if (!id) return null
  return (cache.items || []).find((t) => t.id === id) || s.customTrends.find((t) => t.id === id) || null
}

/** 다른 화면(생성)에서 고른 트렌드를 다시 찾을 때 쓴다. */
export async function loadTrends({ force = false } = {}) {
  if (!force && cache.items && Date.now() - cache.at < CACHE_MS) return cache.items
  cache.loading = true
  try {
    const data = await api.trends()
    cache.items = data.items || []
    cache.status = data.status || null
    cache.at = Date.now()
    cache.error = ''
  } catch (err) {
    cache.error = err.message
    if (!cache.items) cache.items = []
  } finally {
    cache.loading = false
  }
  return cache.items
}

function sourceBadge(trend) {
  const type = trend.source?.type
  if (type === 'youtube') return h('span', { class: 'badge live' }, 'YouTube 인기 차트')
  if (type === 'custom') return h('span', { class: 'badge' }, '직접 입력')
  return h('span', { class: 'badge sample' }, trend.kind === 'keyword' ? '시즌 키워드 예시' : '예시 데이터')
}

function sourceLine(trend) {
  const src = trend.source || {}
  const bits = []
  if (src.url) {
    const label = src.type === 'youtube' ? 'YouTube에서 영상 보기' : `출처: ${src.title || '기사 보기'}`
    bits.push(h('a', { class: 'linkish', href: src.url, target: '_blank', rel: 'noopener noreferrer' }, label, icon('external', { size: 13 }), h('span', { class: 'sr-only' }, '(새 창)')))
  } else if (src.type === 'seed') {
    bits.push(h('span', { class: 'tiny muted' }, '출처 링크 없음(계절 키워드 예시)'))
  }
  if (src.type === 'youtube' && trend.collectedAt) bits.push(h('span', { class: 'tiny muted' }, `수집 ${formatDateTime(trend.collectedAt)}`))
  if (trend.instagram) {
    bits.push(h('span', { class: 'tiny muted' }, `Instagram #${trend.instagram.tag} 인기 게시물 ${trend.instagram.mediaCount}개 확인 (${formatDateTime(trend.instagram.checkedAt)})`))
  }
  return bits
}

export function trendsView(ctx) {
  const s = getState()

  if (!cache.items && !cache.loading) {
    loadTrends().then(() => ctx.rerender())
  }

  const all = [...s.customTrends, ...(cache.items || [])]
  const categories = ['전체', ...new Set(all.map((t) => t.category).filter(Boolean))]
  if (!categories.includes(ui.category)) ui.category = '전체'
  const visibleTrends = () => {
    const q = ui.query.trim().toLowerCase()
    return all.filter((t) => {
      if (ui.category !== '전체' && t.category !== ui.category) return false
      if (!q) return true
      return [t.keyword, t.pattern, t.meaning].some((v) => String(v || '').toLowerCase().includes(q))
    })
  }
  const selected = findTrend(s.selectedTrendId, s)

  function select(trend) {
    update({ selectedTrendId: trend.id })
    ctx.rerender()
  }

  function trendCard(trend) {
    const isSelected = s.selectedTrendId === trend.id
    const unverified = trend.source?.type === 'youtube' && !trend.meaningVerified
    // 수집 단계에서 AI가 쓴 뜻을 사람이 아직 확인하지 않았다면 그 사실을 같이 보인다
    const aiMeaning = unverified && Boolean(trend.meaning)
    return h(
      'article',
      { class: 'trend-card', dataset: { selected: String(isSelected) }, 'aria-label': trend.keyword },
      h(
        'div',
        { class: 'row' },
        sourceBadge(trend),
        trend.category ? h('span', { class: 'badge' }, trend.category) : null,
        aiMeaning ? h('span', { class: 'badge ai', title: '뜻·유래를 AI가 정리했고 사람이 아직 확인하지 않았어요' }, 'AI 요약 · 확인 전') : unverified ? h('span', { class: 'badge warn' }, '뜻 미확인') : null,
      ),
      h('h3', { class: 'kw' }, trend.keyword),
      trend.pattern ? h('div', null, h('span', { class: 'pattern' }, trend.pattern.replaceAll('{X}', '○○').replaceAll('{Y}', '△△'))) : null,
      trend.meaning
        ? h('p', { class: 'meaning' }, trend.meaning)
        : h('p', { class: 'meaning muted' }, trend.source?.type === 'youtube' ? '제목·태그에서 뽑은 키워드예요. 뜻과 맥락은 영상에서 직접 확인해 주세요.' : '뜻 설명이 없는 키워드예요.'),
      trend.origin ? h('details', { class: 'fold' }, h('summary', null, '유래·맥락'), h('div', { class: 'fold-body' }, h('p', { class: 'origin' }, trend.origin), trend.period ? h('p', { class: 'tiny muted' }, `시기: ${trend.period}`) : null)) : null,
      trend.caution ? h('p', { class: 'caution' }, h('strong', null, '쓸 때 주의 · '), trend.caution) : null,
      h(
        'div',
        { class: 'foot' },
        h('div', { class: 'stack-s' }, sourceLine(trend)),
        h(
          'div',
          { class: 'row' },
          trend.source?.type === 'custom'
            ? h(
                'button',
                {
                  class: 'btn ghost small',
                  type: 'button',
                  'aria-label': `${trend.keyword} 지우기`,
                  onClick: () => {
                    update((st) => ({ customTrends: st.customTrends.filter((t) => t.id !== trend.id), selectedTrendId: st.selectedTrendId === trend.id ? null : st.selectedTrendId }))
                    ctx.rerender()
                  },
                },
                icon('trash'),
              )
            : null,
          h(
            'button',
            { class: `btn ${isSelected ? 'dark' : 'outline'} small`, type: 'button', 'aria-pressed': String(isSelected), onClick: () => select(trend) },
            isSelected ? [icon('check'), '골랐어요'] : '이 트렌드 고르기',
          ),
        ),
      ),
    )
  }

  async function addCustom(e) {
    e.preventDefault()
    const keyword = document.getElementById('custom-keyword')?.value.trim() || ''
    const meaning = document.getElementById('custom-meaning')?.value.trim() || ''
    if (!keyword) {
      toast('키워드를 입력해 주세요.')
      return
    }
    const btn = document.getElementById('custom-submit')
    if (btn) btn.disabled = true
    try {
      const { trend } = await api.checkTrend({ keyword, meaning })
      update((st) => ({ customTrends: [trend, ...st.customTrends.filter((t) => t.keyword !== trend.keyword)].slice(0, 10), selectedTrendId: trend.id }))
      ui.customOpen = false
      toast(`‘${trend.keyword}’${josa(trend.keyword, '을/를')} 넣고 골랐어요.`, { type: 'ok' })
      ctx.rerender()
    } catch (err) {
      toast(err.message, { type: 'error', ms: 5000 })
      if (btn) btn.disabled = false
    }
  }

  function statusLine() {
    const st = cache.status
    if (!st) return null
    const bits = []
    if (st.youtubeEnabled) {
      bits.push(`YouTube 인기 차트 수집 중${st.lastRunAt ? ` · 마지막 수집 ${formatDateTime(st.lastRunAt)}` : ''}`)
      if (st.pending > 0) bits.push(`검수 대기 ${st.pending}건(운영 화면에서 승인하면 여기에 나타나요)`)
    } else {
      bits.push('지금은 예시 데이터예요(2026-11-11에 공개 기사·사전으로 뜻과 유래를 확인해 정리). 실시간 순위가 아니며, 운영자가 YouTube API 키를 넣으면 실제 수집 데이터가 함께 보여요.')
    }
    return h('div', { class: 'notice' }, icon('info'), h('p', null, bits.join(' · ')))
  }

  function customForm() {
    if (!ui.customOpen) {
      return h(
        'button',
        {
          class: 'btn outline',
          type: 'button',
          onClick: () => {
            ui.customOpen = true
            ctx.rerender()
            document.getElementById('custom-keyword')?.focus()
          },
        },
        icon('plus'),
        '목록에 없는 밈 직접 넣기',
      )
    }
    return h(
      'form',
      { class: 'card stack', onSubmit: addCustom, 'aria-labelledby': 'custom-title' },
      h('h2', { class: 'card-title', id: 'custom-title' }, '트렌드 직접 넣기'),
      h(
        'div',
        { class: 'grid-2' },
        h('div', { class: 'field' }, h('label', { for: 'custom-keyword' }, '밈·키워드'), h('input', { class: 'input', id: 'custom-keyword', type: 'text', maxLength: LIMITS.customTrend.keywordMaxChars, placeholder: '예: 요즘 본 밈 문구', autocomplete: 'off', required: true })),
        h('div', { class: 'field' }, h('label', { for: 'custom-meaning' }, '뜻 (선택)'), h('input', { class: 'input', id: 'custom-meaning', type: 'text', maxLength: LIMITS.customTrend.meaningMaxChars, placeholder: '어떤 상황에서 쓰는 말인지', autocomplete: 'off' })),
      ),
      h('p', { class: 'help' }, '뜻과 유래를 아는 말만 넣어 주세요. 실존 인물 이름, 혐오·비하 표현, 사건·사고는 쓸 수 없어요(안전 필터가 걸러요).'),
      h(
        'div',
        { class: 'row end' },
        h(
          'button',
          {
            class: 'btn ghost',
            type: 'button',
            onClick: () => {
              ui.customOpen = false
              ctx.rerender()
            },
          },
          '취소',
        ),
        h('button', { class: 'btn dark', type: 'submit', id: 'custom-submit' }, '넣고 고르기'),
      ),
    )
  }

  function buildList() {
    const visible = visibleTrends()
    if (cache.loading && !cache.items) return h('p', { class: 'muted' }, '트렌드를 불러오는 중…')
    if (cache.error && !all.length) return errorBox()
    if (!visible.length) return h('div', { class: 'empty-state' }, h('h2', null, '조건에 맞는 트렌드가 없어요'), h('p', null, '검색어나 분류를 바꾸거나, 목록에 없는 밈을 직접 넣어 보세요.'))
    return h('div', { class: 'grid-cards' }, visible.map(trendCard))
  }

  // 검색은 목록만 다시 그린다. 화면 전체를 다시 그리면 한글 조합(IME)이 끊긴다.
  function paintList() {
    const box = document.getElementById('trend-list')
    if (box) mount(box, buildList())
  }

  function errorBox() {
    return h(
      'div',
      { class: 'notice danger' },
      icon('alert'),
      h(
        'div',
        { class: 'stack-s' },
        h('p', null, `트렌드를 불러오지 못했어요. ${cache.error}`),
        h(
          'button',
          {
            class: 'btn outline small',
            type: 'button',
            onClick: () => loadTrends({ force: true }).then(() => ctx.rerender()),
          },
          icon('refresh'),
          '다시 불러오기',
        ),
      ),
    )
  }

  return h(
    'div',
    { class: 'wrap stack' },
    h(
      'header',
      { class: 'page-head' },
      h('p', { class: 'eyebrow' }, '3단계'),
      h('h1', null, '트렌드 고르기'),
      h('p', null, '오늘의 이슈·밈 가운데 하나를 골라 주세요. 뜻과 유래, 쓸 때 주의할 점을 먼저 확인할 수 있어요.'),
    ),
    statusLine(),
    h(
      'div',
      { class: 'toolbar' },
      h('label', { class: 'sr-only', for: 'trend-search' }, '트렌드 검색'),
      h('input', {
        class: 'input',
        id: 'trend-search',
        type: 'search',
        placeholder: '밈·뜻으로 찾기',
        value: ui.query,
        onInput: (e) => {
          ui.query = e.target.value
          // 한글을 조합하는 중에는 기다렸다가 조합이 끝나면(compositionend) 거른다
          if (!e.isComposing) paintList()
        },
        onCompositionend: (e) => {
          ui.query = e.target.value
          paintList()
        },
      }),
      h(
        'button',
        {
          class: 'btn ghost small',
          type: 'button',
          onClick: () => loadTrends({ force: true }).then(() => ctx.rerender()),
        },
        icon('refresh'),
        '새로 고침',
      ),
    ),
    h(
      'div',
      { class: 'row', role: 'group', 'aria-label': '분류' },
      categories.map((c) =>
        h(
          'button',
          {
            class: 'chip',
            type: 'button',
            'aria-pressed': String(ui.category === c),
            onClick: () => {
              ui.category = c
              ctx.rerender()
            },
          },
          c,
        ),
      ),
    ),
    h('div', { id: 'trend-list' }, buildList()),
    customForm(),
    cache.status?.youtubeEnabled
      ? h(
          'p',
          { class: 'tiny muted' },
          'YouTube 인기 차트 항목은 YouTube API 서비스로 가져온 영상 제목·태그에서 이 서비스가 자체적으로 뽑은 키워드이며, YouTube가 제공한 순위나 지표가 아닙니다. ',
          h('a', { href: 'https://www.youtube.com/t/terms', target: '_blank', rel: 'noopener noreferrer' }, 'YouTube 서비스 약관'),
          ' · ',
          h('a', { href: 'http://www.google.com/policies/privacy', target: '_blank', rel: 'noopener noreferrer' }, 'Google 개인정보처리방침'),
        )
      : null,
    h(
      'div',
      { class: 'actionbar' },
      h(
        'div',
        { class: 'actionbar-inner' },
        h('p', { class: 'hint', 'aria-live': 'polite' }, selected ? `고른 트렌드: ${selected.keyword}` : '트렌드를 하나 골라 주세요.'),
        h(
          'button',
          { class: 'btn primary big', type: 'button', disabled: !selected, onClick: () => ctx.navigate('#/generate') },
          '이 트렌드로 유행어 만들기',
          icon('arrowRight'),
        ),
      ),
    ),
  )
}
