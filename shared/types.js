// 데이터 구조 정의 (JSDoc 전용 — 실행 코드는 없다).
// 브라우저 · 서버 · 테스트가 모두 이 모양을 따른다.

/**
 * 프로필 카드의 한 항목.
 * @typedef {Object} StyleItem
 * @property {string} form        표시 형태. 어미는 '거든', 추임새는 '약간', 표현은 '개웃겨'처럼 앞뒤 기호 없이.
 * @property {number} count       나온 횟수 (사용자가 직접 추가한 항목은 0)
 * @property {number} [share]     같은 종류 안에서의 비중 0..1
 * @property {'text'|'voice'|'both'|'user'} source  글에서 / 말에서 / 둘 다 / 사용자가 직접 추가
 * @property {string} [kind]      어미일 때 높임 단계: 'banmal'|'haeyo'|'hapsyo'|'eumseum'|'cute'
 * @property {number} [voiceCount] count 가운데 말(받아쓴 글)에서 센 횟수 — 음성 동의를 거두면 이만큼 덜어 낸다
 */

/**
 * 웃음·울음 자모 습관.
 * @typedef {Object} LaughHabit
 * @property {number} count    나온 횟수
 * @property {number} avgLen   평균 길이(자모 수)
 * @property {string} typical  가장 흔한 형태. 예: 'ㅋㅋㅋ'
 * @property {number} per100   발화 100개당 횟수
 */

/**
 * 녹음에서 뽑은 말 리듬. 원본 음성은 남기지 않고 이 수치만 남긴다.
 * @typedef {Object} VoiceRhythm
 * @property {number} seconds        녹음 길이(초)
 * @property {number} speakingSec    실제 말한 시간(초)
 * @property {number} pauseRatio     쉼 비율 0..1
 * @property {number} phraseCount    끊어 말한 덩어리 수
 * @property {number} avgPhraseSec   덩어리 평균 길이(초)
 * @property {number|null} syllPerSec 말 빠르기(음절/초, 쉼 제외). 받아쓴 글이 없으면 null
 * @property {'slow'|'normal'|'fast'|'unknown'} tempo
 * @property {'choppy'|'even'|'flowing'|'unknown'} phrasing  끊어 말하기 / 보통 / 몰아 말하기
 */

/**
 * 말투 프로필. 사용자의 브라우저(localStorage)에만 저장되고, 생성 요청 때 요약본만 서버로 간다.
 * @typedef {Object} StyleProfile
 * @property {1} version
 * @property {string} createdAt  ISO 시각
 * @property {string} updatedAt  ISO 시각
 * @property {boolean} [sample]  체험용 예시 프로필 여부
 * @property {{ text: {chars:number, utterances:number}|null, voice: {seconds:number, chars:number, utterances:number, onDevice:boolean}|null }} sources
 * @property {{ dominant: 'banmal'|'haeyo'|'hapsyo'|'eumseum', shares: {banmal:number, haeyo:number, hapsyo:number, eumseum:number}, cute:number }} register
 * @property {StyleItem[]} endings      자주 쓰는 어미
 * @property {StyleItem[]} fillers      추임새·감탄사
 * @property {StyleItem[]} expressions  자주 쓰는 표현
 * @property {{ kk: LaughHabit|null, hh: LaughHabit|null, cry: LaughHabit|null,
 *              emoji: {form:string,count:number}[], emoticons: {form:string,count:number}[],
 *              choseong: {form:string,count:number}[],
 *              punct: { exclaim:number, question:number, tilde:number, ellipsis:number, typical:string[] },
 *              elongation: number }} laugh   웃음·기호 습관. punct 값은 발화 100개당 횟수, elongation은 늘여 쓰기 비율 0..1
 * @property {{ text: { avgChars:number, shortShare:number, longShare:number }|null, voice: VoiceRhythm|null }} rhythm
 * @property {string[]} samples   대표 문장(개인정보 가림 처리, 사용자가 고치거나 지울 수 있음)
 * @property {('text'|'voice'|'user'|'unknown')[]} [sampleSources]  samples와 같은 순서의 출처. 서버로는 보내지 않는다
 * @property {{ line: string, tags: string[] }} summary
 */

/**
 * 생성 요청 때 서버로 보내는 말투 요약본. 원문 전체는 보내지 않는다.
 * @typedef {Object} ProfilePayload
 * @property {'banmal'|'haeyo'|'hapsyo'|'eumseum'} register
 * @property {number} cute            애교 어미 비중 0..1
 * @property {string[]} endings       많이 쓰는 순서
 * @property {string[]} fillers
 * @property {string[]} expressions
 * @property {{ kk:string|null, hh:string|null, cry:string|null, emoji:string[], emoticons:string[], punct:string[], choseong:string[], elongation:boolean }} tail
 * @property {{ avgChars:number|null, short:boolean, tempo:'slow'|'normal'|'fast'|'unknown', phrasing:'choppy'|'even'|'flowing'|'unknown' }} rhythm
 * @property {string[]} samples
 * @property {boolean} hasVoice
 * @property {boolean} hasText
 */

