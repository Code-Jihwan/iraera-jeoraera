// 보관함: 저장한 유행어를 다시 보고 공유하거나 지운다. 이 기기에만 저장된다.
import { h, icon, formatDateTime } from '/js/dom.js'
import { getState, removeSaved } from '/js/store.js'
import { sendEvent } from '/js/api.js'
import { toast } from '/js/ui.js'
import { AI_MARK, TECHNIQUES } from '/shared/constants.js'
import { openShareModal } from '/js/share.js'

export function savedView(ctx) {
  const s = getState()

  function remove(item) {
    removeSaved(item.key)
    sendEvent({ anonId: s.anonId, type: 'unsave', requestId: item.requestId, candidateId: item.candidateId, technique: item.technique })
    toast('보관함에서 뺐어요.')
    ctx.rerender()
  }

  function card(item) {
    const technique = TECHNIQUES[item.technique]
    return h(
      'article',
      { class: 'result-card', 'aria-label': item.text },
      h('div', { class: 'top' }, technique ? h('span', { class: 'badge' }, technique.label) : null, h('span', { class: 'badge ai', title: AI_MARK.long }, AI_MARK.short), h('span', { class: 'tiny muted' }, formatDateTime(item.savedAt))),
      h('p', { class: 'phrase' }, item.text),
      (item.examples || []).length ? h('ul', { class: 'examples' }, item.examples.map((ex) => h('li', null, ex))) : null,
      h(
        'p',
        { class: 'small muted' },
        `밈 · ${item.trend?.keyword || ''}`,
        item.trend?.meaning ? ` — ${item.trend.meaning}` : '',
        item.trend?.sourceUrl
          ? [' ', h('a', { class: 'linkish', href: item.trend.sourceUrl, target: '_blank', rel: 'noopener noreferrer' }, '출처', icon('external', { size: 13 }), h('span', { class: 'sr-only' }, '(새 창)'))]
          : null,
      ),
      h(
        'div',
        { class: 'actions' },
        h(
          'button',
          {
            class: 'btn outline small',
            type: 'button',
            onClick: () =>
              openShareModal({
                text: item.text,
                examples: item.examples,
                requestId: item.requestId,
                candidateId: item.candidateId,
                technique: item.technique,
                trendKeyword: item.trend?.keyword || '',
                serviceName: ctx.serviceName,
              }),
          },
          icon('share'),
          '공유',
        ),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn ghost small', type: 'button', onClick: () => remove(item) }, icon('trash'), '빼기'),
      ),
    )
  }

  return h(
    'div',
    { class: 'wrap stack' },
    h('header', { class: 'page-head' }, h('h1', null, '보관함'), h('p', null, '저장한 유행어예요. 이 기기(브라우저)에만 보관돼요.')),
    s.saved.length
      ? h('div', { class: 'stack' }, s.saved.map(card))
      : h(
          'div',
          { class: 'empty-state' },
          h('h2', null, '아직 저장한 유행어가 없어요'),
          h('p', null, '마음에 드는 후보에서 ‘저장’을 눌러 보세요.'),
          h('a', { class: 'btn primary', href: s.profile ? '#/trends' : '#/register' }, s.profile ? '유행어 만들러 가기' : '말투 등록부터 시작하기'),
        ),
  )
}
