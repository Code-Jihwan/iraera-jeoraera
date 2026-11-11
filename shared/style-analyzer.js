// 말투 분석기: 내가 쓴 글과 받아쓴 말에서 어미·추임새·자주 쓰는 표현·웃음과 기호 습관·리듬을 찾아 말투 프로필을 만든다.
// 브라우저에서 돌아가므로 원문은 기기 밖으로 나가지 않는다(서버 쪽 테스트도 같은 코드를 쓴다).
// 형태소 분석기 없이 규칙과 낱말 목록으로 찾기 때문에, 애매하면 세지 않는 쪽을 택한다. 틀린 항목은 사용자가 프로필 화면에서 지운다.
import { LIMITS } from './constants.js'
import { JONG, charLength, compose, decompose, isCompatJamo, isHangulSyllable, josa, splitTail } from './hangul.js'
import { containsPII, maskPII } from './pii.js'

const MAX_UTTERANCE_CHARS = 500
const MAX_TOTAL_CHARS = LIMITS.text.maxChars * 5
const REGISTER_KEYS = ['banmal', 'haeyo', 'hapsyo', 'eumseum']
const EMPTY_SHARES = Object.freeze({ banmal: 0, haeyo: 0, hapsyo: 0, eumseum: 0 })

// ───────────────────────── 어미 ─────────────────────────

// [끝말, 표시 형태, 높임 단계, 조건] — 긴 끝말부터 맞춰 본다.
// before: 끝말 앞에 같은 어절 안에서 있어야 하는 음절 수 / prevJong: 끝말 바로 앞 음절의 받침
const ENDING_RULES = [
  ['습니다', '습니다', 'hapsyo'],
  ['습니까', '습니까', 'hapsyo'],
  ['십시오', '십시오', 'hapsyo'],
  ['니다', '습니다', 'hapsyo', { prevJong: 'ㅂ' }],
  ['니까', '습니까', 'hapsyo', { prevJong: 'ㅂ' }],

  ['더라고요', '더라고요', 'haeyo'],
  ['거든요', '거든요', 'haeyo'],
  ['잖아요', '잖아요', 'haeyo'],
  ['던데요', '던데요', 'haeyo'],
  ['는데요', '는데요', 'haeyo'],
  ['은데요', '는데요', 'haeyo'],
  ['이에요', '예요', 'haeyo'],
  ['데요', '는데요', 'haeyo', { prevJong: 'ㄴ' }],
  ['예요', '예요', 'haeyo'],
  ['네요', '네요', 'haeyo'],
  ['군요', '군요', 'haeyo'],
  ['지요', '지요', 'haeyo', { before: 1 }],
  ['세요', '세요', 'haeyo'],
  ['게요', 'ㄹ게요', 'haeyo', { prevJong: 'ㄹ' }],
  ['까요', 'ㄹ까요', 'haeyo', { prevJong: 'ㄹ' }],
  ['래요', 'ㄹ래요', 'haeyo', { prevJong: 'ㄹ' }],
  ['대요', '대요', 'haeyo', { before: 1 }],
  ['어요', '어요', 'haeyo'],
  ['아요', '아요', 'haeyo'],
  ['해요', '해요', 'haeyo'],
  ['죠', '죠', 'haeyo', { before: 1 }],
  ['요', '요', 'haeyo', { before: 1 }],

  ['더라고', '더라고', 'banmal'],
  ['다니까', '다니까', 'banmal'],
  ['거든', '거든', 'banmal'],
  ['잖아', '잖아', 'banmal'],
  ['더라', '더라', 'banmal'],
  ['던데', '던데', 'banmal'],
  ['는데', '는데', 'banmal'],
  ['은데', '는데', 'banmal'],
  ['구나', '구나', 'banmal'],
  ['거야', '거야', 'banmal'],
  ['다고', '다고', 'banmal', { before: 1 }],
  ['라고', '라고', 'banmal', { before: 1 }],
  ['데', '는데', 'banmal', { prevJong: 'ㄴ' }],
  ['걸', 'ㄹ걸', 'banmal', { prevJong: 'ㄹ' }],
  ['래', 'ㄹ래', 'banmal', { prevJong: 'ㄹ' }],
  ['게', 'ㄹ게', 'banmal', { prevJong: 'ㄹ' }],
  ['까', 'ㄹ까', 'banmal', { prevJong: 'ㄹ' }],
  ['군', '군', 'banmal', { before: 1 }],
  ['냐', '냐', 'banmal', { before: 1 }],
  // 해라체 의문 -니: 언니·어머니 같은 명사가 많아 앞 음절이 시제·용언 어간일 때만
  ['니', '니', 'banmal', { pred: true }],
  ['대', '대', 'banmal', { before: 1 }],
  ['자', '자', 'banmal', { before: 1 }],
  ['지', '지', 'banmal', { before: 1 }],
  ['네', '네', 'banmal', { before: 1 }],
  ['야', '야', 'banmal', { before: 1 }],
  ['다', '다', 'banmal', { before: 1 }],
]
  .map(([suffix, form, kind, opts = {}]) => ({ suffix, len: Array.from(suffix).length, form, kind, before: opts.before || 0, prevJong: opts.prevJong || null, pred: Boolean(opts.pred) }))
  .sort((a, b) => b.len - a.len)

// 해체의 -아/-어(줄어든 꼴 포함). 앞 음절 없이 혼자 쓰여도 되는 것만 *_ALONE에 둔다.
const EO_SYLLABLES = new Set(['어', '해', '돼', '줘', '써', '워', '져', '춰', '꿔', '둬', '겨', '쳐', '셔', '텨', '려', '래'])
const EO_ALONE = new Set(['해', '돼', '줘', '써'])
const A_SYLLABLES = new Set(['아', '봐', '놔'])
const A_ALONE = new Set(['봐', '놔'])
// 르 불규칙 반말처럼 음절만으로는 알 수 없는 꼴
const WORD_ENDINGS = new Map([
  ['몰라', '아'],
  ['빨라', '아'],
  ['달라', '아'],
  ['골라', '아'],
  ['올라', '아'],
  ['불러', '어'],
  ['눌러', '어'],
  ['흘러', '어'],
])

// 끝 음절이 어미처럼 보이지만 실제로는 명사·부사인 어절
const NOT_ENDING_WORDS = new Set([
  '바다', '판다',
  '강아지', '송아지', '망아지', '돼지', '바지', '휴지', '의지', '가지', '편지', '반지', '거지', '여지', '지지', '번지', '정지',
  '이미지', '메시지', '페이지', '패키지', '마사지', '소시지', '에너지',
  '동네', '그네', '분야', '시야', '아야',
  '단어', '영어', '한국어', '언어', '연어', '상어', '문어', '숭어', '고등어', '오징어', '붕어', '잉어', '은어', '국어',
  '아시아', '러시아', '치아', '고아', '이탈리아',
  '올해', '새해', '이해', '오해', '손해', '동해', '서해', '남해', '방해', '재해', '화해', '상해', '수해',
  '필요', '중요', '수요', '동요', '민요', '요요', '주요', '강요',
  '기대', '반대', '세대', '시대', '군대', '무대', '침대', '상대', '절대', '최대', '근대', '현대', '학대', '연대', '지대',
  '과자', '피자', '의자', '남자', '여자', '모자', '상자', '기자', '부자', '감자', '사자', '액자', '왕자', '숫자', '글자', '문자', '한자', '저자', '환자', '효자', '탁자',
  '해군', '공군', '육군', '장군', '아군', '적군',
  '케냐', '벌써', '샤워', '타워', '파워', '우려', '염려', '배려', '고려', '노래', '미래', '고래', '모래',
  '사이다', '캐나다', '우간다', '소다',
  '아버지', '할아버지', '오렌지', '잡지', '낙지', '표지', '토지', '처지', '묘지',
  '언니네', '친구네', '엄마네', '아빠네', '이모네', '고모네', '삼촌네', '동생네', '형네', '누나네', '오빠네', '할머니네', '우리네', '너네', '니네', '걔네', '얘네', '쟤네',
  '드디어', '광어', '농어', '장어', '민어', '전어', '송어', '용어', '주어', '술어', '속어', '약어', '고어', '방어', '제어', '불어', '수어', '목적어',
  '혼자', '독자', '학자', '작자', '강자', '약자', '제자', '투자', '신자', '성자', '현자', '필자', '역자', '병자', '관리자', '처리자', '참가자', '후보자',
])
// 셋 이상 음절에서 이 음절 + 자/어로 끝나면 ‘-자(者)’, ‘-어(語)’ 명사로 본다(구독자, 사용자, 유행어, 한국어).
// 가자·해보자·만나자·버리자·마시자처럼 동사와 겹치는 음절(가·보·나·리·시·지·우·기·하)은 넣지 않는다.
const SINO_JA_PREV = new Set(Array.from('용독청비산학구여업발영험행연작획문답격승매유임당상계쟁전최표성해호로동회원력술직명권판심'))
const SINO_EO_PREV = new Set(Array.from('국본행조준술의성태래략속일'))