/**
 * 트렌드(이슈·밈) 한 건.
 * @typedef {Object} Trend
 * @property {string} id
 * @property {string} keyword       표시 이름. 예: '오히려 좋아'
 * @property {'pattern'|'phrase'|'word'|'keyword'} kind   문형 / 문구 / 낱말 / (뜻 설명이 없는) 키워드
 * @property {string|null} pattern  빈칸이 있는 문형. 예: '{X}는 못 참지'. 없으면 null
 * @property {string} meaning       뜻 요약
 * @property {string} origin        유래·맥락
 * @property {string} caution       쓸 때 주의할 점. 없으면 빈 문자열
 * @property {string} category
 * @property {{ type:'seed'|'youtube'|'instagram'|'custom', label:string, url:string|null, title:string|null }} source  출처는 링크로만 제공한다
 * @property {{ videoCount?:number }|null} stats   YouTube 통계(조회수 등)는 정책상 저장하지 않는다. 차트에서 이 키워드가 나온 영상 수만 둔다.
 * @property {{ tag:string, mediaCount:number, checkedAt:string }|null} [instagram]  인스타그램 해시태그 반응(선택 기능). 유튜브 데이터와 섞지 않고 따로 표시한다.
 * @property {string|null} collectedAt  수집 시각(ISO)
 * @property {string|null} publishedAt  서비스 노출 시각(ISO) — 검수를 통과해 목록에 올라간 때
 * @property {'approved'|'pending'|'rejected'} status
 * @property {boolean} sample       예시 데이터 여부
 * @property {boolean} [meaningVerified]  뜻·유래를 사람이 확인했는지
 * @property {string} [lastSeenAt]  (실수집 트렌드만) 마지막으로 차트에서 본 시각(ISO). 보관 기간 계산에 쓴다
 * @property {number} [score]       (실수집 트렌드만) 정렬용 점수 — 차트 순위와 영상 수로만 계산한다
 * @property {TrendEngineHints|null} [engine]  규칙 기반 엔진이 쓰는 힌트(예시 데이터에만 있음)
 */

/**
 * 규칙 기반 엔진용 힌트.
 * @typedef {Object} TrendEngineHints
 * @property {'verb'|'adj'|'past'|'noun'|'fixed'} pos   핵심 구의 품사 성격. fixed는 어미를 바꿀 수 없는 굳은 표현
 * @property {string} [stem]      어미를 붙일 줄기. 예: '오히려 좋', '못 참', '폼 미쳤'
 * @property {{ banmal:string, haeyo:string, hapsyo:string, eumseum:string, plain:string }} forms  높임 단계별 완성형
 * @property {{ pre?:string, post?:string, josa?:string, defaults:string[] }|null} slot  {X} 빈칸 설명. josa는 X 뒤에 붙는 조사 쌍('은/는')
 * @property {string[]} contexts  예문 앞에 붙일 상황 구절. 예: '비 와서 약속 취소됐는데'
 * @property {string[]} [twists]  비틀기용 변형 문형
 * @property {boolean} [asFrame]  키워드형 트렌드에 틀로 빌려 쓸 수 있는지
 */

/**
 * 생성 옵션.
 * @typedef {Object} GenerateOptions
 * @property {'chat'|'sns'|'shorts'|'talk'} situation
 * @property {'mild'|'medium'|'hot'} spice
 */

/**
 * 지금까지의 반응 요약 — 다음 생성과 랭킹에 반영된다.
 * @typedef {Object} FeedbackSummary
 * @property {{text:string, technique:string}[]} liked
 * @property {{text:string, technique:string}[]} disliked
 * @property {Object<string,{up:number,down:number}>} techniqueStats
 * @property {string[]} shown   최근에 보여 준 문구(되풀이 방지)
 */

/**
 * 유행어 후보.
 * @typedef {Object} Candidate
 * @property {string} id
 * @property {string} text               유행어
 * @property {string[]} examples         쓰임새 예문
 * @property {'ending'|'filler'|'slot'|'blend'|'rhythm'|'twist'} technique
 * @property {string[]} styleElements    쓰인 내 말투 요소. 예: ['어미 ~거든', '추임새 약간']
 * @property {string} memeElement        쓰인 밈 요소
 * @property {string} why                한 줄 설명
 * @property {number} score              0..1
 * @property {'llm'|'local'} engine
 */

/**
 * 생성 결과.
 * @typedef {Object} GenerateResult
 * @property {string} requestId
 * @property {{ mode:'llm'|'local', label:string, model:string|null, fallbackReason:string|null }} engine
 * @property {Candidate[]} candidates
 * @property {{ generated:number, blocked:number, passed:number, judge:'rules'|'rules+llm' }} safety
 * @property {Trend} trend
 * @property {string} createdAt
 */

/**
 * 안전 필터 결과. 걸린 낱말 자체는 응답에 담지 않는다.
 * @typedef {Object} SafetyVerdict
 * @property {boolean} ok
 * @property {'ok'|'caution'|'block'} level
 * @property {string[]} categories   SAFETY_CATEGORIES의 키
 */

export {}
