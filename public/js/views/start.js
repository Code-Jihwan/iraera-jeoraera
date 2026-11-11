// 첫 화면: 서비스 한 줄 정의, AI 기반 고지, 다섯 단계 미리 보기.
import { h, icon } from '/js/dom.js'
import { isUsableProfile } from '/shared/style-analyzer.js'
import { localEngineLine } from '/js/notices.js'

const STEP_PREVIEW = [
  { n: 1, title: '말투 등록', desc: '내가 쓴 글을 넣고, 원하면 목소리도 녹음해요.' },
  { n: 2, title: '말투 프로필', desc: '자주 쓰는 어미·표현·추임새를 카드로 확인하고 고쳐요.' },
  { n: 3, title: '트렌드 고르기', desc: '오늘의 이슈·밈을 뜻과 출처와 함께 보고 골라요.' },
  { n: 4, title: '유행어 생성', desc: '안전 필터를 통과한 후보와 쓰임새 예문을 받아요.' },
  { n: 5, title: '반응·공유', desc: '좋아요·별로예요로 반응하고 저장·공유해요.' },
]

export function startView(ctx) {
  const s = ctx.state
  const hasProfile = isUsableProfile(s.profile)
  const engine = ctx.status?.engine

  return h(
    'div',
    { class: 'wrap stack-l' },

    h(
      'section',
      { class: 'hero' },
      h('p', { class: 'kicker' }, 'AI·SW마에스트로 17기 · 정예공군팀'),
      h(
        'h1',
        null,
        h('span', { class: 'line' }, '내 말투'),
        h('span', { class: 'line' }, h('span', { class: 'x' }, '× '), '떠오르는 밈'),
        h('span', { class: 'line' }, h('span', { class: 'eq' }, '= 나만의 유행어')),
      ),
      h('p', { class: 'lede' }, '육성과 텍스트에서 뽑아낸 내 말투에, 떠오르는 이슈와 밈을 조합해 내가 할 법한 새 유행어를 제안하는 AI 서비스예요.'),
      h(
        'div',
        { class: 'cta' },
        hasProfile
          ? [
              h('a', { class: 'btn primary big', href: '#/trends' }, '이어서 유행어 만들기', icon('arrowRight')),
              h('a', { class: 'btn ghost', href: '#/profile' }, '내 말투 프로필 보기'),
            ]
          : h('a', { class: 'btn primary big', href: '#/register' }, '내 말투 등록하고 시작하기', icon('arrowRight')),
      ),
    ),

    h(
      'div',
      { class: 'notice ai', role: 'note' },
      icon('sparkle'),
      h(
        'div',
        null,
        h('p', null, h('strong', null, '이 서비스는 생성형 인공지능(AI)을 기반으로 운용됩니다.'), ' 유행어와 예문은 내 말투 프로필과 고른 밈을 바탕으로 자동으로 만들어지며, 결과와 공유 이미지에는 ‘AI 생성’ 표시가 붙습니다.'),
        engine && engine.mode === 'local'
          ? h('p', { class: 'small' }, localEngineLine(engine))
          : null,
      ),
    ),

    h(
      'section',
      { class: 'stack', 'aria-labelledby': 'how-title' },
      h('h2', { class: 'section-title', id: 'how-title' }, '말투 두 가지와 트렌드 하나를 섞어요'),
      h(
        'div',
        { class: 'formula' },
        h(
          'div',
          { class: 'inputs' },
          h('div', { class: 'box' }, h('h3', null, '육성 말투'), h('p', null, '녹음한 목소리에서 말버릇·추임새, 말 리듬')),
          h('div', { class: 'box' }, h('h3', null, '텍스트 말투'), h('p', null, '내가 쓴 글과 채팅에서 어미·표현, ㅋㅋ·이모티콘 습관')),
          h('div', { class: 'box' }, h('h3', null, '떠오르는 이슈·밈'), h('p', null, '키워드, 밈 문형, 유래와 맥락')),
        ),
        h('div', { class: 'arrow', 'aria-hidden': 'true' }, '→'),
        h(
          'div',
          { class: 'box engine' },
          h('h3', null, 'AI 조합 엔진'),
          h('p', null, '말투 프로필 × 트렌드 맥락'),
          h('ol', null, h('li', null, '프롬프트 구성'), h('li', null, '유행어 후보 생성'), h('li', null, '안전 필터'), h('li', null, '랭킹')),
        ),
        h('div', { class: 'arrow', 'aria-hidden': 'true' }, '→'),
        h('div', { class: 'box out' }, h('h3', null, '나만의 유행어'), h('p', null, '후보 여러 개, 쓰임새 예문, 밈 출처와 뜻 설명')),
      ),
    ),

    h(
      'section',
      { class: 'stack', 'aria-labelledby': 'steps-title' },
      h('h2', { class: 'section-title', id: 'steps-title' }, '등록부터 공유까지 다섯 단계'),
      h(
        'ol',
        { class: 'steps-preview' },
        STEP_PREVIEW.map((step) => h('li', null, h('span', { class: 'n', 'aria-hidden': 'true' }, step.n), h('h3', null, step.title), h('p', null, step.desc))),
      ),
    ),

    h(
      'section',
      { class: 'card tint stack-s' },
      h('h2', { class: 'card-title' }, '시작하기 전에'),
      h(
        'ul',
        { class: 'stack-s small' },
        h('li', null, '말투 프로필은 이 기기(브라우저)에만 저장돼요. 언제든 고치거나 지울 수 있어요.'),
        h('li', null, '녹음한 목소리는 저장하지 않아요. 받아쓴 글과 말 빠르기 같은 수치만 남겨요.'),
        h('li', null, '카카오톡 대화 파일은 브라우저 안에서만 읽고, 내가 보낸 메시지만 써요.'),
        h('li', null, '만 14세 이상만 이용할 수 있어요.'),
      ),
      h('p', { class: 'small' }, h('a', { href: '#/policy' }, '이용 안내와 개인정보 처리 내용 자세히 보기')),
    ),
  )
}