// 앞 음절이 시제(았·었·했·겠·있 등 받침 ㅆ)나 흔한 용언 어간이면 어미일 가능성이 높다.
// 특징·상징, 녹음, 언니처럼 같은 끝 음절을 가진 명사를 거르는 데 쓴다.
const PREDICATE_STEMS = new Set(Array.from('없같싶않좋많맞먹찮싫렇알높낮넓좁작짧늦읽받찾닫앉넣놓젊밝맑깊옳잃끊얇굵씻벗입잡씹막믿묻얻잊들'))
function isPredicateLike(syllable) {
  const d = decompose(syllable)
  return Boolean(d) && (JONG[d.jong] === 'ㅆ' || PREDICATE_STEMS.has(syllable))
}

/** 어미처럼 보여도 명사·조사로 끝나는 어절(내일까지, 어제보다, 구독자, 유행어) */
function isNounLike(word, chars) {
  if (word.endsWith('까지')) return true
  if (chars.length < 3) return false
  if (word.endsWith('보다') || word.endsWith('마다')) return true
  const last = chars[chars.length - 1]
  const prev = chars[chars.length - 2]
  return (last === '자' && SINO_JA_PREV.has(prev)) || (last === '어' && SINO_EO_PREV.has(prev))
}

// 받침 ㅇ·ㅁ을 더한 애교 어미: 받침을 뺀 끝 음절 → 받침별 표시 형태.
// prev: 받침을 뺀 꼴이 어미로 맞더라도 끝 음절 바로 앞 음절이 이 조건을 지켜야 한다(선물용·특징 같은 명사를 거르려고).
const YO_PREV = new Set([...EO_SYLLABLES, ...A_SYLLABLES, '가', '와', '나', '고', '구', '까'])
const JI_PREV = new Set(['하', '되', '가', '오', '보', '주', '해', '쓰', '크', '자', '사'])
const CUTE_FROM = {
  // 맨 ‘요’ 규칙으로만 맞을 때(가요, 돼요)는 앞 음절이 용언 꼴이어야 한다. ‘어요·네요’처럼 긴 규칙은 그대로 믿는다.
  요: { ㅇ: '용', ㅁ: '욤', prev: (p, plain) => plain.form !== '요' || YO_PREV.has(p) },
  죠: { ㅇ: '죵' },
  다: { ㅇ: '당' },
  네: { ㅇ: '넹' },
  지: { ㅇ: '징', prev: (p) => Boolean(p) && (isPredicateLike(p) || JI_PREV.has(p)) },
  야: { ㅁ: '얌' },
}
// 해 + ㅇ(행)은 여행·유행·은행·진행 같은 한자어가 훨씬 흔해서, 애교로 흔히 쓰는 앞 음절만 받는다(뭐행, 미안행, 사랑행).
const HAE_CUTE_PREV = new Set(['뭐', '안', '랑', '각', '심', '탁', '잘', '못'])
// 겨·려 + ㅇ(경·령)은 거의 늘 명사(안경, 환경, 대통령, 명령)라 애교 어미로 보지 않는다.
const NO_CUTE_EO = new Set(['겨', '려'])
const CUTE_BASE = { 용: 'haeyo', 욤: 'haeyo', 죵: 'haeyo', 쥬: 'haeyo', 당: 'banmal', 넹: 'banmal', 징: 'banmal', 엉: 'banmal', 앙: 'banmal', 얌: 'banmal' }
const NOT_CUTE_WORDS = new Set([
  '내용', '사용', '비용', '이용', '허용', '효용', '수용', '적용', '활용', '응용', '고용', '채용', '신용', '무용', '미용', '작용', '포용', '소용', '실용', '전용', '공용', '운용', '애용', '남용',
  '식당', '정당', '사당', '강당', '학당', '서당', '당당', '성당', '본당', '혈당', '해당', '담당', '상당', '적당', '부당', '타당', '마당', '명당',
  '수당', '일당', '야당', '여당', '전당', '과당', '포도당',
  '중앙', '앙앙', '엉엉', '얌얌', '징징',
])

// 음슴체: 받침 ㅁ으로 끝맺는 말. 임·음·함은 그대로, 나머지는 ‘ㅁ’으로 묶어 보여 준다.
// 음은 앞 음절이 시제·용언 어간일 때만(먹음, 있었음 / 녹음·소음은 명사).
// 'connective'는 앞 음절이 -아/-어 꼴이거나 가·나 같은 모음 어간일 때만 받는다(나감, 해봄, 없어짐 / 마감·올봄·이삿짐은 명사).
const EUMSEUM_OTHER = new Map([
  ...['됨', '옴', '씀', '남', '냄', '뜀', '둠', '뺌', '켬', '끔', '름', '움'].map((s) => [s, 'any']),
  ...['감', '봄', '짐', '줌'].map((s) => [s, 'connective']),
])
const CONNECTIVE_PREV = new Set([...EO_SYLLABLES, ...A_SYLLABLES, '가', '와', '나', '라', '사', '타', '자', '차', '파', '따', '까', '서', '켜', '펴', '떠', '녀', '너', '내'])
// 한 음절 명사·감탄사는 어절 전체가 같을 때만 거른다
const NOT_EUMSEUM_WORDS = new Set(['밤', '봄', '잠', '짐', '꿈', '힘', '몸', '맘', '춤', '숨', '땀', '김', '섬', '솜', '침', '점', '삶', '남', '품', '흠', '음', '엄', '좀', '참', '임', '줌', '님'])
// 두 음절 이상 명사는 어절이 이것으로 끝나면 거른다(우리담임, 온라인게임처럼 붙여 쓴 합성어까지)
const NOT_EUMSEUM_SUFFIXES = [
  '사람', '마음', '처음', '다음', '이름', '지금', '조금', '요즘', '가끔', '그림', '바람', '점심', '아침', '여름', '구름', '기름', '오름', '흐름', '주름', '보름', '고름',
  '얼음', '울음', '웃음', '믿음', '걸음', '죽음', '물음', '소음', '발음', '녹음', '느낌', '기쁨', '슬픔', '아픔',
  '게임', '모임', '책임', '담임', '취임', '사임', '퇴임', '신임', '선임', '후임', '전임', '위임', '해임', '부임', '재임', '소임',
  '고함', '포함', '사물함', '보관함', '수납함', '편지함', '우편함', '투표함', '모금함', '신발함', '군함', '전함',
  '시험', '경험', '위험', '보험', '부담', '농담', '상담', '말씀', '마감', '오줌', '한줌',
  '강남', '호남', '영남', '차남', '장남', '미남', '훈남', '경남', '충남', '전남', '하남', '성남',
  '도움', '싸움', '배움', '이삿짐', '자신감', '책임감', '만족감', '기대감', '긴장감', '열등감', '위화감', '친근감', '공감', '영감', '장난감',
  '쾌감', '불안감', '안정감', '성취감', '소속감', '거리감', '질감', '촉감', '예감', '반감', '호감', '실감', '동감', '존재감',
]

const SUFFIX_KIND = new Map()
for (const r of ENDING_RULES) if (!SUFFIX_KIND.has(r.form)) SUFFIX_KIND.set(r.form, r.kind)
for (const f of ['어', '아', '긴 해']) SUFFIX_KIND.set(f, 'banmal')
SUFFIX_KIND.set('긴 해요', 'haeyo')
for (const f of ['임', '음', '함', 'ㅁ']) SUFFIX_KIND.set(f, 'eumseum')
for (const f of Object.keys(CUTE_BASE)) SUFFIX_KIND.set(f, 'cute')

function prevSyllableJong(chars, index) {
  const d = decompose(chars[index])
  return d ? JONG[d.jong] : null
}

