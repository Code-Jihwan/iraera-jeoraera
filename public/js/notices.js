// 고지·동의 문구. 등록 화면과 이용 안내 화면이 같은 내용을 쓴다.
// ※ 법률 검토 전 초안이다. 실제 처리 내용이 바뀌면 여기와 CONSENT_VERSION을 함께 고친다.
import { h, icon } from '/js/dom.js'
import { engineUsesLlm } from '/js/store.js'
import { AI_MARK, MIN_AGE, RETENTION_DEFAULT_DAYS } from '/shared/constants.js'

const strong = (text) => h('strong', null, text)

/** 서버가 알려 준 보관 기간(없으면 기본값) */
export function retentionDays(status) {
  const r = status?.retention
  return {
    events: Number.isFinite(r?.events) ? r.events : RETENTION_DEFAULT_DAYS.events,
    reports: Number.isFinite(r?.reports) ? r.reports : RETENTION_DEFAULT_DAYS.reports,
  }
}

/** 서버 상태를 모르면 AI 엔진이 켜진 경우의 안내를 보여 준다(덜 알리는 쪽으로 틀리지 않게) */
function mayUseLlm(engine) {
  return !engine || engineUsesLlm(engine)
}

/** 동의받을 때 알려야 하는 네 가지(목적·항목·보유 기간·거부권)를 표로 */
function fourRowTable(rows) {
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      { class: 'plain' },
      h(
        'tbody',
        null,
        rows.map(([th, td]) => h('tr', null, h('th', { scope: 'row' }, th), h('td', null, td))),
      ),
    ),
  )
}

/**
 * 글 말투 분석(필수) 동의 표.
 * @param {object|null} engine 서버 상태의 엔진 정보. 없으면 AI 엔진이 켜진 경우로 안내한다
 * @param {object|null} [status] 서버 상태(보관 기간)
 */
export function textConsentTable(engine = null, status = null) {
  const days = retentionDays(status)
  return fourRowTable([
    ['목적', '내 말투 프로필 만들기, 프로필에 맞춘 유행어·예문 생성, 서비스 개선 지표 집계와 신고 검토'],
    [
      '항목',
      '내가 직접 입력한 글, 대화 파일에서 내가 보낸 메시지, 이를 분석해 만든 말투 프로필(자주 쓰는 어미·표현·추임새, 웃음·기호 습관, 대표 문장), 고른 트렌드와 넣고 싶은 말, 반응 기록(좋아요·저장·공유·평가·신고), 이 기기의 익명 ID',
    ],
    [
      '보유·이용 기간',
      [
        strong('말투 프로필과 보관함은 이 기기(브라우저)에만 두고, 지우거나 동의를 철회할 때까지 보관해요.'),
        ' 입력한 원문과 대화 파일은 분석 직후 지워요. 서버는 유행어를 만드는 동안에만 프로필 요약을 쓰고 저장하지 않아요. ',
        strong(`서버에는 생성·반응 기록(문구 내용 없이 종류·시각·요청 번호)을 익명 ID와 함께 ${days.events}일, 신고한 문구·사유·덧붙인 말을 ${days.reports}일 동안 보관한 뒤 지워요.`),
        mayUseLlm(engine) ? ' 유행어를 만들 때 프로필 요약이 생성형 AI 사업자에게 전송돼요(아래 국외 이전 안내).' : '',
      ],
    ],
    ['거부할 권리', '동의하지 않을 수 있어요. 다만 서비스에 꼭 필요한 항목이라, 동의하지 않으면 이용할 수 없어요.'],
  ])
}

export function voiceConsentTable() {
  return fourRowTable([
    ['목적', '말한 내용을 글로 바꾸고(음성→텍스트), 말 빠르기·쉼 같은 말 리듬을 프로필에 반영'],
    ['항목', '마이크로 입력한 음성(실시간 처리에만 사용), 받아쓴 글, 말 리듬 수치(말 빠르기, 쉼 비율, 끊어 말하는 길이)'],
    [
      '보유·이용 기간',
      [strong('음성 원본은 저장하지 않고 처리 즉시 폐기해요.'), ' 받아쓴 글에서 뽑은 말투 정보와 말 리듬 수치는 프로필과 같은 기간 동안 이 기기에 보관해요.'],
    ],
    ['거부할 권리', '동의하지 않을 수 있고, 동의하지 않아도 글만으로 서비스를 그대로 이용할 수 있어요.'],
  ])
}

export function voiceExtraNotice() {
  return h(
    'ul',
    { class: 'stack-s small muted' },
    h('li', null, '목소리로 사람을 식별하기 위한 정보(성문 등 음성 특징정보)는 만들지 않아요.'),
    h('li', null, '받아쓰기는 브라우저의 음성 인식 기능을 써요. 브라우저에 따라 기기 안에서 처리되거나, 브라우저 제조사의 음성 인식 서비스로 음성이 전송될 수 있어요.'),
    h('li', null, '음성 동의는 ‘내 데이터’에서 언제든 철회할 수 있어요.'),
  )
}

