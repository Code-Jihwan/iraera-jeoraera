// 2단계 · 말투 프로필: 자주 쓰는 표현·어미·추임새를 카드로 보여 주고, 사용자가 직접 고치거나 지울 수 있다.
import { h, icon, formatDateTime } from '../dom.js'
import { getState, update, clearProfile } from '../store.js'
import { toast, confirmDialog } from '../ui.js'
import { LIMITS, REGISTERS } from '../../shared/constants.js'
import { addItem, removeItem, summarizeProfile } from '../../shared/style-analyzer.js'
import { josa } from '../../shared/hangul.js'
import { isStaticHosting } from '../notices.js'

const SOURCE_LABEL = { text: '글', voice: '말', both: '글·말', user: '직접 추가' }
const TEMPO_LABEL = { slow: '느긋한 편', normal: '보통', fast: '빠른 편', unknown: '측정 안 됨' }
const PHRASING_LABEL = { choppy: '짧게 끊어 말하기', even: '고르게 말하기', flowing: '길게 몰아 말하기', unknown: '측정 안 됨' }

const KINDS = {
  endings: { title: '자주 쓰는 어미', desc: '문장을 끝맺는 말끝이에요.', prefix: '~', placeholder: '예: 거든', empty: '뚜렷한 말끝을 찾지 못했어요. 직접 추가해 보세요.' },
  fillers: { title: '추임새·감탄사', desc: '말을 꺼낼 때 붙는 말버릇이에요.', prefix: '', placeholder: '예: 아 근데', empty: '추임새를 찾지 못했어요. 직접 추가해 보세요.' },
  expressions: { title: '자주 쓰는 표현', desc: '여러 번 나온 낱말과 말이에요.', prefix: '', placeholder: '예: 완전 좋아', empty: '되풀이해 쓴 표현을 찾지 못했어요.' },
}