/** 한 어절이 일반 어미로 끝나는지 */
function matchPlainWord(word) {
  if (WORD_ENDINGS.has(word)) return { form: WORD_ENDINGS.get(word), kind: 'banmal' }
  // 숫자·영문이 섞인 어절(20대, 2대, ok했어)은 숫자+단위이거나 판단이 어려워 세지 않는다
  if (/[0-9A-Za-z]/.test(word)) return null
  const chars = Array.from(word)
  if (isNounLike(word, chars)) return null
  for (const rule of ENDING_RULES) {
    if (!word.endsWith(rule.suffix)) continue
    const beforeCount = chars.length - rule.len
    if (beforeCount < rule.before) continue
    if (rule.prevJong && (beforeCount < 1 || prevSyllableJong(chars, beforeCount - 1) !== rule.prevJong)) continue
    if (rule.pred && (beforeCount < 1 || !isPredicateLike(chars[beforeCount - 1]))) continue
    return { form: rule.form, kind: rule.kind }
  }
  const last = chars[chars.length - 1]
  if (EO_SYLLABLES.has(last) && (chars.length >= 2 || EO_ALONE.has(last))) return { form: '어', kind: 'banmal' }
  if (A_SYLLABLES.has(last) && (chars.length >= 2 || A_ALONE.has(last))) return { form: '아', kind: 'banmal' }
  return null
}

/** 받침 ㅇ·ㅁ을 더한 애교 어미(가용, 좋당, 했엉, 맛있쥬) */
function matchCute(word) {
  if (NOT_CUTE_WORDS.has(word) || /[0-9A-Za-z]/.test(word)) return null
  const chars = Array.from(word)
  const last = chars[chars.length - 1]
  const prev = chars[chars.length - 2]
  // ‘쥬’는 받침을 더한 꼴이 아니라 ‘죠’의 모음을 바꾼 꼴이다(맛있쥬, 그렇쥬)
  if (last === '쥬') return prev && isHangulSyllable(prev) ? { form: '쥬', kind: 'cute', base: CUTE_BASE['쥬'] } : null
  const d = decompose(last)
  if (!d) return null
  const jong = JONG[d.jong]
  if (jong !== 'ㅇ' && jong !== 'ㅁ') return null
  const baseSyllable = compose(d.cho, d.jung, 0)
  const baseWord = chars.slice(0, -1).join('') + baseSyllable
  if (NOT_ENDING_WORDS.has(baseWord)) return null
  const plain = matchPlainWord(baseWord)
  if (!plain) return null
  let form = null
  const from = CUTE_FROM[baseSyllable]
  if (from) {
    if (from.prev && !from.prev(prev, plain)) return null
    form = from[jong] || null
  } else if (jong === 'ㅇ' && EO_SYLLABLES.has(baseSyllable)) {
    if (NO_CUTE_EO.has(baseSyllable)) return null
    if (baseSyllable === '해' && !HAE_CUTE_PREV.has(prev)) return null
    form = '엉'
  } else if (jong === 'ㅇ' && A_SYLLABLES.has(baseSyllable)) {
    form = '앙'
  }
  return form ? { form, kind: 'cute', base: CUTE_BASE[form] } : null
}

/** 음슴체(했음, 맛있음, 집에 감, 그거 아님) */
function matchEumseum(word) {
  if (NOT_EUMSEUM_WORDS.has(word) || /[0-9A-Za-z]/.test(word)) return null
  if (NOT_EUMSEUM_SUFFIXES.some((s) => word.endsWith(s))) return null
  const chars = Array.from(word)
  const last = chars[chars.length - 1]
  const prev = chars[chars.length - 2]
  const d = decompose(last)
  if (!d || JONG[d.jong] !== 'ㅁ') return null
  const hit = (form) => ({ form, kind: 'eumseum' })
  if (last === '음') return prev && isPredicateLike(prev) ? hit('음') : null
  if (last === '임' || last === '함') return hit(last)
  // ‘아님’(아니다)만 받는다. 선생님·손님 같은 ‘-님’은 명사다.
  if (last === '님') return prev === '아' ? hit('ㅁ') : null
  const rule = EUMSEUM_OTHER.get(last)
  if (!rule) return null
  if (rule === 'connective' && chars.length > 1 && !CONNECTIVE_PREV.has(prev)) return null
  return hit('ㅁ')
}

const isEdgeSymbol = (ch) => !/[\p{L}\p{N}]/u.test(ch)
// splitTail이 떼는 웃음·울음 자음(ㅋ·ㅎ·ㅠ·ㅜ·ㅇㅇ 등)
const TAIL_JAMO = new Set(Array.from('ㅋㅎㅠㅜㄷㅇㅈㄹㅊㄱㄴㅅㅂㅁ'))
// 어미는 끝 두 어절만 보면 되므로 이만큼만 정규식에 넘긴다(긴 기호 줄에서 끝 고정 정규식이 느려지지 않게)
const ENDING_WINDOW = 64

/** 어절 앞뒤의 기호와 뒤에 붙은 자모를 뗀다. 정규식 대신 한 번 훑어서 긴 기호 줄에도 빠르다. */
function cleanWord(word) {
  const chars = Array.from(String(word))
  let start = 0
  let end = chars.length
  while (start < end && isEdgeSymbol(chars[start])) start++
  while (end > start && (isEdgeSymbol(chars[end - 1]) || isCompatJamo(chars[end - 1]))) end--
  return chars.slice(start, end).join('')
}

/** 말끝의 ㅋㅋ·기호·이모지를 떼어 낸 본문 */
function cleanCore(utterance) {
  const chars = Array.from(String(utterance))
  let end = chars.length
  // splitTail과 같은 글자(와 그 밖의 기호)를 먼저 한 번에 떼고, 남은 끝부분만 splitTail에 넘긴다
  while (end > 0 && (TAIL_JAMO.has(chars[end - 1]) || isEdgeSymbol(chars[end - 1]))) end--
  let start = Math.max(0, end - ENDING_WINDOW)
  if (start > 0) {
    // 잘린 첫 어절은 버린다
    const space = chars.slice(start, end).findIndex((ch) => /\s/u.test(ch))
    if (space >= 0) start += space + 1
  }
  let core = splitTail(chars.slice(start, end).join('')).core
  for (let i = 0; i < 2; i++) core = splitTail(core.replace(/[^\p{L}\p{N}\s]+$/u, '')).core
  return core
}

/** 발화 하나의 어미. 없으면 null */
function matchEnding(utterance) {
  const words = cleanCore(utterance).split(/\s+/).filter(Boolean)
  if (!words.length) return null
  const last = cleanWord(words[words.length - 1])
  const chars = Array.from(last)
  if (!chars.length || !isHangulSyllable(chars[chars.length - 1])) return null
  if (words.length >= 2) {
    const prev = cleanWord(words[words.length - 2])
    if (charLength(prev) >= 2 && prev.endsWith('긴')) {
      if (last === '해') return { form: '긴 해', kind: 'banmal' }
      if (last === '해요') return { form: '긴 해요', kind: 'haeyo' }
    }
  }
  if (NOT_ENDING_WORDS.has(last)) return null
  return matchPlainWord(last) || matchCute(last) || matchEumseum(last)
}

// ───────────────────────── 추임새 ─────────────────────────

const FILLERS_MULTI = ['아 근데', '아니 근데', '어 근데', '아 진짜', '아니 진짜', '와 진짜', '근데 진짜', '아 맞다', '아 그니까', '아니 그니까', '아 그러니까', '헐 대박', '아 잠깐', '아 그래서']
const FILLERS_START = new Set([
  '아', '어', '음', '이제', '그니까', '그러니까', '근데', '그런데', '아니', '와', '우와', '헐', '오', '오오', '아이고', '대박', '에이', '흠', '엥', '앗', '헉',
  '아오', '어우', '어휴', '아휴', '에휴', '휴', '웅', '응', '그치', '글쎄', '일단', '혹시', '아무튼', '암튼', '어쨌든', '그래서', '그럼', '자', '야', '되게', '엄청', '정말',
])
// 지시어로도 흔히 쓰여(그 사람, 저 영화, 뭐 먹지) 쉼표·말줄임이 붙거나 혼자 쓰일 때만 추임새로 본다
const FILLERS_HESITANT = new Set(['그', '저', '뭐'])
const FILLERS_ANYWHERE = new Set(['약간', '뭔가', '그냥', '막', '좀', '진짜', '완전', '너무', '솔직히', '사실'])
const ALL_FILLERS = new Set([...FILLERS_MULTI, ...FILLERS_START, ...FILLERS_HESITANT, ...FILLERS_ANYWHERE])

/** 같은 음절이 이어지면 하나로(아아아 → 아) */
function squeezeSyllables(word) {
  return Array.from(word)
    .filter((ch, i, arr) => i === 0 || ch !== arr[i - 1])
    .join('')
}

/** 어절 목록. 기호·웃음만이라 낱말이 비는 어절도 남긴다(두 어절 표현이 실제로 붙어 있는지 보려고). */
function rawTokens(utterance) {
  // 쉼표 뒤에서도 나누되 쉼표는 앞 조각에 남긴다(‘뭐,’처럼 망설임 표시를 알아보려고)
  return String(utterance)
    .split(/\s+/)
    .flatMap((t) => t.split(/(?<=,)/))
    .filter(Boolean)
    .map((raw) => ({ raw, word: cleanWord(raw) }))
}

