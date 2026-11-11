// 5단계 · 반응·공유: 후보와 쓰임새 예문을 보고 좋아요·별로예요로 반응하고, 저장·공유·신고한다.
// 반응은 이 기기에 요약으로 쌓여 다음 생성과 랭킹에 반영된다.
import { h, icon } from '/js/dom.js'
import { getState, update, applyReaction, toggleSaved, isSaved, candidateKey } from '/js/store.js'
import { sendEvent } from '/js/api.js'
import { toast } from '/js/ui.js'
import { AI_MARK, TECHNIQUES } from '/shared/constants.js'
import { resultMarkText } from '/js/notices.js'
import { openShareModal, openReportModal } from '/js/share.js'
import { requestAutoGenerate } from '/js/views/generate.js'

const RATING_LABELS = ['전혀 아니에요', '아닌 편', '보통', '비슷해요', '완전 내 말투']

export function resultView(ctx) {
  const s = getState()
  const result = s.result
  const engine = result.engine
  const trend = result.trend

  function react(candidate, kind) {
    const before = getState().reactions[candidateKey(result.requestId, candidate.id)] || null
    applyReaction(candidate, result.requestId, kind)
    const after = getState().reactions[candidateKey(result.requestId, candidate.id)] || null
    sendEvent({ anonId: s.anonId, type: after ? after : 'clear_reaction', requestId: result.requestId, candidateId: candidate.id, technique: candidate.technique })
    if (after && after !== before) toast(after === 'like' ? '좋아요! 다음에는 이런 결을 더 살릴게요.' : '알겠어요. 다음에는 이런 후보를 줄일게요.')
    ctx.rerender()
  }

  function save(candidate) {
    const saved = toggleSaved(candidate, result)
    sendEvent({ anonId: s.anonId, type: saved ? 'save' : 'unsave', requestId: result.requestId, candidateId: candidate.id, technique: candidate.technique })
    toast(saved ? '보관함에 담았어요.' : '보관함에서 뺐어요.', { type: saved ? 'ok' : 'info' })
    ctx.rerender()
  }

  function removeCandidate(candidate) {
    // 신고한 문구는 목록에서 빼고, 비슷한 후보가 다시 나오지 않게 ‘별로예요’로도 남긴다
    const current = getState().reactions[candidateKey(result.requestId, candidate.id)]
    if (current !== 'dislike') applyReaction(candidate, result.requestId, 'dislike')
    update((st) => ({ result: { ...st.result, candidates: st.result.candidates.filter((c) => c.id !== candidate.id) } }))
    ctx.rerender()
  }

  function rate(value) {
    update((st) => ({ ratings: { ...st.ratings, [result.requestId]: value } }))
    sendEvent({ anonId: s.anonId, type: 'rating', requestId: result.requestId, value })
    toast('평가 고마워요. 서비스 개선 지표에 반영돼요.', { type: 'ok' })
    ctx.rerender()
  }

  function card(candidate, index) {
    const key = candidateKey(result.requestId, candidate.id)
    const reaction = s.reactions[key] || null
    const saved = isSaved(result.requestId, candidate.id, s)
    const technique = TECHNIQUES[candidate.technique]
    return h(
      'article',
      { class: 'result-card', dataset: { rank: String(index + 1) }, 'aria-label': `후보 ${index + 1}: ${candidate.text}` },
      h(
        'div',
        { class: 'top' },
        index === 0 ? h('span', { class: 'badge hot' }, '추천') : h('span', { class: 'badge' }, `후보 ${index + 1}`),
        technique ? h('span', { class: 'badge', title: technique.desc }, technique.label) : null,
        h('span', { class: 'badge ai', title: AI_MARK.long }, AI_MARK.short),
        candidate.engine === 'local' && engine.mode === 'llm' ? h('span', { class: 'badge', title: '안전 필터를 통과한 후보가 적어 기본 엔진으로 채웠어요' }, '기본 엔진') : null,
      ),
      h('p', { class: 'phrase' }, candidate.text),
      candidate.why ? h('p', { class: 'why' }, candidate.why) : null,
      h(
        'div',
        { class: 'elements', 'aria-label': '쓰인 요소' },
        (candidate.styleElements || []).map((el) => h('span', { class: 'badge', title: '내 말투에서 가져온 요소' }, `내 말투 · ${el}`)),
        candidate.memeElement ? h('span', { class: 'badge', title: '밈에서 가져온 요소' }, `밈 · ${candidate.memeElement.replaceAll('{X}', '○○').replaceAll('{Y}', '△△')}`) : null,
      ),
      (candidate.examples || []).length
        ? h('div', { class: 'stack-s' }, h('p', { class: 'tiny muted' }, '쓰임새 예문'), h('ul', { class: 'examples' }, candidate.examples.map((ex) => h('li', null, ex))))
        : null,
      h(
        'div',
        { class: 'actions' },
        h('button', { class: 'btn outline small react', type: 'button', dataset: { kind: 'like' }, 'aria-pressed': String(reaction === 'like'), onClick: () => react(candidate, 'like') }, icon('like'), '좋아요'),
        h('button', { class: 'btn outline small react', type: 'button', dataset: { kind: 'dislike' }, 'aria-pressed': String(reaction === 'dislike'), onClick: () => react(candidate, 'dislike') }, icon('dislike'), '별로예요'),
        h('button', { class: 'btn outline small', type: 'button', 'aria-pressed': String(saved), onClick: () => save(candidate) }, icon('bookmark'), saved ? '저장됨' : '저장'),
        h(
          'button',
          {
            class: 'btn outline small',
            type: 'button',
            onClick: () =>
              openShareModal({
                text: candidate.text,
                examples: candidate.examples,
                requestId: result.requestId,
                candidateId: candidate.id,
                technique: candidate.technique,
                trendKeyword: trend.keyword,
                serviceName: ctx.serviceName,
              }),
          },
          icon('share'),
          '공유',
        ),
        h('span', { class: 'spacer' }),
        h(
          'button',
          {
            class: 'btn ghost small',
            type: 'button',
            onClick: () =>
              openReportModal({ text: candidate.text, requestId: result.requestId, candidateId: candidate.id, trendKeyword: trend.keyword, engine: candidate.engine }, () => removeCandidate(candidate), ctx.status),
          },
          icon('flag'),
          '신고',
        ),
      ),
    )
  }

  const rating = s.ratings[result.requestId] || 0
  const safety = result.safety || {}
  const src = trend.source || {}

  return h(
    'div',
    { class: 'wrap stack' },
    h(
      'header',
      { class: 'page-head' },
      h('p', { class: 'eyebrow' }, '5단계'),
      h('h1', null, '반응·공유'),
      h('p', null, '마음에 드는 후보에 반응하고 저장·공유해 보세요. 반응은 다음에 만들 때 반영돼요.'),
    ),
    h(
      'div',
      { class: 'notice ai', role: 'note' },
      icon('sparkle'),
      h(
        'div',
        null,
        h('p', null, h('strong', null, resultMarkText(engine))),
        h(
          'p',
          { class: 'small' },
          `생성 엔진: ${engine.label}${engine.model ? ` · ${engine.model}` : ''} · 안전 필터: 후보 ${safety.generated ?? '-'}개 중 ${safety.blocked ?? 0}개를 걸렀어요 (${safety.judge === 'rules+llm' ? '금칙어 필터 + AI 심사' : '금칙어 필터'})`,
        ),
      ),
    ),
    engine.fallbackReason ? h('div', { class: 'notice caution' }, icon('info'), h('p', null, engine.fallbackReason)) : null,
    result.candidates.length
      ? h('div', { class: 'stack' }, result.candidates.map(card))
      : h('div', { class: 'empty-state' }, h('h2', null, '남은 후보가 없어요'), h('p', null, '다시 만들거나 다른 트렌드를 골라 보세요.')),
    h(
      'section',
      { class: 'meme-foot stack-s', 'aria-label': '밈 뜻과 출처' },
      h('p', { class: 'k' }, '쓰인 밈'),
      h('p', null, h('strong', null, trend.keyword), trend.meaning ? ` — ${trend.meaning}` : ''),
      trend.origin ? h('p', { class: 'small muted' }, `유래: ${trend.origin}`) : null,
      trend.caution ? h('p', { class: 'small' }, h('strong', null, '쓸 때 주의 · '), trend.caution) : null,
      src.url
        ? h(
            'a',
            { class: 'linkish', href: src.url, target: '_blank', rel: 'noopener noreferrer' },
            src.type === 'youtube' ? 'YouTube에서 영상 보기' : `출처: ${src.title || '기사 보기'}`,
            icon('external', { size: 13 }),
            h('span', { class: 'sr-only' }, '(새 창)'),
          )
        : null,
    ),
    h(
      'section',
      { class: 'card stack', 'aria-labelledby': 'rating-title' },
      h('h2', { class: 'card-title', id: 'rating-title' }, '이 결과, 내 말투 같나요?'),
      h(
        'div',
        { class: 'rating', role: 'radiogroup', 'aria-label': '내 말투 같은 정도 (1~5점)' },
        [1, 2, 3, 4, 5].map((n) =>
          h('button', { type: 'button', role: 'radio', 'aria-checked': String(rating === n), 'aria-pressed': String(rating === n), 'aria-label': `${n}점: ${RATING_LABELS[n - 1]}`, onClick: () => rate(n) }, n),
        ),
      ),
      h('div', { class: 'rating-scale' }, h('span', null, RATING_LABELS[0]), h('span', null, RATING_LABELS[4])),
      rating ? h('p', { class: 'small muted' }, `${rating}점 · ${RATING_LABELS[rating - 1]} — 다시 누르면 바꿀 수 있어요.`) : null,
    ),
    h(
      'div',
      { class: 'actionbar' },
      h(
        'div',
        { class: 'actionbar-inner' },
        h('a', { class: 'btn outline', href: '#/trends' }, '다른 트렌드 고르기'),
        h(
          'button',
          {
            class: 'btn primary big',
            type: 'button',
            onClick: () => {
              requestAutoGenerate()
              ctx.navigate('#/generate')
            },
          },
          icon('refresh'),
          '반응 반영해서 다시 만들기',
        ),
      ),
    ),
  )
}
