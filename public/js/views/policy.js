// 이용 안내: AI 기반 고지, 개인정보 처리 안내(초안), YouTube API 서비스 고지, 안전 필터와 신고.
import { h, icon } from '/js/dom.js'
import { AI_MARK, MIN_AGE } from '/shared/constants.js'
import { textConsentTable, voiceConsentTable, voiceExtraNotice, transferNotice } from '/js/notices.js'

export function policyView(ctx) {
  const engine = ctx.status?.engine
  const trends = ctx.status?.trends
  const name = ctx.serviceName

  const section = (id, title, ...body) => h('section', { class: 'card stack', 'aria-labelledby': id }, h('h2', { class: 'card-title', id }, title), ...body)

  return h(
    'div',
    { class: 'wrap stack' },
    h('header', { class: 'page-head' }, h('h1', null, '이용 안내'), h('p', null, `${name}이(가) 무엇을 어떻게 처리하는지 한곳에 모았어요.`)),
    h(
      'div',
      { class: 'notice caution' },
      icon('alert'),
      h('p', null, '이 안내는 법률 검토 전 초안이에요. 실제 서비스 출시 전에 전문가 검토를 거쳐 확정해야 하고, [운영자 확인 필요]로 표시한 값은 운영 주체가 채워야 해요.'),
    ),

    section(
      'p-ai',
      '생성형 AI 기반 서비스 고지',
      h('p', null, `${name}은(는) 생성형 인공지능(AI)을 기반으로 운용됩니다. 유행어와 쓰임새 예문은 내 말투 프로필과 고른 밈·이슈를 바탕으로 자동으로 만들어진 결과물입니다.`),
      h(
        'ul',
        { class: 'stack-s small' },
        h('li', null, `서비스 화면: 결과 영역 위에 생성 결과물임을 알리는 문구를 두고, 후보마다 ‘${AI_MARK.short}’ 배지를 붙여요.`),
        h('li', null, `밖으로 내보낼 때: 공유 이미지에는 ‘${AI_MARK.short}’ 표시를 그려 넣고, 복사·공유하는 글 끝에도 같은 표시를 붙여요.`),
        h('li', null, 'AI가 만든 결과는 어색하거나 상황에 맞지 않을 수 있으니 쓰기 전에 확인해 주세요.'),
        h('li', null, engine?.mode === 'llm' ? `지금 생성 엔진: ${engine.label}${engine.model ? ` (${engine.model})` : ''}` : '지금 생성 엔진: 규칙 기반 기본 엔진(LLM 미사용). 운영자가 키를 넣으면 생성형 AI 엔진으로 바뀌어요.'),
      ),
    ),

    section(
      'p-privacy',
      '개인정보 처리 안내',
      h('p', { class: 'label' }, '글 말투 분석 (필수 동의)'),
      textConsentTable(engine, ctx.status),
      h('p', { class: 'label' }, '음성 말투 분석 (선택 동의)'),
      voiceConsentTable(),
      voiceExtraNotice(),
      h('p', { class: 'label' }, '어디에서 처리하나요'),
      transferNotice(engine),
      h('p', { class: 'label' }, '대화 파일과 다른 사람의 정보'),
      h(
        'ul',
        { class: 'stack-s small' },
        h('li', null, '카카오톡 대화 파일은 이 브라우저 안에서만 읽어요. 내가 고른 이름이 보낸 메시지만 남기고, 상대방 메시지와 이름은 저장하거나 전송하지 않고 바로 지워요.'),
        h('li', null, '전화번호·이메일·링크·계정처럼 보이는 부분은 대표 문장에서 자동으로 가려요. 건강·정치적 견해 같은 민감한 내용이나 다른 사람의 개인정보는 넣지 말아 주세요.'),
        h('li', null, '입력한 내용은 AI 모델 학습에 쓰지 않아요. [AI 사업자 약관의 학습·보관 조건은 운영자 확인 필요]'),
      ),
      h('p', { class: 'label' }, '내 권리'),
      h(
        'ul',
        { class: 'stack-s small' },
        h('li', null, ['저장된 프로필 보기·고치기·지우기, 음성 동의 철회, 전체 동의 철회는 ', h('a', { href: '#/data' }, '내 데이터'), '에서 바로 할 수 있어요.']),
        h('li', null, `만 ${MIN_AGE}세 미만은 이용할 수 없어요(법정대리인 동의 절차를 제공하지 않아요).`),
        h('li', null, '문의: [개인정보 보호 담당 연락처 — 운영자 확인 필요]'),
      ),
    ),

    section(
      'p-youtube',
      '트렌드 데이터와 YouTube API 서비스',
      h(
        'ul',
        { class: 'stack-s small' },
        h('li', null, trends?.youtubeEnabled ? '이 서비스는 YouTube API 서비스를 이용해 인기 차트 영상의 제목·태그를 가져와요.' : '지금은 예시 트렌드 데이터만 쓰고 있어요. 운영자가 YouTube API 키를 넣으면 YouTube API 서비스를 이용해 인기 차트 영상의 제목·태그를 가져와요.'),
        h('li', null, '가져오는 것은 영상 제목·태그 같은 메타데이터뿐이에요. 채널명, 얼굴, 댓글, 조회수 같은 통계는 저장하지 않고, 허가 없는 자동 수집(스크래핑)은 하지 않아요.'),
        h('li', null, `수집한 데이터는 ${trends?.ttlDays ?? 7}일 안에 지우거나 새로 받아요. 키워드는 이 서비스가 자체적으로 뽑은 것이며 YouTube가 제공한 순위나 지표가 아니에요.`),
        h('li', null, '밈의 원문이나 영상은 싣지 않고, 출처는 링크로만 제공해요.'),
        h(
          'li',
          null,
          'YouTube API 서비스를 이용하는 기능을 쓰면 ',
          h('a', { href: 'https://www.youtube.com/t/terms', target: '_blank', rel: 'noopener noreferrer' }, 'YouTube 서비스 약관'),
          '에 동의하는 것으로 보며, Google의 개인정보 처리는 ',
          h('a', { href: 'http://www.google.com/policies/privacy', target: '_blank', rel: 'noopener noreferrer' }, 'Google 개인정보처리방침'),
          '을 따라요.',
        ),
        trends?.instagramEnabled ? h('li', null, '인스타그램 해시태그 반응 확인이 켜져 있어요. 공식 API로 최근 7일 30개 한도 안에서만 조회하고, 유튜브 데이터와 섞지 않고 따로 표시해요.') : null,
      ),
    ),

    section(
      'p-safety',
      '안전 필터와 신고',
      h(
        'ul',
        { class: 'stack-s small' },
        h('li', null, '트렌드 단계: 금칙어 필터로 혐오·비하·선정적 표현과 사건·참사 관련 키워드를 걸러요. 실제 수집 데이터는 사람이 검수한 뒤에 노출하는 것이 기본값이에요.'),
        h('li', null, `생성 단계: 금칙어 필터${engine?.mode === 'llm' ? '와 AI 안전 심사' : ''}를 통과한 후보만 보여 드려요. 실존 인물 이름, 방송·노래의 대사·가사는 쓰지 않아요.`),
        h('li', null, '그래도 불쾌하거나 틀린 결과가 나오면 후보의 ‘신고’를 눌러 주세요. 신고한 문구는 목록에서 빠지고 검토에 쓰여요.'),
      ),
    ),
  )
}