function tokenize(utterance) {
  return rawTokens(utterance).filter((t) => t.word)
}

function findFillers(tokens) {
  const found = []
  const used = new Set()
  let i = 0
  // 문장 첫머리: 두 어절짜리를 먼저, 그다음 한 어절짜리. 첫머리 추임새는 둘까지만 이어서 본다.
  for (let n = 0; n < 2 && i < tokens.length; n++) {
    const a = squeezeSyllables(tokens[i].word)
    const b = tokens[i + 1] ? squeezeSyllables(tokens[i + 1].word) : ''
    if (b && FILLERS_MULTI.includes(`${a} ${b}`)) {
      found.push(`${a} ${b}`)
      used.add(i).add(i + 1)
      i += 2
      continue
    }
    const hesitant = FILLERS_HESITANT.has(a) && (tokens.length === 1 || /[,.…~]$/.test(tokens[i].raw) || squeezeSyllables(tokens[i].word) !== tokens[i].word)
    if (FILLERS_START.has(a) || FILLERS_ANYWHERE.has(a) || hesitant) {
      found.push(a)
      used.add(i)
      i += 1
      continue
    }
    break
  }
  tokens.forEach((t, idx) => {
    if (!used.has(idx) && FILLERS_ANYWHERE.has(t.word)) found.push(t.word)
  })
  return found
}

// ───────────────────────── 자주 쓰는 표현 ─────────────────────────

const STOPWORDS = new Set([
  '나', '너', '저', '우리', '저희', '너희', '걔', '얘', '쟤', '그거', '이거', '저거', '그게', '이게', '저게', '그건', '이건', '저건', '그걸', '이걸', '저걸',
  '거기', '여기', '저기', '이런', '그런', '저런', '이렇게', '그렇게', '저렇게', '어떻게', '그때', '이때',
  '나는', '내가', '난', '날', '나도', '나랑', '너는', '니가', '네가', '넌', '너도', '저는', '제가', '전', '저도', '우리는', '우린', '우리가', '우리도',
  '뭐', '뭔', '뭘', '뭐가', '뭐야', '뭐지', '왜', '어디', '언제', '누구', '누가', '어느', '얼마', '몇',
  '그리고', '그래서', '그러면', '그럼', '하지만', '그런데', '근데', '그니까', '그러니까', '그래도', '아니면', '또', '더', '덜', '다', '잘', '안', '못', '꼭',
  '같이', '다시', '이미', '벌써', '아직', '계속', '항상', '맨날', '자주', '가끔', '제일', '가장', '아주', '매우', '정말', '엄청', '되게', '많이', '조금', '살짝',
  '일단', '혹시', '아마', '이따', '나중에', '먼저', '빨리', '천천히',
  '오늘', '내일', '어제', '지금', '요즘', '이번', '다음', '저번', '아까', '방금', '이번에', '오늘은',
  '네', '예', '응', '어', '아', '음', '아니', '아니요', '그래', '그치', '맞아', '헐', '와', '오',
  '있어', '없어', '있는', '없는', '있다', '없다', '있고', '없고', '있는데', '없는데', '있으면', '없으면', '있어서', '없어서',
  '했어', '했는데', '했다', '한다', '하는', '하고', '하면', '해서', '해도', '하자', '할까', '할게', '할래', '해', '해요', '했어요', '하는데',
  '된다', '돼', '됐어', '되는', '같아', '같은', '같은데', '거야', '거지', '건데', '거든', '거', '것', '게', '수', '때', '줄', '데', '듯',
  '좋아', '싫어', '그렇지', '아니야', '아닌데', '알아', '몰라', '봐', '봤어', '가', '갔어', '왔어', '줘',
  '한데', '인데', '하지', '했지', '하네', '했네', '있지', '없지', '했고', '되고', '보니까', '하니까', '가서', '와서', '봐도', '같다', '좋다', '거니까', '그런가',
])

function isContentWord(word) {
  return charLength(word) >= 2 && !STOPWORDS.has(word) && !ALL_FILLERS.has(word)
}

// 웃음소리만으로 된 어절(하하하, 히히, 헤헤, 크크, 깔깔, 푸하하, 히힛)
const LAUGH_WORD_RE = /^(?:([하히헤호흐후크키킥큭캬깔낄])\1+[핫힛헷큭킥]?|푸하+[핫]?|풉+)$/u

/** 표현 후보가 될 수 있는 낱말인지(초성·웃음만, 숫자, 개인정보는 뺀다) */
function isExpressionToken(word) {
  if (!word || /\d/.test(word)) return false
  // 표현 칸에 들어갈 수 없는 긴 덩어리는 보지 않는다(개인정보 정규식이 긴 문자열에서 느려지지 않게)
  if (charLength(word) > LIMITS.profile.itemMaxChars) return false
  if (!/[가-힣A-Za-z]/.test(word)) return false
  if (Array.from(word).every((ch) => isCompatJamo(ch) || !/\p{L}/u.test(ch))) return false
  if (LAUGH_WORD_RE.test(word)) return false
  return !containsPII(word)
}

// ───────────────────────── 웃음·기호 습관 ─────────────────────────

const EMOTICON_PATTERNS = [
  ['^^', /\^{2,}/g],
  ['^_^', /\^_\^/g],
  ['ㅡㅡ', /ㅡ{2,}/g],
  ['-_-', /-_-/g],
  [';;', /;{2,}/g],
  ['ㅇㅅㅇ', /ㅇㅅㅇ/g],
  ['ㅎㅅㅎ', /ㅎㅅㅎ/g],
  ['ㅇㅁㅇ', /ㅇㅁㅇ/g],
  ['ㅜㅅㅜ', /[ㅜㅠ]ㅅ[ㅜㅠ]/g],
  ['>_<', />_</g],
  [':)', /:\)/g],
  [':(', /:\(/g],
]
const CHOSEONG_ABBREVIATIONS = new Set(['ㅇㅇ', 'ㄴㄴ', 'ㄱㄱ', 'ㅇㅈ', 'ㄹㅇ', 'ㅊㅋ', 'ㄱㅅ', 'ㅈㅅ', 'ㅇㅋ', 'ㄷㄷ', 'ㅂㅂ', 'ㅎㅇ', 'ㄱㅊ', 'ㅁㄹ', 'ㅇㄷ', 'ㄱㄷ', 'ㅅㄱ'])
const EMOJI_RE = /\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic}️?)*/gu
// 같은 음절을 셋 이상, 같은 모음 자모를 둘 이상(ㅠ·ㅜ·ㅡ는 울음·이모티콘이라 뺀다), 물결을 둘 이상
const ELONGATION_RE = /([가-힣])\1\1|([ㅏㅑㅓㅕㅗㅛㅣㅐㅔ])\2|~{2,}/u

function runHabit(utterances, re, renderTypical) {
  let count = 0
  let totalLen = 0
  const byShape = new Map()
  for (const u of utterances) {
    for (const m of u.matchAll(re)) {
      const len = Array.from(m[0]).length
      count++
      totalLen += len
      const shape = renderTypical(m[0], len)
      byShape.set(shape, (byShape.get(shape) || 0) + 1)
    }
  }
  if (!count) return null
  const typical = [...byShape.entries()].sort((a, b) => b[1] - a[1] || charLength(a[0]) - charLength(b[0]))[0][0]
  return { count, avgLen: round(totalLen / count, 1), typical, per100: round((count / utterances.length) * 100, 1) }
}

function topCounts(map, n) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, n)
    .map(([form, count]) => ({ form, count }))
}

/** 가장 많이 쓴 표기(같으면 선택자가 붙은 이모지 표기) */
function mostUsedVariant(variants) {
  return [...variants.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length || (a[0] < b[0] ? -1 : 1))[0][0]
}

