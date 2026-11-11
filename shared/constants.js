// 브라우저와 서버가 함께 쓰는 상수.
// 기획안에서 "결정 필요"로 남아 있던 MVP 세부 기준을 여기에서 한 번에 정한다.

/** 서비스명(가칭). 팀에서 이름을 정하면 이 한 줄만 바꾸면 된다. 서버는 SERVICE_NAME 환경변수가 우선. */
export const DEFAULT_SERVICE_NAME = '나만의 유행어'

export const TEAM_LABEL = '정예공군팀 · AI·SW마에스트로 17기'

/** 동의 문구가 바뀌면 올린다. 저장된 동의 버전과 다르면 다시 동의를 받는다. */
export const CONSENT_VERSION = '2026-11-11.2'

/** 서버에 남는 기록의 기본 보관 기간(일). 서버 설정(EVENT_RETENTION_DAYS 등)이 우선하며 /api/status로 알려 준다. */
export const RETENTION_DEFAULT_DAYS = Object.freeze({ events: 90, reports: 90 })

/** 입력 분량·후보 개수 기준 */
export const LIMITS = Object.freeze({
  text: Object.freeze({
    minChars: 200, // 이보다 적으면 말투를 뽑기 어렵다
    goodChars: 1000, // 권장 분량
    maxChars: 20000, // 넘는 부분은 분석에서 뺀다
    maxUtterances: 2000,
  }),
  voice: Object.freeze({
    minSeconds: 15,
    goodSeconds: 40, // 권장 30~60초
    maxSeconds: 90, // 자동 종료
  }),
  profile: Object.freeze({
    endings: 8,
    fillers: 8,
    expressions: 10,
    samples: 12,
    sampleMaxChars: 80,
    customItems: 12,
    itemMaxChars: 20,
  }),
  candidates: Object.freeze({ count: 5, examplesPerCandidate: 2, maxChars: 28 }),
  customTrend: Object.freeze({ keywordMaxChars: 30, meaningMaxChars: 200 }),
  feedback: Object.freeze({ liked: 8, disliked: 8, shown: 30 }),
})

/** 만 14세 미만은 법정대리인 동의 절차가 없어 MVP에서는 이용할 수 없다. */
export const MIN_AGE = 14

/** 유행어를 만드는 방식. 사용자의 좋아요·별로예요가 방식별로 쌓여 다음 랭킹에 반영된다. */
export const TECHNIQUES = Object.freeze({
  ending: { label: '어미 입히기', desc: '밈에 내 말끝을 붙였어요' },
  filler: { label: '추임새 얹기', desc: '내가 자주 쓰는 추임새로 시작해요' },
  slot: { label: '내 단어 넣기', desc: '밈 문형에 내가 자주 쓰는 말을 넣었어요' },
  blend: { label: '줄임·합성', desc: '밈과 내 표현을 줄이거나 합쳤어요' },
  rhythm: { label: '리듬 맞추기', desc: '내 말 리듬(끊기·늘이기)에 맞췄어요' },
  twist: { label: '비틀기', desc: '밈의 뜻을 살짝 비틀었어요' },
})
export const TECHNIQUE_IDS = Object.freeze(Object.keys(TECHNIQUES))

/** 어디에 쓸 유행어인지 */
export const SITUATIONS = Object.freeze([
  { id: 'chat', label: '친구 톡', hint: '단톡방·1:1 대화' },
  { id: 'sns', label: 'SNS 캡션', hint: '게시물·스토리 문구' },
  { id: 'shorts', label: '숏폼 자막', hint: '릴스·쇼츠 자막과 멘트' },
  { id: 'talk', label: '말로 할 때', hint: '직접 만나서 하는 말' },
])
export const SITUATION_IDS = Object.freeze(SITUATIONS.map((s) => s.id))

/** 밈을 얼마나 과감하게 섞을지 */
export const SPICE_LEVELS = Object.freeze([
  { id: 'mild', label: '순한맛', hint: '내 말투 위주, 밈은 살짝' },
  { id: 'medium', label: '중간맛', hint: '말투와 밈을 반반' },
  { id: 'hot', label: '매운맛', hint: '밈을 과감하게 비틀기' },
])
export const SPICE_IDS = Object.freeze(SPICE_LEVELS.map((s) => s.id))

/** 말투 높임 단계 */
export const REGISTERS = Object.freeze({
  banmal: '반말',
  haeyo: '해요체',
  hapsyo: '합쇼체',
  eumseum: '음슴체',
})

/** 트렌드 분류 */
export const TREND_CATEGORIES = Object.freeze(['감탄', '응원·다짐', '자조·푸념', '칭찬', '놀람', '공감', '거절·회피', '일상', '시즌'])

/** 안전 필터가 막는 범주 (사용자에게는 범주 이름만 보여 주고, 걸린 낱말은 보여 주지 않는다) */
export const SAFETY_CATEGORIES = Object.freeze({
  profanity: '욕설',
  hate: '혐오·비하',
  sexual: '선정적 표현',
  tragedy: '사건·참사 희화화',
  self_harm: '자해·자살',
  real_person: '실존 인물',
  privacy: '개인정보',
  other: '기타 유해 표현',
})

/** 신고 사유 */
export const REPORT_REASONS = Object.freeze([
  { id: 'hate', label: '혐오·비하 표현' },
  { id: 'sexual', label: '선정적 표현' },
  { id: 'tragedy', label: '사건·참사를 희화화' },
  { id: 'real_person', label: '실존 인물 조롱·사칭' },
  { id: 'wrong_meaning', label: '밈 뜻·유래가 틀림' },
  { id: 'other', label: '기타' },
])

/** 사용자 반응 이벤트 종류 */
export const EVENT_TYPES = Object.freeze(['like', 'dislike', 'clear_reaction', 'save', 'unsave', 'share', 'rating', 'expose'])

/** AI 생성 표시 문구 */
export const AI_MARK = Object.freeze({
  short: 'AI 생성',
  long: '이 문구는 AI가 생성했습니다',
  notice: '이 서비스는 생성형 AI를 기반으로 유행어를 만듭니다. 결과와 공유 이미지에는 ‘AI 생성’ 표시가 붙습니다.',
})
