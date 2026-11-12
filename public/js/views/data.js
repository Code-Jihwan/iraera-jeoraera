// 내 데이터: 무엇이 어디에 저장돼 있는지 보여 주고, 열람·삭제·동의 철회를 한 화면에서 할 수 있게 한다.
import { h, icon, formatDateTime } from '../dom.js'
import { getState, update, clearProfile, resetAll, hasConsent, hasVoiceConsent, isStorageAvailable, engineUsesLlm } from '../store.js'
import { toast, confirmDialog } from '../ui.js'
import { isUsableProfile, removeVoiceData } from '../../shared/style-analyzer.js'
import { discardVoiceDraft, resetRegisterDraft } from './register.js'
import { hostingNotice, isStaticHosting, retentionDays } from '../notices.js'

export function dataView(ctx) {
  const s = getState()
  const consented = hasConsent(s, ctx.status)
  const voiceOn = consented && hasVoiceConsent(s)
  const profile = s.profile
  const engine = ctx.status?.engine
  const isStatic = isStaticHosting(ctx.status)

  async function withdrawVoice() {
    const yes = await confirmDialog({
      title: '음성 동의를 철회할까요?',
      message: '목소리에서 나온 말버릇, 받아쓴 대표 문장, 말 리듬 수치를 프로필에서 지워요. 글에서 찾은 말투는 남아요.',
      confirmLabel: '철회하고 지우기',
      danger: true,
    })
    if (!yes) return
    // 녹음 중이던 것이나 아직 분석하지 않은 녹음 결과도 버린다
    discardVoiceDraft()
    const cur = getState()
    const patch = { consent: { ...cur.consent, voice: false, voiceAt: null, voiceWithdrawnAt: new Date().toISOString() } }
    if (cur.profile) {
      const stripped = removeVoiceData(cur.profile)
      // 목소리만으로 만든 프로필이면 남는 것이 없으니 통째로 지운다
      patch.profile = isUsableProfile(stripped) && stripped.sources?.text ? stripped : null
      if (!patch.profile || stripped !== cur.profile) patch.result = null
    }
    update(patch)
    toast(patch.profile === null ? '음성 동의를 철회하고, 목소리로만 만든 프로필을 지웠어요.' : '음성 동의를 철회하고 목소리에서 나온 정보를 프로필에서 지웠어요.', { type: 'ok', ms: 4500 })
    ctx.rerender()
  }

  async function deleteProfile() {
    const yes = await confirmDialog({ title: '말투 프로필을 지울까요?', message: '이 기기에 저장된 프로필과 마지막 생성 결과를 지워요. 되돌릴 수 없어요.', confirmLabel: '지우기', danger: true })
    if (!yes) return
    clearProfile()
    toast('말투 프로필을 지웠어요.', { type: 'ok' })
    ctx.rerender()
  }

  async function deleteEverything() {
    const yes = await confirmDialog({
      title: '모든 동의를 철회하고 전부 지울까요?',
      message: '이 기기에 저장된 동의 기록, 말투 프로필, 보관함, 반응 기록을 모두 지워요. 되돌릴 수 없어요.',
      confirmLabel: '전부 지우기',
      danger: true,
    })
    if (!yes) return
    resetRegisterDraft()
    resetAll()
    toast('이 기기에 저장된 것을 모두 지웠어요.', { type: 'ok' })
    ctx.navigate('#/')
  }

  function downloadAll() {
    const cur = getState()
    // 이 기기에 저장된 것을 빠짐없이 내려받는다(익명 ID 포함)
    const data = { exportedAt: new Date().toISOString(), ...cur }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = h('a', { href: url, download: 'my-catchphrase-data.json' })
    document.body.append(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
  }

  const row = (k, v) => h('tr', null, h('th', { scope: 'row' }, k), h('td', null, v))
  const src = profile?.sources || {}

  return h(
    'div',
    { class: 'wrap stack' },
    h('header', { class: 'page-head' }, h('h1', null, '내 데이터'), h('p', null, '무엇이 어디에 저장돼 있는지 확인하고, 언제든 지우거나 동의를 철회할 수 있어요.')),
    !isStorageAvailable() ? h('div', { class: 'notice caution' }, icon('alert'), h('p', null, '이 브라우저에서는 저장 공간을 쓸 수 없어요(사생활 보호 모드 등). 창을 닫으면 프로필이 사라져요.')) : null,
    h(
      'section',
      { class: 'card stack', 'aria-labelledby': 'data-consent' },
      h('h2', { class: 'card-title', id: 'data-consent' }, '동의 내역'),
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'plain' },
          h(
            'tbody',
            null,
            row('글 말투 분석', consented ? `동의함 · ${formatDateTime(s.consent.at)} · 문구 버전 ${s.consent.version}` : s.consent ? '다시 동의가 필요해요(안내 내용이 바뀜)' : '동의하지 않음'),
            row(
              '음성 말투 분석',
              voiceOn
                ? `동의함 · ${formatDateTime(s.consent.voiceAt || s.consent.at)}`
                : s.consent?.voiceWithdrawnAt
                  ? `철회함 · ${formatDateTime(s.consent.voiceWithdrawnAt)}`
                  : '동의하지 않음(선택 항목)',
            ),
            row('국외 이전 안내', consented ? (s.consent.transfer === 'llm' ? '확인함(AI 엔진 사용 안내 포함)' : isStatic ? '해당 없음(브라우저 안에서만 처리)' : '해당 없음(기본 엔진)') : '확인 전'),
            row('만 14세 이상', consented ? '확인함' : '확인 전'),
          ),
        ),
      ),
      h(
        'div',
        { class: 'row' },
        h('a', { class: 'btn outline small', href: '#/register' }, '동의 내용 보기·바꾸기'),
        voiceOn ? h('button', { class: 'btn outline small', type: 'button', onClick: withdrawVoice }, '음성 동의 철회') : null,
      ),
    ),
    h(
      'section',
      { class: 'card stack', 'aria-labelledby': 'data-stored' },
      h('h2', { class: 'card-title', id: 'data-stored' }, '이 기기에 저장된 것'),
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          { class: 'plain' },
          h(
            'tbody',
            null,
            row(
              '말투 프로필',
              profile
                ? [
                    `${profile.sample ? '예시 말투 · ' : ''}${[src.text ? `글 ${src.text.utterances.toLocaleString('ko-KR')}마디` : '', src.voice ? `목소리 ${Math.round(src.voice.seconds)}초` : ''].filter(Boolean).join(' + ')} · 고친 때 ${formatDateTime(profile.updatedAt)} · `,
                    h('a', { href: '#/profile' }, '내용 보기·고치기'),
                  ]
                : '없음',
            ),
            row('입력한 원문·대화 파일', '저장하지 않아요(분석 직후 지움)'),
            row('녹음한 목소리', '저장하지 않아요(받아쓴 글과 수치만 프로필에 반영)'),
            row('보관함', `${s.saved.length}개`),
            row('반응 기록', `좋아요 ${s.feedback.liked.length}개 · 별로예요 ${s.feedback.disliked.length}개(다음 생성에 반영)`),
          ),
        ),
      ),
      h(
        'div',
        { class: 'row' },
        h('button', { class: 'btn outline small', type: 'button', onClick: downloadAll }, icon('download'), '내 데이터 내려받기(JSON)'),
        profile ? h('button', { class: 'btn danger small', type: 'button', onClick: deleteProfile }, icon('trash'), '프로필 지우기') : null,
        h('button', { class: 'btn danger small', type: 'button', onClick: deleteEverything }, icon('trash'), '동의 철회 · 전부 지우기'),
      ),
    ),
    isStatic ? staticOutboundSection() : serverSection(),
  )

  /** 정적 데모(GitHub Pages): 서버가 없어 밖으로 보내거나 남기는 것이 없다 */
  function staticOutboundSection() {
    return h(
      'section',
      { class: 'card stack', 'aria-labelledby': 'data-server' },
      h('h2', { class: 'card-title', id: 'data-server' }, '밖으로 보내는 것'),
      h(
        'ul',
        { class: 'stack-s small' },
        h('li', null, '이 데모는 GitHub Pages로 제공하는 정적 사이트라 서비스 서버가 없어요. 유행어도 이 브라우저 안에서 규칙 기반 기본 엔진으로 만들어요.'),
        h('li', null, '입력한 글, 음성 분석 결과, 말투 프로필, 만든 결과, 반응, 신고는 어디로도 보내지 않아요. 입력한 원문은 분석 직후 지우고, 프로필·보관함·결과·반응은 이 브라우저 저장 공간에만 남아요.'),
        h('li', null, '신고를 해도 이 기기에서 그 문구를 목록에서 뺄 뿐, 신고 내용이 누구에게도 전달되지 않아요.'),
        h('li', null, '받아쓰기는 브라우저의 음성 인식 기능을 써요. 브라우저에 따라 브라우저 제조사의 음성 인식 서비스로 음성이 전송될 수 있어요.'),
      ),
      hostingNotice(),
      h('p', { class: 'tiny muted' }, '‘전부 지우기’를 하면 이 브라우저에 저장된 것이 모두 지워지고, 익명 ID도 새로 바뀌어요.'),
      h('a', { class: 'linkish', href: '#/policy' }, '이용 안내와 개인정보 처리 내용 자세히 보기'),
    )
  }

  function serverSection() {
    return h(
      'section',
      { class: 'card stack', 'aria-labelledby': 'data-server' },
      h('h2', { class: 'card-title', id: 'data-server' }, '서버로 가는 것과 서버에 남는 것'),
      h(
        'ul',
        { class: 'stack-s small' },
        h('li', null, '유행어를 만들 때: 프로필 요약(어미·표현·추임새·대표 문장), 고른 트렌드, 넣고 싶은 말, 직접 넣은 밈과 뜻, 반응 요약(좋아요·별로예요 문구, 최근 보여 준 문구). 서버는 만드는 동안에만 쓰고 저장하지 않아요.'),
        h('li', null, `서버에 남는 기록: 생성·반응(좋아요·저장·공유·평가) 기록을 익명 ID와 함께 ${retentionDays(ctx.status).events}일 동안 보관해요. 문구 내용과 프로필은 남기지 않고, 서비스 개선 지표에만 써요.`),
        h('li', null, `신고할 때: 신고한 문구, 사유, 덧붙인 말을 검토를 위해 ${retentionDays(ctx.status).reports}일 동안 보관해요(연락처 같은 부분은 가려서 저장).`),
        h(
          'li',
          null,
          engine?.mode === 'llm'
            ? '지금은 AI 엔진이 켜져 있어, 유행어를 만들 때 위 내용이 생성형 AI 사업자(Anthropic, 미국)의 API로 전송돼요.'
            : engineUsesLlm(engine)
              ? 'AI 엔진이 설정돼 있지만 지금은 쓸 수 없어 기본 엔진으로 만들고 있어요. AI 엔진이 다시 켜지면 위 내용이 생성형 AI 사업자(Anthropic, 미국)의 API로 전송돼요.'
              : engine
                ? '지금은 기본 엔진이라 외부 AI 사업자에게 보내는 것이 없어요.'
                : '서버 상태를 확인하지 못했어요. AI 엔진이 켜져 있으면 위 내용이 생성형 AI 사업자(Anthropic, 미국)의 API로 전송돼요.',
        ),
      ),
      h('p', { class: 'tiny muted' }, '서버에 남은 기록은 이 기기의 익명 ID로만 묶여 있어요. ‘전부 지우기’를 하면 이 기기의 익명 ID가 새로 바뀌어 예전 기록과 이어지지 않아요.'),
      h('a', { class: 'linkish', href: '#/policy' }, '이용 안내와 개인정보 처리 내용 자세히 보기'),
    )
  }
}