function analyzeHabits(utterances) {
  const n = utterances.length
  const kk = runHabit(utterances, /ㅋ{2,}/g, (_, len) => 'ㅋ'.repeat(Math.min(len, 6)))
  const hh = runHabit(utterances, /ㅎ{2,}/g, (_, len) => 'ㅎ'.repeat(Math.min(len, 6)))
  const cry = runHabit(utterances, /[ㅠㅜ]{2,}/g, (s) => Array.from(s).slice(0, 6).join(''))

  const emoji = new Map()
  const emoticons = new Map()
  const choseong = new Map()
  let exclaim = 0
  let doubled = 0
  let question = 0
  let tilde = 0
  let ellipsis = 0
  let interrobang = 0
  let elongated = 0
  for (const u of utterances) {
    for (const m of u.matchAll(EMOJI_RE)) {
      // ❤와 ❤️(이모지 표시 선택자 U+FE0F)는 같은 그림이므로 하나로 센다
      const key = m[0].replace(/[︎️]/gu, '')
      const cur = emoji.get(key) || { count: 0, variants: new Map() }
      cur.count++
      cur.variants.set(m[0], (cur.variants.get(m[0]) || 0) + 1)
      emoji.set(key, cur)
    }
    for (const [form, re] of EMOTICON_PATTERNS) {
      re.lastIndex = 0
      const hits = u.match(re)
      if (hits) emoticons.set(form, (emoticons.get(form) || 0) + hits.length)
    }
    for (const raw of u.split(/\s+/)) {
      const token = raw.replace(/[^ㄱ-ㅎ]/g, '')
      if (!token || token !== raw.replace(/[^\p{L}]/gu, '')) continue
      // ㄷㄷㄷ·ㅇㅇㅇ처럼 늘인 것도 두 글자 꼴로 센다
      const shape = /^(.)\1+$/u.test(token) ? token.slice(0, 2) : token
      if (CHOSEONG_ABBREVIATIONS.has(shape)) choseong.set(shape, (choseong.get(shape) || 0) + 1)
    }
    for (const m of u.matchAll(/!+/g)) {
      exclaim++
      if (m[0].length >= 2) doubled++
    }
    question += (u.match(/\?+/g) || []).length
    tilde += (u.match(/~+/g) || []).length
    ellipsis += (u.match(/\.{2,}|…+/g) || []).length
    interrobang += (u.match(/\?!|!\?/g) || []).length
    if (ELONGATION_RE.test(u)) elongated++
  }
  const per100 = (x) => (n ? round((x / n) * 100, 1) : 0)
  const punct = { exclaim: per100(exclaim), question: per100(question), tilde: per100(tilde), ellipsis: per100(ellipsis), typical: [] }
  if (punct.exclaim >= 12) punct.typical.push(doubled / exclaim >= 0.4 ? '!!' : '!')
  if (punct.tilde >= 12) punct.typical.push('~')
  if (punct.ellipsis >= 12) punct.typical.push('…')
  if (interrobang >= 2 && per100(interrobang) >= 5) punct.typical.push('?!')
  return {
    kk,
    hh,
    cry,
    emoji: topCounts(new Map([...emoji.values()].map((e) => [mostUsedVariant(e.variants), e.count])), 5),
    emoticons: topCounts(emoticons, 5),
    choseong: topCounts(choseong, 5),
    punct,
    elongation: n ? round(elongated / n, 2) : 0,
  }
}

// ───────────────────────── 대표 문장 ─────────────────────────

function bigrams(text) {
  const chars = Array.from(String(text).replace(/\s+/g, ''))
  const set = new Set()
  for (let i = 0; i < chars.length - 1; i++) set.add(chars[i] + chars[i + 1])
  return set
}

function jaccard(a, b) {
  if (!a.size && !b.size) return 1
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

function pickSamples(entries, features) {
  const max = LIMITS.profile.samples
  const scored = []
  entries.forEach(({ text, source }, index) => {
    const len = charLength(text)
    if (len < 6 || len > LIMITS.profile.sampleMaxChars) return
    if (/\d{6,}/.test(text) || maskPII(text).masked > 0) return
    const ending = matchEnding(text)
    const tokens = tokenize(text)
    let score = 0
    if (ending) score += features.topEndings.includes(ending.form) ? 2 : 0.5
    const fillers = findFillers(tokens)
    if (fillers.length && features.topFillers.includes(fillers[0])) score += 1.5
    else if (fillers.some((f) => features.topFillers.includes(f))) score += 0.5
    if (features.kk && /ㅋ{2,}/.test(text)) score += 1
    if (features.hh && /ㅎ{2,}/.test(text)) score += 1
    if (features.cry && /[ㅠㅜ]{2,}/.test(text)) score += 0.5
    if (features.punct.some((p) => text.includes(p === '…' ? '..' : p) || (p === '…' && text.includes('…')))) score += 0.5
    if (tokens.some((t) => features.topExpressions.has(t.word))) score += 0.5
    if (len >= 12 && len <= 45) score += 0.5
    scored.push({ text, source, score, index, ending: ending ? ending.form : '', key: text.toLowerCase().replace(/\s+/g, ''), grams: bigrams(text) })
  })
  scored.sort((a, b) => b.score - a.score || a.index - b.index)

  const chosen = []
  const keys = new Set()
  const endingUse = new Map()
  // 첫 바퀴는 같은 어미가 셋을 넘지 않게, 둘째 바퀴는 남은 자리만 채운다
  for (const limitEndings of [true, false]) {
    for (const c of scored) {
      if (chosen.length >= max) break
      if (keys.has(c.key)) continue
      if (limitEndings && c.ending && (endingUse.get(c.ending) || 0) >= 3) continue
      if (chosen.some((s) => jaccard(s.grams, c.grams) > 0.6)) continue
      chosen.push(c)
      keys.add(c.key)
      endingUse.set(c.ending, (endingUse.get(c.ending) || 0) + 1)
    }
  }
  // 출처(글/말)를 함께 돌려줘, 음성 동의를 거두면 받아쓴 문장만 골라 지울 수 있게 한다
  return chosen.sort((a, b) => a.index - b.index).map((c) => ({ text: c.text, source: c.source }))
}

// ───────────────────────── 공통 ─────────────────────────

function round(n, digits = 2) {
  if (!Number.isFinite(n)) return 0
  const f = 10 ** digits
  return Math.round(n * f) / f
}

function toIso(now) {
  // 숫자·문자열·Date만 시각으로 받는다(Symbol 같은 값은 new Date가 던진다)
  const d = now instanceof Date ? now : typeof now === 'number' || typeof now === 'string' ? new Date(now) : now == null ? new Date() : new Date(NaN)
  return Number.isNaN(d.getTime()) ? new Date(0).toISOString() : d.toISOString()
}

/** 바깥에서 온 발화 목록을 다듬는다(문자열만, 앞뒤 공백 제거, 길이·개수 제한). */
function cleanUtterances(list) {
  if (!Array.isArray(list)) return []
  const out = []
  let total = 0
  // 문자열이 아닌 항목이 아주 많이 섞여 와도 끝없이 훑지 않는다
  const scanLimit = Math.min(list.length, LIMITS.text.maxUtterances * 5)
  for (let i = 0; i < scanLimit; i++) {
    const item = list[i]
    if (typeof item !== 'string') continue
    // 아주 긴 문자열은 먼저 잘라서 다듬는다(앞뒤 공백을 감안해 넉넉히)
    const head = item.length > MAX_UTTERANCE_CHARS * 4 ? item.slice(0, MAX_UTTERANCE_CHARS * 4) : item
    const text = Array.from(head.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim()).slice(0, MAX_UTTERANCE_CHARS).join('')
    if (!text) continue
    out.push(text)
    total += text.length
    if (out.length >= LIMITS.text.maxUtterances || total >= MAX_TOTAL_CHARS) break
  }
  return out
}

function createTally() {
  const map = new Map()
  return {
    add(form, source, extra) {
      const cur = map.get(form) || { form, text: 0, voice: 0, ...extra }
      cur[source] += 1
      map.set(form, cur)
    },
    values: () => [...map.values()],
  }
}

function sourceOf(e) {
  return e.text && e.voice ? 'both' : e.text ? 'text' : 'voice'
}

function toItems(entries, { minCount, cap }) {
  const total = entries.reduce((n, e) => n + e.text + e.voice, 0)
  return entries
    .map((e) => {
      const count = e.text + e.voice
      const item = { form: e.form, count, share: total ? round(count / total) : 0, source: sourceOf(e) }
      if (e.kind) item.kind = e.kind
      // 말에서 나온 횟수를 따로 적어 두면, 음성 동의를 거둘 때 그만큼만 덜어 낼 수 있다
      if (e.voice) item.voiceCount = e.voice
      return item
    })
    .filter((item) => item.count >= minCount)
    .sort((a, b) => b.count - a.count || (a.form < b.form ? -1 : 1))
    .slice(0, cap)
}

function sanitizeRhythm(r) {
  if (!r || typeof r !== 'object') return null
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
  const tempo = ['slow', 'normal', 'fast'].includes(r.tempo) ? r.tempo : 'unknown'
  const phrasing = ['choppy', 'even', 'flowing'].includes(r.phrasing) ? r.phrasing : 'unknown'
  const syll = Number(r.syllPerSec)
  return {
    seconds: num(r.seconds),
    speakingSec: num(r.speakingSec),
    pauseRatio: Math.min(1, Math.max(0, num(r.pauseRatio))),
    phraseCount: Math.max(0, Math.round(num(r.phraseCount))),
    avgPhraseSec: num(r.avgPhraseSec),
    syllPerSec: r.syllPerSec === null || r.syllPerSec === undefined || !Number.isFinite(syll) ? null : syll,
    tempo,
    phrasing,
  }
}

// ───────────────────────── 내보내는 함수 ─────────────────────────

/**
 * 붙여 넣은 글을 발화 단위로 나눈다.
 * @param {string} rawText
 * @param {{maxChars:number, maxUtterances:number}} [limits]
 * @returns {string[]}
 */
export function splitUtterances(rawText, limits = LIMITS.text) {
  const maxChars = Number(limits?.maxChars) > 0 ? Number(limits.maxChars) : LIMITS.text.maxChars
  const maxUtterances = Number(limits?.maxUtterances) > 0 ? Number(limits.maxUtterances) : LIMITS.text.maxUtterances
  // 아주 긴 입력은 앞부분만 본다(빈 줄·링크를 빼고도 충분히 남는 양)
  const raw = String(rawText ?? '').slice(0, maxChars * 3).replace(/\r\n?/g, '\n')
  const out = []
  let total = 0
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || /^(?:https?:\/\/|www\.)\S+$/i.test(trimmed)) continue
    const parts = charLength(trimmed) > 60 && /[.!?…]/.test(trimmed) ? trimmed.split(/(?<=[.!?…])\s+/) : [trimmed]
    for (const part of parts) {
      const text = part.trim()
      if (!text) continue
      if (total >= maxChars || out.length >= maxUtterances) return out
      const chars = Array.from(text)
      const room = maxChars - total
      const piece = chars.length > room ? chars.slice(0, room).join('') : text
      out.push(piece)
      total += Math.min(chars.length, room)
    }
  }
  return out
}