/** 프로필 요약이 어디로 가는지 — 엔진 상태에 따라 다르게 알린다. */
export function transferNotice(engine) {
  const llm = mayUseLlm(engine)
  return h(
    'div',
    { class: 'stack-s small' },
    h(
      'p',
      null,
      '말투 분석은 이 브라우저 안에서 이루어져요. 유행어를 만들 때만 프로필 요약(자주 쓰는 어미·표현·추임새, 대표 문장 몇 개), 고른 트렌드, 넣고 싶은 말, 반응 요약이 서비스 서버로 전송돼요.',
    ),
    llm
      ? h(
          'div',
          { class: 'notice caution' },
          icon('info'),
          h(
            'div',
            null,
            h('p', null, strong('처리위탁·국외 이전 안내: '), '서버는 문구 생성과 안전 심사를 위해 아래 항목을 생성형 AI 사업자의 API로 보냅니다.'),
            !engine ? h('p', { class: 'small' }, '서버 상태를 확인하지 못해, AI 엔진이 켜져 있을 때의 안내를 보여 드려요.') : null,
            h(
              'ul',
              { class: 'small' },
              h('li', null, '이전받는 자: Anthropic, PBC (Claude API) · 연락처: [운영자 확인 필요 — 사업자의 개인정보 문의 창구]'),
              h('li', null, '이전 국가: 미국'),
              h('li', null, '시기·방법: 유행어를 만들 때마다 암호화된 통신(HTTPS)으로 전송'),
              h(
                'li',
                null,
                '이전 항목: 말투 프로필 요약(어미·추임새·표현·웃음과 기호 습관·말 리듬·대표 문장), 고른 트렌드(직접 넣은 밈과 뜻 포함), 넣고 싶은 말, 반응 요약(좋아요·별로예요 문구, 최근 보여 준 문구), 안전 심사용 후보 문구',
              ),
              h('li', null, '이전받는 자의 이용 목적·보유 기간: 문구 생성과 안전 심사 / 사업자 약관에 따름 [운영자 확인 필요]'),
              h('li', null, '이전 근거: 개인정보 보호법 제28조의8 제1항 [법률 검토 후 확정]'),
              h('li', null, '거부 방법·효과: 이 서비스를 이용하지 않거나 ‘내 데이터’에서 동의를 철회 / 거부하면 유행어 생성을 이용할 수 없음'),
            ),
          ),
        )
      : h('p', { class: 'muted' }, '지금은 규칙 기반 기본 엔진으로 동작해, 프로필 요약을 외부 AI 사업자에게 보내지 않아요. 운영자가 AI 엔진을 켜면 이 안내가 바뀌고, 다음에 쓸 때 다시 동의를 받아요.'),
  )
}

export function inputCaution() {
  return h(
    'div',
    { class: 'notice' },
    icon('shield'),
    h('p', null, '건강·정치적 견해 같은 민감한 내용이나 다른 사람의 이름·연락처·주소는 넣지 말아 주세요. 전화번호·이메일·링크처럼 보이는 부분은 자동으로 가려요.'),
  )
}

/** 기본 엔진으로 돌 때 그 이유를 한 줄로 */
export function localEngineLine(engine) {
  if (engine?.mode !== 'local') return null
  return engine.configured
    ? `AI 엔진이 설정돼 있지만 지금은 쓸 수 없어(${engine.reason || '원인 확인 중'}) 규칙 기반 기본 엔진으로 동작하고 있어요.`
    : '지금은 LLM 없이 규칙 기반 기본 엔진으로 동작하고 있어요. 서버에 키를 넣으면 생성형 AI 엔진으로 바뀝니다.'
}

export function aiNoticeBox(engine) {
  const local = localEngineLine(engine)
  return h(
    'div',
    { class: 'notice ai', role: 'note' },
    icon('sparkle'),
    h(
      'div',
      null,
      h('p', null, strong('이 서비스는 생성형 인공지능(AI)을 기반으로 운용됩니다.'), ' 유행어와 예문은 내 말투 프로필과 고른 밈을 바탕으로 자동으로 만들어져요.'),
      h('p', { class: 'small' }, 'AI가 만든 결과는 어색하거나 상황에 맞지 않을 수 있으니 쓰기 전에 확인해 주세요.'),
      local ? h('p', { class: 'small' }, local) : null,
    ),
  )
}

/** 결과 영역 위에 고정으로 붙는 표시 문구 */
export function resultMarkText(engine) {
  return engine?.mode === 'llm' ? '아래 문구는 생성형 AI가 만든 결과물입니다.' : '아래 문구는 AI 조합 엔진(규칙 기반 기본 엔진)이 자동으로 만든 결과물입니다.'
}

/** 복사·공유하는 글 끝에 붙는 표시 */
export function shareSuffix(serviceName) {
  return `(${AI_MARK.short} · ${serviceName})`
}

export const AGE_LABEL = `만 ${MIN_AGE}세 이상입니다.`
export const AGE_HELP = `만 ${MIN_AGE}세 미만은 이 서비스를 이용할 수 없어요.`
