// 4단계 · 유행어 생성: 고른 트렌드와 내 말투를 확인하고, 쓰임새와 맛을 정해 후보를 만든다.
import { h, icon } from '../dom.js'
import { getState, update, rememberShown } from '../store.js'
import { api } from '../api.js'
import { toast } from '../ui.js'
import { LIMITS, SITUATIONS, SPICE_LEVELS } from '../../shared/constants.js'
import { profileToPayload } from '../../shared/style-analyzer.js'
import { findTrend, loadTrends } from './trends.js'
import { aiNoticeBox } from '../notices.js'

const PIPELINE = ['프롬프트 구성', '유행어 후보 생성', '안전 필터', '랭킹']
const run = { busy: false, step: -1, auto: false }

/** 결과 화면의 ‘다시 만들기’가 부른다 — 생성 화면에 들어오자마자 바로 만든다. */
export function requestAutoGenerate() {
  run.auto = true
}

function paintPipeline() {
  const list = document.getElementById('pipeline')
  if (!list) return
  ;[...list.children].forEach((li, i) => {
    li.dataset.state = i < run.step ? 'done' : i === run.step ? 'on' : 'todo'
    const spinner = li.querySelector('.spinner')
    if (spinner) spinner.hidden = i !== run.step
  })
}

export function generateView(ctx) {
  const s = getState()
  const profile = s.profile
  const trend = findTrend(s.selectedTrendId, s)

  // 새로 고침 직후에는 트렌드 목록이 아직 없을 수 있다
  if (!trend) {
    loadTrends().then(() => {
      if (findTrend(getState().selectedTrendId)) ctx.rerender()
      else {
        update({ selectedTrendId: null })
        toast('고른 트렌드를 찾을 수 없어요. 다시 골라 주세요.')
        ctx.navigate('#/trends')
      }
    })
    return h('div', { class: 'wrap' }, h('p', { class: 'muted' }, '고른 트렌드를 불러오는 중…'))
  }

  const engine = ctx.status?.engine
  const options = s.options

  function setOption(patch) {
    update((st) => ({ options: { ...st.options, ...patch } }))
    ctx.rerender()
  }

  function optionGroup(title, items, key) {
    return h(
      'div',
      { class: 'option-group', role: 'group', 'aria-label': title },
      h('p', { class: 'label' }, title),
      h(
        'div',
        { class: 'option-row' },
        items.map((item) =>
          h(
            'button',
            { class: 'option', type: 'button', 'aria-pressed': String(options[key] === item.id), disabled: run.busy, onClick: () => setOption({ [key]: item.id }) },
            h('span', { class: 't' }, item.label),
            h('span', { class: 'd' }, item.hint),
          ),
        ),
      ),
    )
  }

  async function generate() {
    if (run.busy) return
    const now = getState()
    const topic = (document.getElementById('topic')?.value || '').trim().slice(0, 20)
    if (topic !== now.options.topic) update((st) => ({ options: { ...st.options, topic } }))

    run.busy = true
    run.step = 0
    ctx.rerender()
    // 요청은 한 번이지만, 서버 안에서 거치는 네 단계를 눈으로 따라갈 수 있게 보여 준다
    const stepTimer = setTimeout(() => {
      if (run.busy && run.step === 0) {
        run.step = 1
        paintPipeline()
      }
    }, 500)

    const isCustom = trend.source?.type === 'custom'
    const stillHere = () => location.hash === '#/generate'
    // 기다리는 동안 ‘전부 지우기’를 했다면 익명 ID가 바뀐다 — 그때 도착한 결과는 버린다
    const stillSameUser = () => getState().anonId === now.anonId && Boolean(getState().profile)
    try {
      const result = await api.generate({
        anonId: now.anonId,
        profile: profileToPayload(now.profile),
        trendId: isCustom ? undefined : trend.id,
        customTrend: isCustom ? { keyword: trend.keyword, meaning: trend.meaning } : undefined,
        options: { situation: now.options.situation, spice: now.options.spice, topic },
        feedback: now.feedback,
        // 예시 말투로 만든 결과는 ‘내 말투 같다’ 지표에서 따로 센다
        sampleProfile: Boolean(now.profile?.sample),
      })
      clearTimeout(stepTimer)
      if (!stillSameUser()) return
      if (stillHere()) {
        run.step = 2
        paintPipeline()
        await new Promise((r) => setTimeout(r, 260))
        run.step = 3
        paintPipeline()
        await new Promise((r) => setTimeout(r, 260))
      }
      if (!result.candidates?.length) {
        toast('안전 필터를 통과한 후보가 없었어요. 옵션이나 트렌드를 바꿔 다시 시도해 주세요.', { type: 'error', ms: 5000 })
        return
      }
      if (!stillSameUser()) return
      update({ result })
      rememberShown(result.candidates)
      ctx.refreshStatus()
      run.busy = false
      run.step = -1
      // 다른 화면으로 옮겼다면 억지로 데려오지 않고 알려만 준다
      if (stillHere()) ctx.navigate('#/result')
      else toast('유행어를 다 만들었어요. ‘반응·공유’ 단계에서 볼 수 있어요.', { type: 'ok', ms: 4500 })
    } catch (err) {
      clearTimeout(stepTimer)
      if (stillSameUser()) toast(err.message || '유행어를 만들지 못했어요.', { type: 'error', ms: 5500 })
    } finally {
      if (run.busy) {
        run.busy = false
        run.step = -1
        if (stillHere()) ctx.rerender()
      }
    }
  }

  const endings = (profile.endings || []).slice(0, 3).map((e) => `~${e.form}`)
  const fillers = (profile.fillers || []).slice(0, 2).map((f) => f.form)

  const view = h(
    'div',
    { class: 'wrap stack' },
    h(
      'header',
      { class: 'page-head' },
      h('p', { class: 'eyebrow' }, '4단계'),
      h('h1', null, '유행어 생성'),
      h('p', null, '내 말투와 고른 트렌드를 섞어 후보 여러 개와 쓰임새 예문을 만들어요. 안전 필터를 통과한 결과만 보여 드려요.'),
    ),
    aiNoticeBox(engine),
    h(
      'section',
      { class: 'picked', 'aria-label': '섞을 재료' },
      h(
        'div',
        { class: 'box stack-s' },
        h('span', { class: 'k' }, '내 말투'),
        h('span', { class: 'v' }, profile.summary?.line || '내 말투 프로필'),
        h('div', { class: 'row' }, [...endings, ...fillers].map((t) => h('span', { class: 'badge' }, t)), profile.sample ? h('span', { class: 'badge sample' }, '예시 말투') : null),
        h('a', { class: 'linkish', href: '#/profile' }, '프로필 고치기'),
      ),
      h('div', { class: 'times', 'aria-hidden': 'true' }, '×'),
      h(
        'div',
        { class: 'box stack-s' },
        h('span', { class: 'k' }, '고른 트렌드'),
        h('span', { class: 'v' }, trend.keyword),
        trend.meaning ? h('span', { class: 'small muted' }, trend.meaning) : null,
        trend.caution ? h('span', { class: 'tiny' }, h('strong', null, '주의 · '), trend.caution) : null,
        h('a', { class: 'linkish', href: '#/trends' }, '다른 트렌드 고르기'),
      ),
    ),
    h(
      'section',
      { class: 'card stack', 'aria-labelledby': 'opt-title' },
      h('h2', { class: 'card-title', id: 'opt-title' }, '어떻게 만들까요?'),
      optionGroup('어디에 쓸 건가요', SITUATIONS, 'situation'),
      optionGroup('밈을 얼마나 섞을까요', SPICE_LEVELS, 'spice'),
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'topic' }, '넣고 싶은 말 (선택)'),
        h('input', {
          class: 'input',
          id: 'topic',
          type: 'text',
          maxLength: 20,
          placeholder: '예: 떡볶이, 월요일, 시험',
          value: options.topic || '',
          disabled: run.busy,
          autocomplete: 'off',
          // 다른 옵션을 눌러 화면이 다시 그려져도 입력한 말이 남도록 바로 저장한다
          onInput: (e) => update((st) => ({ options: { ...st.options, topic: e.target.value.slice(0, 20) } })),
          onKeydown: (e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              generate()
            }
          },
        }),
        h('p', { class: 'help' }, '밈 문형의 빈칸에 들어갈 낱말이에요. 비워 두면 알아서 채워요. 사람 이름이나 상호는 넣지 말아 주세요.'),
      ),
    ),
    run.busy
      ? h(
          'section',
          { class: 'card stack', 'aria-live': 'polite' },
          h('h2', { class: 'card-title' }, '만드는 중이에요'),
          h(
            'ol',
            { class: 'pipeline', id: 'pipeline' },
            PIPELINE.map((label, i) => h('li', { dataset: { state: 'todo' } }, h('span', { class: 'n' }, i + 1), h('span', null, label), h('span', { class: 'spinner', hidden: true }))),
          ),
          h('p', { class: 'small muted' }, engine?.mode === 'llm' ? 'AI 엔진은 10~40초쯤 걸릴 수 있어요.' : '금방 끝나요.'),
        )
      : null,
    h(
      'div',
      { class: 'actionbar' },
      h(
        'div',
        { class: 'actionbar-inner' },
        h('p', { class: 'hint' }, `후보 ${LIMITS.candidates.count}개와 후보마다 예문 ${LIMITS.candidates.examplesPerCandidate}개를 만들어요.`),
        h('button', { class: 'btn primary big', type: 'button', disabled: run.busy, onClick: generate }, icon('sparkle'), run.busy ? '만드는 중…' : '유행어 만들기'),
      ),
    ),
  )
  if (run.busy) queueMicrotask(paintPipeline)
  if (run.auto && !run.busy) {
    run.auto = false
    queueMicrotask(generate)
  }
  return view
}