/**
 * 말투 프로필을 만든다.
 * @param {{ textUtterances?: string[], voiceUtterances?: string[], voiceRhythm?: object|null, voiceMeta?: {seconds?:number, onDevice?:boolean}|null, now?: Date|number, sample?: boolean }} input
 * @returns {import('./types.js').StyleProfile}
 */
export function analyzeStyle(input = {}) {
  // null·숫자 같은 엉터리 입력도 빈 입력으로 본다(기본값 = {}은 undefined만 막는다)
  const { textUtterances = [], voiceUtterances = [], voiceRhythm = null, voiceMeta = null, now = new Date(), sample = false } = input && typeof input === 'object' ? input : {}
  const text = cleanUtterances(textUtterances)
  const voice = cleanUtterances(voiceUtterances)
  const all = [...text.map((t) => ({ text: t, source: 'text' })), ...voice.map((t) => ({ text: t, source: 'voice' }))]
  const minCount = all.length < 30 ? 1 : 2

  // 어미와 높임 단계
  const endingTally = createTally()
  const registerCount = { banmal: 0, haeyo: 0, hapsyo: 0, eumseum: 0 }
  let cuteCount = 0
  let matched = 0
  // 추임새와 표현
  const fillerTally = createTally()
  const unigramTally = createTally()
  const bigramTally = createTally()

  for (const { text: u, source } of all) {
    const ending = matchEnding(u)
    if (ending) {
      endingTally.add(ending.form, source, { kind: ending.kind })
      matched++
      if (ending.kind === 'cute') {
        cuteCount++
        registerCount[ending.base]++
      } else {
        registerCount[ending.kind]++
      }
    }
    const raw = rawTokens(u)
    for (const f of findFillers(raw.filter((t) => t.word))) fillerTally.add(f, source)
    // 빠진 어절(숫자·개인정보·웃음)은 null로 남겨, 떨어져 있던 두 낱말을 표현으로 잇지 않는다
    const words = raw.map((t) => (isExpressionToken(t.word) ? t.word : null))
    const seenUni = new Set()
    const seenBi = new Set()
    for (let i = 0; i < words.length; i++) {
      const w = words[i]
      if (!w) continue
      if (isContentWord(w) && !seenUni.has(w)) {
        seenUni.add(w)
        unigramTally.add(w, source)
      }
      const next = words[i + 1]
      if (!next) continue
      const pair = `${w} ${next}`
      if ((isContentWord(w) || isContentWord(next)) && charLength(pair) <= LIMITS.profile.itemMaxChars && !seenBi.has(pair)) {
        seenBi.add(pair)
        bigramTally.add(pair, source)
      }
    }
  }

  const shares = { ...EMPTY_SHARES }
  for (const k of REGISTER_KEYS) shares[k] = matched ? round(registerCount[k] / matched) : 0
  const dominant = matched ? REGISTER_KEYS.reduce((best, k) => (registerCount[k] > registerCount[best] ? k : best), 'banmal') : 'banmal'

  const endings = toItems(endingTally.values(), { minCount, cap: LIMITS.profile.endings })
  const fillers = toItems(fillerTally.values(), { minCount, cap: LIMITS.profile.fillers })
  const expressions = pickExpressions(unigramTally.values(), bigramTally.values(), all.length)

  // 타자 습관(웃음·기호)은 글에서만 본다. 받아쓴 말에는 ㅋㅋ나 문장부호가 거의 없어 비율만 낮춘다.
  const habitSource = text.length ? text : voice
  const laugh = analyzeHabits(habitSource)

  const lengths = text.map((t) => charLength(t))
  const textRhythm = text.length
    ? {
        avgChars: round(lengths.reduce((a, b) => a + b, 0) / text.length, 1),
        shortShare: round(lengths.filter((l) => l <= 8).length / text.length),
        longShare: round(lengths.filter((l) => l >= 40).length / text.length),
      }
    : null
  const rhythmVoice = sanitizeRhythm(voiceRhythm)

  const hasVoice = voice.length > 0 || Boolean(rhythmVoice) || Boolean(voiceMeta && typeof voiceMeta === 'object')
  const voiceSeconds = Number(voiceMeta?.seconds ?? rhythmVoice?.seconds ?? 0)
  const sources = {
    text: text.length ? { chars: text.reduce((n, t) => n + charLength(t), 0), utterances: text.length } : null,
    voice: hasVoice
      ? {
          seconds: Number.isFinite(voiceSeconds) ? round(Math.max(0, voiceSeconds), 1) : 0,
          chars: voice.reduce((n, t) => n + charLength(t), 0),
          utterances: voice.length,
          onDevice: Boolean(voiceMeta?.onDevice),
        }
      : null,
  }

  const picked = pickSamples(all, {
    topEndings: endings.slice(0, 3).map((e) => e.form),
    topFillers: fillers.slice(0, 3).map((f) => f.form),
    topExpressions: new Set(expressions.slice(0, 5).map((x) => x.form)),
    kk: Boolean(laugh.kk),
    hh: Boolean(laugh.hh),
    cry: Boolean(laugh.cry),
    punct: laugh.punct.typical,
  })

  const iso = toIso(now)
  const profile = {
    version: 1,
    createdAt: iso,
    updatedAt: iso,
    sources,
    register: { dominant, shares, cute: matched ? round(cuteCount / matched) : 0 },
    endings,
    fillers,
    expressions,
    laugh,
    rhythm: { text: textRhythm, voice: rhythmVoice },
    samples: picked.map((s) => s.text),
    sampleSources: picked.map((s) => s.source),
    summary: { line: '', tags: [] },
  }
  if (sample) profile.sample = true
  profile.summary = summarizeProfile(profile)
  return profile
}

function pickExpressions(unigrams, bigramsList, utteranceCount) {
  const minCount = utteranceCount > 200 ? 3 : 2
  const uni = unigrams.map((e) => ({ ...e, count: e.text + e.voice })).filter((e) => e.count >= minCount)
  const bi = bigramsList.map((e) => ({ ...e, count: e.text + e.voice })).filter((e) => e.count >= minCount)
  // 두 어절 표현이 그 낱말 쓰임의 60% 이상을 차지하면 낱말 대신 표현을 남긴다
  const keptUni = uni.filter((u) => !bi.some((b) => b.form.split(' ').includes(u.form) && b.count >= 0.6 * u.count))
  return [...keptUni, ...bi]
    .sort((a, b) => b.count - a.count || charLength(b.form) - charLength(a.form) || (a.form < b.form ? -1 : 1))
    .slice(0, LIMITS.profile.expressions)
    .map((e) => ({ form: e.form, count: e.count, share: 0, source: sourceOf(e) }))
}