export function profileView(ctx) {
  const s = getState()
  const profile = s.profile

  function apply(next, message) {
    update({ profile: next })
    if (message) toast(message)
    ctx.rerender()
  }

  function chipList(kind) {
    const meta = KINDS[kind]
    const items = profile[kind] || []
    const inputId = `add-${kind}`
    const submit = () => {
      const input = document.getElementById(inputId)
      const value = (input?.value || '').trim().replace(/^[~\-]+/, '')
      if (!value) return
      const next = addItem(profile, kind, value)
      if (next === profile || (next[kind] || []).length === items.length) {
        toast('이미 있거나 더 넣을 수 없어요.')
        return
      }
      apply(next, `‘${value}’${josa(value, '을/를')} 넣었어요.`)
    }
    return h(
      'section',
      { class: 'card profile-card stack', 'aria-labelledby': `title-${kind}` },
      h('div', null, h('h2', { class: 'card-title', id: `title-${kind}` }, meta.title), h('p', { class: 'card-sub' }, meta.desc)),
      items.length
        ? h(
            'ul',
            { class: 'chips' },
            items.map((item) =>
              h(
                'li',
                { class: 'chip removable' },
                h('span', null, `${meta.prefix}${item.form}`),
                item.count ? h('span', { class: 'n', title: '나온 횟수' }, `${item.count}회`) : null,
                h('span', { class: 'src', dataset: { src: item.source }, title: '어디에서 찾았는지' }, SOURCE_LABEL[item.source] || ''),
                h(
                  'button',
                  { class: 'chip-x', type: 'button', 'aria-label': `${item.form} 지우기`, onClick: () => apply(removeItem(profile, kind, item.form), `‘${item.form}’${josa(item.form, '을/를')} 지웠어요.`) },
                  icon('x', { size: 14 }),
                ),
              ),
            ),
          )
        : h('p', { class: 'empty' }, meta.empty),
      h(
        'form',
        {
          class: 'inline-add',
          onSubmit: (e) => {
            e.preventDefault()
            submit()
          },
        },
        h('label', { class: 'sr-only', for: inputId }, `${meta.title} 추가`),
        h('input', { class: 'input', id: inputId, type: 'text', maxLength: LIMITS.profile.itemMaxChars, placeholder: meta.placeholder, autocomplete: 'off' }),
        h('button', { class: 'btn outline small', type: 'submit' }, icon('plus'), '추가'),
      ),
    )
  }

  /** 웃음·기호 습관 하나를 프로필에서 뺀다(생성할 때 더는 붙이지 않는다). */
  function dropHabit(change, label) {
    const laugh = { ...(profile.laugh || {}) }
    change(laugh)
    const next = { ...profile, laugh, updatedAt: new Date().toISOString() }
    next.summary = summarizeProfile(next)
    apply(next, `‘${label}’ 습관을 뺐어요.`)
  }

  function laughCard() {
    const l = profile.laugh || {}
    const rows = []
    const chip = (text, note, onRemove) =>
      h(
        'li',
        { class: 'chip removable' },
        h('span', null, text),
        h('span', { class: 'n' }, note),
        h('button', { class: 'chip-x', type: 'button', 'aria-label': `${text} 습관 빼기`, onClick: onRemove }, icon('x', { size: 14 })),
      )
    const habit = (key, label, hb) => {
      if (hb && hb.count > 0) rows.push(chip(hb.typical, `${label} · ${hb.count}회`, () => dropHabit((x) => (x[key] = null), hb.typical)))
    }
    habit('kk', '웃음', l.kk)
    habit('hh', '웃음', l.hh)
    habit('cry', '울음', l.cry)
    const listHabit = (key, label, items) => {
      for (const e of Array.isArray(items) ? items : []) {
        rows.push(chip(e.form, `${label} · ${e.count}회`, () => dropHabit((x) => (x[key] = (x[key] || []).filter((y) => y.form !== e.form)), e.form)))
      }
    }
    for (const p of Array.isArray(l.punct?.typical) ? l.punct.typical : []) {
      rows.push(chip(p, '기호', () => dropHabit((x) => (x.punct = { ...(x.punct || {}), typical: (x.punct?.typical || []).filter((y) => y !== p) }), p)))
    }
    listHabit('emoji', '이모지', l.emoji)
    listHabit('emoticons', '이모티콘', l.emoticons)
    listHabit('choseong', '초성', l.choseong)
    if ((l.elongation || 0) >= 0.08) rows.push(chip('늘여 쓰기', '아아아 · ~~', () => dropHabit((x) => (x.elongation = 0), '늘여 쓰기')))
    return h(
      'section',
      { class: 'card profile-card stack', 'aria-labelledby': 'title-laugh' },
      h('div', null, h('h2', { class: 'card-title', id: 'title-laugh' }, '웃음·기호 습관'), h('p', { class: 'card-sub' }, 'ㅋㅋ·ㅠㅠ, 문장부호, 이모티콘을 쓰는 버릇이에요.')),
      rows.length ? h('ul', { class: 'chips' }, rows) : h('p', { class: 'empty' }, '웃음이나 기호를 자주 쓰지 않는 편이에요.'),
    )
  }

  function rhythmCard() {
    const t = profile.rhythm?.text
    const v = profile.rhythm?.voice
    const stats = []
    if (t) {
      stats.push(h('div', { class: 'stat' }, h('div', { class: 'k' }, '한 마디 길이'), h('div', { class: 'v' }, `평균 ${Math.round(t.avgChars)}자`), h('div', { class: 'd' }, t.shortShare >= 0.5 ? '짧게 끊어 쓰는 편' : t.longShare >= 0.3 ? '길게 풀어 쓰는 편' : '보통 길이')))
    }
    if (v) {
      stats.push(h('div', { class: 'stat' }, h('div', { class: 'k' }, '말 빠르기'), h('div', { class: 'v' }, v.syllPerSec ? `초당 ${v.syllPerSec}음절` : '—'), h('div', { class: 'd' }, TEMPO_LABEL[v.tempo] || '')))
      stats.push(h('div', { class: 'stat' }, h('div', { class: 'k' }, '쉼 비율'), h('div', { class: 'v' }, `${Math.round((v.pauseRatio || 0) * 100)}%`), h('div', { class: 'd' }, PHRASING_LABEL[v.phrasing] || '')))
    }
    return h(
      'section',
      { class: 'card profile-card stack', 'aria-labelledby': 'title-rhythm' },
      h('div', null, h('h2', { class: 'card-title', id: 'title-rhythm' }, '말 리듬'), h('p', { class: 'card-sub' }, v ? '글의 길이와 목소리의 빠르기·쉼이에요.' : '글의 길이로 본 리듬이에요. 목소리를 녹음하면 말 빠르기와 쉼도 반영돼요.')),
      stats.length ? h('div', { class: 'stat-row' }, stats) : h('p', { class: 'empty' }, '리듬을 재기에 정보가 부족해요.'),
      h(
        'div',
        { class: 'row' },
        !v ? h('a', { class: 'btn outline small', href: '#/register' }, icon('mic'), '목소리 녹음 더하기') : null,
        stats.length
          ? h(
              'button',
              {
                class: 'btn ghost small',
                type: 'button',
                onClick: () => {
                  // 리듬을 빼면 생성할 때 끊어 쓰기·늘여 쓰기 같은 리듬 맞추기를 하지 않는다
                  const next = { ...profile, rhythm: { text: null, voice: null }, updatedAt: new Date().toISOString() }
                  next.summary = summarizeProfile(next)
                  apply(next, '말 리듬을 프로필에서 뺐어요.')
                },
              },
              icon('trash'),
              '리듬 빼기',
            )
          : null,
      ),
    )
  }

  function samplesCard() {
    const samples = profile.samples || []
    const inputId = 'add-sample'
    return h(
      'section',
      { class: 'card profile-card stack', 'aria-labelledby': 'title-samples' },
      h(
        'div',
        null,
        h('h2', { class: 'card-title', id: 'title-samples' }, '대표 문장'),
        h(
          'p',
          { class: 'card-sub' },
          isStaticHosting(ctx.status)
            ? '내 말투가 잘 드러난 문장이에요. 유행어를 만들 때 이 브라우저 안에서 참고 자료로 써요. 쓰고 싶지 않은 문장은 지워 주세요.'
            : '내 말투가 잘 드러난 문장이에요. 유행어를 만들 때 참고 자료로 서버에 전송되니, 보내고 싶지 않은 문장은 지워 주세요.',
        ),
      ),
      samples.length
        ? h(
            'ul',
            { class: 'sample-list' },
            samples.map((text) =>
              h(
                'li',
                null,
                h('span', { class: 't' }, text),
                h('button', { class: 'chip-x', type: 'button', 'aria-label': '이 문장 지우기', onClick: () => apply(removeItem(profile, 'samples', text), '문장을 지웠어요.') }, icon('x', { size: 14 })),
              ),
            ),
          )
        : h('p', { class: 'empty' }, '대표 문장이 없어요. 없어도 유행어는 만들 수 있어요.'),
      h(
        'form',
        {
          class: 'inline-add',
          onSubmit: (e) => {
            e.preventDefault()
            const input = document.getElementById(inputId)
            const value = (input?.value || '').trim()
            if (!value) return
            const next = addItem(profile, 'samples', value)
            if ((next.samples || []).length === samples.length) {
              toast('이미 있거나 더 넣을 수 없어요.')
              return
            }
            apply(next, '문장을 넣었어요.')
          },
        },
        h('label', { class: 'sr-only', for: inputId }, '대표 문장 추가'),
        h('input', { class: 'input', id: inputId, type: 'text', maxLength: LIMITS.profile.sampleMaxChars, placeholder: '내가 자주 하는 말을 한 문장 넣어 보세요', autocomplete: 'off' }),
        h('button', { class: 'btn outline small', type: 'submit' }, icon('plus'), '추가'),
      ),
    )
  }

  function exportProfile() {
    const blob = new Blob([JSON.stringify(profile, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = h('a', { href: url, download: 'my-speech-profile.json' })
    document.body.append(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
  }

  async function deleteProfile() {
    const yes = await confirmDialog({ title: '프로필을 지울까요?', message: '이 기기에 저장된 말투 프로필이 지워져요. 보관함의 유행어는 남아요.', confirmLabel: '지우기', danger: true })
    if (!yes) return
    clearProfile()
    toast('말투 프로필을 지웠어요.', { type: 'ok' })
    ctx.navigate('#/register')
  }

  const src = profile.sources || {}
  const sourceBits = []
  if (src.text) sourceBits.push(`글 ${src.text.utterances.toLocaleString('ko-KR')}마디(${src.text.chars.toLocaleString('ko-KR')}자)`)
  if (src.voice) sourceBits.push(`목소리 ${Math.round(src.voice.seconds)}초`)
  const share = profile.register?.shares || {}
  const registerBits = Object.entries(REGISTERS)
    .map(([key, label]) => ({ label, pct: Math.round((share[key] || 0) * 100) }))
    .filter((x) => x.pct >= 5)
    .sort((a, b) => b.pct - a.pct)

  return h(
    'div',
    { class: 'wrap stack' },
    h(
      'header',
      { class: 'page-head' },
      h('p', { class: 'eyebrow' }, '2단계'),
      h('h1', null, '말투 프로필'),
      h('p', null, '분석해서 찾은 내 말투예요. 틀린 건 지우고, 빠진 건 직접 넣어 주세요. 고친 내용이 유행어에 그대로 반영돼요.'),
    ),
    h(
      'section',
      { class: 'summary-card', 'aria-label': '말투 한 줄 요약' },
      profile.sample ? h('span', { class: 'badge sample' }, '예시 말투') : null,
      h('p', { class: 'line' }, profile.summary?.line || '말투를 분석했어요.'),
      (profile.summary?.tags || []).length ? h('ul', { class: 'chips' }, profile.summary.tags.map((t) => h('li', { class: 'chip' }, t))) : null,
      h(
        'p',
        { class: 'meta' },
        [sourceBits.join(' · '), registerBits.length ? registerBits.map((r) => `${r.label} ${r.pct}%`).join(' · ') : '', `고친 때 ${formatDateTime(profile.updatedAt)}`].filter(Boolean).join('  |  '),
      ),
    ),
    h('div', { class: 'grid-2' }, chipList('endings'), chipList('fillers'), chipList('expressions'), laughCard(), rhythmCard(), samplesCard()),
    h(
      'section',
      { class: 'card tint stack-s' },
      h('h2', { class: 'card-title' }, '내 프로필 관리'),
      h(
        'p',
        { class: 'small muted' },
        isStaticHosting(ctx.status) ? '이 프로필은 이 기기(브라우저)에만 저장돼 있고, 어디로도 보내지 않아요.' : '이 프로필은 이 기기(브라우저)에만 저장돼 있어요. 유행어를 만들 때만 요약본이 서버로 전송돼요.',
      ),
      h(
        'div',
        { class: 'row' },
        h('a', { class: 'btn outline small', href: '#/register' }, icon('refresh'), '다시 등록'),
        h('button', { class: 'btn outline small', type: 'button', onClick: exportProfile }, icon('download'), '내보내기(JSON)'),
        h('button', { class: 'btn danger small', type: 'button', onClick: deleteProfile }, icon('trash'), '프로필 지우기'),
      ),
    ),
    h(
      'div',
      { class: 'actionbar' },
      h(
        'div',
        { class: 'actionbar-inner' },
        h('p', { class: 'hint' }, '프로필이 마음에 들면 트렌드를 고르러 가요.'),
        h('a', { class: 'btn primary big', href: '#/trends' }, '트렌드 고르기', icon('arrowRight')),
      ),
    ),
  )
}