const REGISTER_PHRASE = { banmal: '반말', haeyo: '해요체', hapsyo: '합쇼체(-습니다)', eumseum: '음슴체(-음/-임)' }
// 저장된 프로필(localStorage)은 바깥 입력이라 배열·숫자 자리에 무엇이 들어 있을지 모른다
const asArray = (v) => (Array.isArray(v) ? v : [])
const asNumber = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const TAG_RULES = [
  { tag: 'ㅋㅋ 자주', value: (p) => p.laugh?.kk?.per100 || 0, threshold: 20 },
  { tag: 'ㅎㅎ 자주', value: (p) => p.laugh?.hh?.per100 || 0, threshold: 20 },
  { tag: 'ㅠㅠ 자주', value: (p) => p.laugh?.cry?.per100 || 0, threshold: 10 },
  { tag: '물결(~) 자주', value: (p) => p.laugh?.punct?.tilde || 0, threshold: 15 },
  { tag: '느낌표 많이', value: (p) => p.laugh?.punct?.exclaim || 0, threshold: 20 },
  { tag: '말줄임표 자주', value: (p) => p.laugh?.punct?.ellipsis || 0, threshold: 15 },
  { tag: '짧게 끊어 쓰기', value: (p) => p.rhythm?.text?.shortShare || 0, threshold: 0.5 },
  { tag: '길게 풀어 쓰기', value: (p) => p.rhythm?.text?.longShare || 0, threshold: 0.3 },
  { tag: '애교 어미', value: (p) => p.register?.cute || 0, threshold: 0.15 },
  { tag: '이모지 자주', value: (p) => (asArray(p.laugh?.emoji).reduce((n, e) => n + asNumber(e?.count), 0) / Math.max(1, asNumber(p.sources?.text?.utterances))) * 100, threshold: 10 },
  { tag: '말 빠른 편', value: (p) => (p.rhythm?.voice?.tempo === 'fast' ? 1 : 0), threshold: 1 },
  { tag: '말 느긋한 편', value: (p) => (p.rhythm?.voice?.tempo === 'slow' ? 1 : 0), threshold: 1 },
  { tag: '끊어 말하기', value: (p) => (p.rhythm?.voice?.phrasing === 'choppy' ? 1 : 0), threshold: 1 },
  { tag: '몰아 말하기', value: (p) => (p.rhythm?.voice?.phrasing === 'flowing' ? 1 : 0), threshold: 1 },
]

/** 프로필 한 줄 요약과 꼬리표 */
export function summarizeProfile(profile) {
  const p = profile && typeof profile === 'object' ? profile : {}
  const rawShares = p.register?.shares && typeof p.register.shares === 'object' ? p.register.shares : EMPTY_SHARES
  const shares = Object.fromEntries(REGISTER_KEYS.map((k) => [k, asNumber(rawShares[k])]))
  const dominant = REGISTER_KEYS.includes(p.register?.dominant) ? p.register.dominant : 'banmal'
  const hasRegister = REGISTER_KEYS.some((k) => shares[k] > 0)
  const endings = asArray(p.endings)
  const fillers = asArray(p.fillers)

  const tags = []
  if (hasRegister) {
    if (dominant === 'eumseum' || shares.eumseum >= 0.3) tags.push('음슴체')
    if (dominant === 'banmal' && shares.banmal >= 0.5) tags.push('반말 위주')
    else if (dominant === 'haeyo' && shares.haeyo >= 0.5) tags.push('해요체 위주')
    else if (dominant === 'hapsyo' && shares.hapsyo >= 0.5) tags.push('합쇼체 위주')
  }
  const extra = TAG_RULES.map((r) => ({ tag: r.tag, ratio: asNumber(r.value(p)) / r.threshold }))
    .filter((r) => r.ratio >= 1)
    .sort((a, b) => b.ratio - a.ratio)
    .map((r) => r.tag)
  for (const t of extra) if (!tags.includes(t)) tags.push(t)

  const named = (x) => x && typeof x.form === 'string' && x.form.trim()
  const ending = (endings.find((e) => named(e) && e.form !== 'ㅁ') || endings.find(named))?.form
  const filler = fillers.find(named)?.form
  const quote = (word, prefix = '') => `‘${prefix}${word}’${josa(word, '으로/로')}`
  const reg = hasRegister ? `${REGISTER_PHRASE[dominant]} 위주에` : ''
  let line
  if (reg && filler && ending) line = `${reg}, ${quote(filler)} 말을 꺼내고 ${quote(ending, '~')} 끝맺는 편이에요.`
  else if (reg && ending) line = `${reg}, ${quote(ending, '~')} 끝맺는 편이에요.`
  else if (reg && filler) line = `${reg}, ${quote(filler)} 말을 꺼내는 편이에요.`
  else if (filler && ending) line = `${quote(filler)} 말을 꺼내고 ${quote(ending, '~')} 끝맺는 편이에요.`
  else if (filler) line = `${quote(filler)} 말을 자주 꺼내는 편이에요.`
  else if (ending) line = `${quote(ending, '~')} 끝맺는 편이에요.`
  else if (hasRegister) line = `${REGISTER_PHRASE[dominant]} 위주로 말하는 편이에요.`
  else line = '아직 뚜렷한 말버릇을 찾지 못했어요. 자주 쓰는 말을 직접 넣어 보세요.'
  return { line, tags: tags.slice(0, 6) }
}

/** 생성 요청 때 서버로 보내는 요약본. 사용자가 직접 넣은 항목을 앞에 둔다. */
export function profileToPayload(profile) {
  const p = profile && typeof profile === 'object' ? profile : {}
  const forms = (list, cap) => {
    const items = (Array.isArray(list) ? list : []).filter((x) => x && typeof x.form === 'string' && x.form.trim())
    const user = items.filter((x) => x.source === 'user')
    const rest = items.filter((x) => x.source !== 'user')
    return [...user, ...rest].slice(0, cap).map((x) => x.form)
  }
  const laugh = p.laugh || {}
  const typical = (h) => (h && typeof h.typical === 'string' ? h.typical : null)
  const topForms = (list) => (Array.isArray(list) ? list : []).slice(0, 3).map((x) => x?.form).filter((x) => typeof x === 'string')
  const shortSamples = (Array.isArray(p.samples) ? p.samples : [])
    .filter((s) => typeof s === 'string' && s.trim())
    .slice(0, 12)
    // 저장된 프로필은 고쳐졌을 수 있으므로, 기기 밖으로 나가기 전에 한 번 더 가린다
    .map((s) => maskPII(Array.from(s).slice(0, LIMITS.profile.sampleMaxChars).join('')).text)
  return {
    register: REGISTER_KEYS.includes(p.register?.dominant) ? p.register.dominant : 'banmal',
    cute: Math.min(1, Math.max(0, asNumber(p.register?.cute))),
    endings: forms(p.endings, 6),
    fillers: forms(p.fillers, 6),
    expressions: forms(p.expressions, 8),
    tail: {
      kk: typical(laugh.kk),
      hh: typical(laugh.hh),
      cry: typical(laugh.cry),
      emoji: topForms(laugh.emoji),
      emoticons: topForms(laugh.emoticons),
      punct: (Array.isArray(laugh.punct?.typical) ? laugh.punct.typical : []).slice(0, 3),
      choseong: topForms(laugh.choseong),
      elongation: asNumber(laugh.elongation) >= 0.08,
    },
    rhythm: {
      avgChars: Number.isFinite(p.rhythm?.text?.avgChars) ? p.rhythm.text.avgChars : null,
      short: asNumber(p.rhythm?.text?.shortShare) >= 0.5,
      tempo: ['slow', 'normal', 'fast'].includes(p.rhythm?.voice?.tempo) ? p.rhythm.voice.tempo : 'unknown',
      phrasing: ['choppy', 'even', 'flowing'].includes(p.rhythm?.voice?.phrasing) ? p.rhythm.voice.phrasing : 'unknown',
    },
    samples: shortSamples,
    hasVoice: Boolean(p.sources?.voice),
    hasText: Boolean(p.sources?.text),
  }
}

const EDITABLE_KINDS = ['endings', 'fillers', 'expressions', 'samples']
const KIND_CAPS = { endings: LIMITS.profile.endings, fillers: LIMITS.profile.fillers, expressions: LIMITS.profile.expressions, samples: LIMITS.profile.samples }

function withSummary(profile, now) {
  const next = { ...profile, updatedAt: toIso(now) }
  next.summary = summarizeProfile(next)
  return next
}

/**
 * 프로필 항목을 직접 넣는다. 바뀐 것이 없으면 받은 프로필을 그대로 돌려준다.
 * @param {object} profile
 * @param {'endings'|'fillers'|'expressions'|'samples'} kind
 * @param {string} form
 */
export function addItem(profile, kind, form, now = new Date()) {
  if (!profile || typeof profile !== 'object' || !EDITABLE_KINDS.includes(kind) || typeof form !== 'string') return profile
  const maxChars = kind === 'samples' ? LIMITS.profile.sampleMaxChars : LIMITS.profile.itemMaxChars
  let value = form.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  if (kind === 'endings') value = value.replace(/^[~\-–]+/, '').trim()
  value = Array.from(value).slice(0, maxChars).join('').trim()
  if (!value) return profile
  const list = Array.isArray(profile[kind]) ? profile[kind] : []
  if (list.length >= KIND_CAPS[kind] + LIMITS.profile.customItems) return profile
  if (kind === 'samples') {
    // 대표 문장은 서버로 전송되므로 연락처 같은 부분을 가린 뒤 넣는다
    const masked = maskPII(value).text
    if (list.includes(masked)) return profile
    return withSummary({ ...profile, samples: [...list, masked], sampleSources: [...alignedSampleSources(profile), 'user'] }, now)
  }
  if (list.some((item) => item && item.form === value)) return profile
  const item = { form: value, count: 0, share: 0, source: 'user' }
  if (kind === 'endings' && SUFFIX_KIND.has(value)) item.kind = SUFFIX_KIND.get(value)
  return withSummary({ ...profile, [kind]: [...list, item] }, now)
}

/** 프로필 항목을 지운다. 없으면 받은 프로필을 그대로 돌려준다. */
export function removeItem(profile, kind, form, now = new Date()) {
  if (!profile || typeof profile !== 'object' || !EDITABLE_KINDS.includes(kind)) return profile
  const list = Array.isArray(profile[kind]) ? profile[kind] : []
  if (kind === 'samples') {
    const sources = alignedSampleSources(profile)
    const keep = list.map((s) => s !== form)
    if (keep.every(Boolean)) return profile
    return withSummary({ ...profile, samples: list.filter((_, i) => keep[i]), sampleSources: sources.filter((_, i) => keep[i]) }, now)
  }
  const next = list.filter((item) => !item || item.form !== form)
  if (next.length === list.length) return profile
  return withSummary({ ...profile, [kind]: next }, now)
}

/** 대표 문장마다 출처(text/voice/user)를 맞춰 둔다. 예전 프로필처럼 출처가 없으면 'unknown'으로 채운다. */
function alignedSampleSources(profile) {
  const samples = asArray(profile?.samples)
  const sources = asArray(profile?.sampleSources)
  return samples.map((_, i) => (['text', 'voice', 'user'].includes(sources[i]) ? sources[i] : 'unknown'))
}

/** 어미 항목의 횟수로 높임 단계 비율을 다시 계산한다(항목은 상위 몇 개뿐이라 어림값이다). */
function registerFromItems(items, fallback) {
  const count = { banmal: 0, haeyo: 0, hapsyo: 0, eumseum: 0 }
  let total = 0
  let cute = 0
  for (const item of asArray(items)) {
    const n = asNumber(item?.count)
    const kind = item?.kind === 'cute' ? CUTE_BASE[item.form] : item?.kind
    if (!n || !REGISTER_KEYS.includes(kind)) continue
    count[kind] += n
    total += n
    if (item.kind === 'cute') cute += n
  }
  if (!total) return fallback && typeof fallback === 'object' ? fallback : { dominant: 'banmal', shares: { ...EMPTY_SHARES }, cute: 0 }
  const shares = {}
  for (const k of REGISTER_KEYS) shares[k] = round(count[k] / total)
  const dominant = REGISTER_KEYS.reduce((best, k) => (count[k] > count[best] ? k : best), 'banmal')
  return { dominant, shares, cute: round(cute / total) }
}

/**
 * 음성 동의를 거둘 때: 목소리에서 나온 말버릇·받아쓴 대표 문장·말 리듬을 프로필에서 걷어 낸다.
 * 글과 말에 모두 나온 항목은 말에서 센 횟수만큼 덜어 글 항목으로 남긴다.
 * 출처 표시가 없는 예전 프로필은 받아쓴 문장을 가려낼 수 없어, 목소리를 쓴 적이 있으면 대표 문장을 모두 지운다.
 */
export function removeVoiceData(profile, now = new Date()) {
  if (!profile || typeof profile !== 'object') return profile
  const hadVoice = Boolean(profile.sources?.voice) || Boolean(profile.rhythm?.voice) || asArray(profile.sampleSources).includes('voice')
  if (!hadVoice) return profile
  const stripItems = (items) =>
    asArray(items).flatMap((item) => {
      if (!item || typeof item !== 'object') return []
      if (item.source === 'voice') return []
      if (item.source !== 'both') return [item]
      const { voiceCount, ...rest } = item
      const count = Math.max(1, asNumber(item.count) - asNumber(voiceCount))
      return [{ ...rest, count, source: 'text' }]
    })
  const sources = alignedSampleSources(profile)
  const tagged = asArray(profile.sampleSources).length > 0
  const keep = sources.map((s) => (tagged ? s !== 'voice' && s !== 'unknown' : s === 'user'))
  const endings = stripItems(profile.endings)
  const next = {
    ...profile,
    endings,
    fillers: stripItems(profile.fillers),
    expressions: stripItems(profile.expressions),
    samples: asArray(profile.samples).filter((_, i) => keep[i]),
    sampleSources: sources.filter((_, i) => keep[i]),
    register: registerFromItems(endings, null),
    sources: { ...(profile.sources || {}), voice: null },
    rhythm: { ...(profile.rhythm || {}), voice: null },
  }
  return withSummary(next, now)
}

function mergeItemLists(base, addition, cap) {
  const merged = new Map()
  for (const item of [...asArray(base), ...asArray(addition)]) {
    if (!item || typeof item.form !== 'string') continue
    const prev = merged.get(item.form)
    if (!prev) {
      merged.set(item.form, { ...item })
      continue
    }
    const sources = new Set([prev.source, item.source])
    const source = sources.has('user') ? 'user' : sources.has('both') || (sources.has('text') && sources.has('voice')) ? 'both' : prev.source
    const next = { ...prev, count: asNumber(prev.count) + asNumber(item.count), source }
    const voiceCount = asNumber(prev.voiceCount) + asNumber(item.voiceCount)
    if (voiceCount) next.voiceCount = voiceCount
    merged.set(item.form, next)
  }
  const all = [...merged.values()]
  const user = all.filter((x) => x.source === 'user')
  const counted = all
    .filter((x) => x.source !== 'user')
    .sort((a, b) => asNumber(b.count) - asNumber(a.count) || (a.form < b.form ? -1 : 1))
    .slice(0, cap)
  const total = counted.reduce((n, x) => n + asNumber(x.count), 0)
  return [...counted.map((x) => ({ ...x, share: total ? round(asNumber(x.count) / total) : 0 })), ...user]
}

/**
 * ‘목소리 녹음 더하기’처럼 새 분석 결과를 지금 프로필에 더한다(지금 프로필을 갈아 치우지 않는다).
 * 웃음·기호 습관과 글 리듬은 글이 있는 쪽을, 말 리듬은 새로 녹음한 쪽을 쓴다.
 */
export function mergeProfiles(base, addition, now = new Date()) {
  if (!isUsableProfile(base)) return addition
  if (!addition || typeof addition !== 'object') return base
  const endings = mergeItemLists(base.endings, addition.endings, LIMITS.profile.endings)
  const samples = []
  const sampleSources = []
  const baseSources = alignedSampleSources(base)
  const addSources = alignedSampleSources(addition)
  asArray(base.samples).forEach((s, i) => {
    samples.push(s)
    sampleSources.push(baseSources[i])
  })
  asArray(addition.samples).forEach((s, i) => {
    if (samples.includes(s) || samples.length >= LIMITS.profile.samples + LIMITS.profile.customItems) return
    samples.push(s)
    sampleSources.push(addSources[i])
  })
  const merged = {
    ...base,
    sources: { text: base.sources?.text || addition.sources?.text || null, voice: addition.sources?.voice || base.sources?.voice || null },
    register: registerFromItems(endings, base.register),
    endings,
    fillers: mergeItemLists(base.fillers, addition.fillers, LIMITS.profile.fillers),
    expressions: mergeItemLists(base.expressions, addition.expressions, LIMITS.profile.expressions),
    laugh: base.sources?.text ? base.laugh : addition.laugh || base.laugh,
    rhythm: { text: base.rhythm?.text || addition.rhythm?.text || null, voice: addition.rhythm?.voice || base.rhythm?.voice || null },
    samples,
    sampleSources,
  }
  if (base.sample || addition.sample) merged.sample = true
  return withSummary(merged, now)
}

/** 생성에 쓸 수 있는 프로필인지 */
export function isUsableProfile(profile) {
  if (!profile || typeof profile !== 'object' || profile.version !== 1) return false
  return EDITABLE_KINDS.some((k) => Array.isArray(profile[k]) && profile[k].length > 0)
}
