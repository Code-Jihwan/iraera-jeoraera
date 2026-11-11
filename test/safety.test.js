// 안전 필터(server/safety) 테스트
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { normalizeForMatch, checkText, checkTrend, checkCandidate, filterStyleTerms, LEXICON_STATS } from '../server/safety/filter.js'
import { ENTRIES, ALLOWLIST, JAMO_PATTERNS, AFFIX_PATTERNS } from '../server/safety/lexicon.js'
import { SAFETY_CATEGORIES } from '../shared/constants.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SEED = JSON.parse(fs.readFileSync(path.join(ROOT, 'server', 'trends', 'seed-trends.json'), 'utf8'))
const CATEGORY_KEYS = Object.keys(SAFETY_CATEGORIES)

const level = (text, context) => checkText(text, { context }).level

/** 각 줄이 기대한 단계로 나오는지 한꺼번에 보고, 틀린 줄을 모두 보여 준다. */
function expectLevels(cases, expected, context = 'output') {
  const wrong = cases.filter((text) => level(text, context) !== expected).map((text) => `${text} → ${level(text, context)}`)
  assert.deepEqual(wrong, [], `${context}에서 '${expected}'가 아닌 문장`)
}

function expectBlockedAs(cases, category, context = 'output') {
  for (const text of cases) {
    const verdict = checkText(text, { context })
    assert.equal(verdict.level, 'block', `막혀야 함: ${text}`)
    assert.equal(verdict.ok, false)
    assert.ok(verdict.categories.includes(category), `${text} → ${verdict.categories.join(',')}`)
  }
}

describe('사전', () => {
  test('모든 항목이 정해진 범주와 세기를 쓴다', () => {
    for (const item of [...ENTRIES, ...JAMO_PATTERNS, ...AFFIX_PATTERNS]) {
      assert.ok(CATEGORY_KEYS.includes(item.category), item.category)
      assert.ok(['block', 'caution'].includes(item.severity))
    }
    assert.ok(Object.isFrozen(ENTRIES) && Object.isFrozen(ALLOWLIST))
  })

  test('LEXICON_STATS는 범주별 개수만 담고 합이 전체와 같다', () => {
    assert.deepEqual(Object.keys(LEXICON_STATS), ['terms', 'byCategory'])
    assert.deepEqual(Object.keys(LEXICON_STATS.byCategory), CATEGORY_KEYS)
    const sum = Object.values(LEXICON_STATS.byCategory).reduce((a, b) => a + b, 0)
    assert.equal(sum, LEXICON_STATS.terms)
    assert.equal(LEXICON_STATS.terms, ENTRIES.length + JAMO_PATTERNS.length + AFFIX_PATTERNS.length)
    assert.ok(LEXICON_STATS.terms > 500)
    assert.equal(LEXICON_STATS.byCategory.privacy, 0)
    assert.ok(Object.isFrozen(LEXICON_STATS))
  })

  test('사전의 모든 낱말은 홀로 쓰면 걸리고, block 낱말은 막힌다', () => {
    const missed = []
    for (const item of [...ENTRIES, ...JAMO_PATTERNS]) {
      const got = level(item.term, 'output')
      if (got === 'ok' || (item.severity === 'block' && got !== 'block')) missed.push(`${item.category}/${item.term} → ${got}`)
    }
    assert.deepEqual(missed, [])
  })

  test('허용 낱말은 홀로 써도 막히지 않는다', () => {
    const blocked = ALLOWLIST.filter((word) => !checkText(word).ok)
    assert.deepEqual(blocked, [])
  })
})

describe('범주별로 막는다', () => {
  test('욕설', () => expectBlockedAs(['시발', '아 씨발 진짜', '병신같네', '존나 웃겨', '개새끼', '미친년', '지랄하네', 'ㅅㅂ', 'fuck', 'tlqkf'], 'profanity'))
  test('혐오·비하', () => expectBlockedAs(['김치녀', '한남충', '짱깨', '틀딱들', '급식충', '정신병자', '전라디언', '쪽바리', '시체팔이'], 'hate'))
  test('선정적 표현', () => expectBlockedAs(['섹스', '야동 추천', '보지', '포르노', 'sex', '로리콘', '원조교제'], 'sexual'))
  test('사건·참사', () => expectBlockedAs(['참사', '이태원참사', '희생자 추모', '세월호', '유가족', '분향소', '연쇄살인'], 'tragedy'))
  test('자해·자살', () => expectBlockedAs(['자살', '극단적 선택', '극단적선택', '스스로 목숨을 끊었다'], 'self_harm'))
  test('실존 인물 조롱 별명', () => expectBlockedAs(['문재앙', '닭근혜'], 'real_person'))
  test('정치 진영 비하', () => expectBlockedAs(['빨갱이', '좌빨', '수꼴'], 'other'))
  test('개인정보', () => expectBlockedAs(['연락 줘 010-1234-5678', '메일은 test@example.com', 'https://example.com 들어가 봐', '900101-1234567', '@my_handle 팔로우'], 'privacy'))

  test('여러 범주가 함께 걸리면 막는 범주만 정해진 순서로 담는다', () => {
    assert.deepEqual(checkText('시발 김치녀').categories, ['profanity', 'hate'])
    assert.deepEqual(checkText('김치녀 시발').categories, ['profanity', 'hate'])
    // 막는 범주가 있으면 주의 범주(사망)는 빠진다
    assert.deepEqual(checkText('시발 사망'), { ok: false, level: 'block', categories: ['profanity'] })
  })

  test('형태소 꼴: …충은 표시하고 평범한 …충 낱말은 그대로 둔다', () => {
    expectLevels(['캠핑충', '흡연충들', '설명충이네', '진지충 등장'], 'caution')
    expectLevels(['곤충', '해충 퇴치', '기생충 봤어?', '보충 수업', '대충 하자', '충전기', '충분해', '충격', '충치 치료', '고충이 많아', '확충', '절충안'], 'ok')
  })

  test('형태소 꼴: 씹…은 표시하고 ‘씹다’ 활용형은 그대로 둔다', () => {
    expectLevels(['씹덕'], 'caution')
    expectLevels(['껌 씹는 소리', '씹어 먹는 비타민', '곱씹을수록 좋아', '말을 씹혔어'], 'ok')
  })
})

describe('돌려 쓴 꼴', () => {
  const ZWSP = String.fromCodePoint(0x200b)
  const SOFT_HYPHEN = String.fromCodePoint(0xad)
  const BOM = String.fromCodePoint(0xfeff)

  test('띄어쓰기·문장부호·숫자·영문을 끼워 넣어도 잡는다', () => {
    expectBlockedAs(['시 발', '씨 발', '시.발', '씨~발', '시1발', '씨8발', '시 1 발', '병1신', '병ㅡ신', '개_새_끼', '개.새.끼', '개x새끼', '존 나 웃겨'], 'profanity')
    expectBlockedAs(['섹 스', '섹.스'], 'sexual')
  })
  test('같은 글자 되풀이·늘여 쓴 소리를 줄여서 잡는다', () => {
    expectBlockedAs(['씨이이이발', '시이바알', '존나아아아', '지이이랄', '병시이인', '개새끼ㅣㅣㅣ'], 'profanity')
  })
  test('풀어 쓴 자모를 모아서 잡는다', () => {
    expectBlockedAs(['ㅅㅣ발', 'ㅅㅣㅂㅏㄹ', 'ㅂㅕㅇ신', 'ㅅ ㅣ 1 발~~'], 'profanity')
  })
  test('보이지 않는 글자·전각 문자·대문자를 걷어 내고 잡는다', () => {
    expectBlockedAs([`시${ZWSP}발`, `시${SOFT_HYPHEN}발`, `씨${BOM}발`, 'ＦＵＣＫ', 'FuCk', 'ｓｉｂａｌ'], 'profanity')
    expectBlockedAs(['ｓｅｘ'], 'sexual')
  })
  test('조합용 자모(NFD)로 들어온 글도 잡는다', () => {
    expectBlockedAs(['시발'.normalize('NFD'), String.fromCodePoint(0x1109, 0x1107)], 'profanity')
  })
  test('ㅋㅋ·문장부호·이모지 바로 뒤에 붙여 써도 낱말 첫머리로 본다', () => {
    expectBlockedAs(['ㅋㅋㅋ시발', '아,시발', '😂시발'], 'profanity')
  })

  test('normalizeForMatch: raw / compact / squeezed', () => {
    assert.deepEqual(normalizeForMatch('ㅅ ㅣ 1 발~~'), { raw: 'ㅅ ㅣ 1 발~~', compact: '시발', squeezed: '시발' })
    assert.deepEqual(normalizeForMatch('씨이이이발!!'), { raw: '씨이이이발!!', compact: '씨이이이발', squeezed: '씨발' })
    assert.deepEqual(normalizeForMatch('ＳＥＸ'), { raw: 'sex', compact: 'sex', squeezed: 'sex' })
    assert.equal(normalizeForMatch(`시${ZWSP}발`).raw, '시발')
    // 호환 자모는 NFKC를 거쳐도 그대로 남는다
    assert.equal(normalizeForMatch('ㅋㅋ ㅅㅂ').raw, 'ㅋㅋ ㅅㅂ')
    assert.equal(normalizeForMatch('좋아ㅏㅏㅏ').squeezed, '좋아')
    // 맞춤용 꼴에서는 한글 사이의 띄어 쓴 숫자도 걷어 낸다(원문은 그대로 둔다)
    assert.equal(normalizeForMatch('오후 5시 발표').compact, '오후시발표')
    assert.deepEqual(normalizeForMatch(null), { raw: '', compact: '', squeezed: '' })
    assert.deepEqual(normalizeForMatch({}), { raw: '', compact: '', squeezed: '' })
  })
})

describe('허용 낱말과 낱말 경계', () => {
  test('막는 말을 품은 평범한 낱말은 통과한다', () => {
    expectLevels([
      '시발점이 어디야', '시바견 너무 귀여워', '새끼손가락 걸고 약속', '병아리 키우는 중', '솜씨 발휘해 봐', '날씨발표 봤어?',
      '유니섹스 스타일', '애널리스트 보고서', '자위대 관련 뉴스', '칼로리 폭탄', '땅따먹기 하자', '물걸레 청소',
      '한남동 맛집', '호모 사피엔스', '라운지에서 커피', '자살골 넣었어', '살인 미소', '살인적인 스케줄', '스무 살인데 벌써',
      '몇 살인지 알아?', '유서 깊은 동네', '멘탈 붕괴 직전', '동공 지진 왔다', '예매 전쟁 승리', '마약 김밥 먹자', '비주얼 테러 수준',
      '벙어리장갑 끼고 나가', '방화벽 설정', '노빠꾸 직진', '전염병 예방', '8등신 비율', '팔등신', '3개년 계획', '삼시세끼 챙기기',
    ], 'ok')
  })

  test('낱말 사이에 걸친 우연한 맞춤은 막지 않는다', () => {
    expectLevels([
      '다시 발표할게요', '혹시 발 사이즈 몇이야?', '역시 발라드는 겨울이지', '동시 발매라니', '아저씨 바로 오신대', '다시 바꿔 줄래?',
      '일시불로 할게요', '오후 5시 발표', '자 살 빼자', '애 널 닮았다', '아 발 아파', '씨 발아 실험', '보존 나중에 해',
      '영화 안 보지?', '해보지 뭐', '남자지 뭐', '혼자지만 괜찮아', '왁자지껄', '날개같은 이불', '작년보다 낫다', '이미 친구잖아',
    ], 'ok')
  })

  test('허용 낱말 속에 욕설을 숨길 수는 없다', () => {
    // ‘시발점’은 붙여 썼을 때만 허용 낱말이고, ‘솜씨발휘’의 앞말은 같은 낱말 안에 있어야 한다
    expectBlockedAs(['시발 점심 먹자', '날 씨발', '아저 씨발'], 'profanity')
  })

  test('짧은 말은 낱말 첫머리에서만 맞춘다', () => {
    assert.equal(level('시발'), 'block')
    assert.equal(level('다시발표'), 'ok')
    assert.equal(level('정보지'), 'ok')
    assert.equal(level('보지'), 'block')
  })
})

describe('초성 줄임말', () => {
  test('욕설 초성을 잡는다', () => {
    expectBlockedAs(['ㅅㅂ', 'ㅆㅂ', 'ㅂㅅ', 'ㅄ', 'ㅈㄴ 웃겨', 'ㅅ ㅂ', 'ㅅ.ㅂ', 'ㅅ1ㅂ', 'ㅅㅂㅅㅂ', 'ㅅㅂㅂㅂ', 'ㅅㅂㅋㅋㅋ', 'ㅋㅋㅋㅂㅅ', '아ㅅㅂ진짜', 'ㅂㅅ같네'], 'profanity')
  })
  test('주의 초성은 표시만 한다', () => {
    expectLevels(['ㅁㅊ', 'ㅗ', 'ㅗㅗㅗ'], 'caution')
  })
  test('평범한 초성 줄임말은 통과한다', () => {
    expectLevels(['ㅇㅇ', 'ㄴㄴ', 'ㄱㄱ', 'ㅇㅈ', 'ㄹㅇ', 'ㅊㅋ', 'ㄱㅅ', 'ㅈㅅ합니다', 'ㅇㅋ', 'ㄷㄷ', 'ㅂㅂ', 'ㅎㅇ', 'ㄱㅊ', 'ㅅㄱ', 'ㅋㅋㅋㅋ', 'ㅎㅎ', 'ㅠㅠ', 'ㅇㅅㅇ', 'ㅎㅅㅎ'], 'ok')
  })
  test('줄임말을 이어 써서 우연히 생긴 꼴은 잡지 않는다', () => {
    // 감사 + 바이바이, 바이바이 + 수고
    expectLevels(['ㄱㅅ ㅂㅂ', 'ㄱㅅㅂㅂ', 'ㅂㅂ ㅅㄱ', 'ㅂㅂㅅㄱ'], 'ok')
  })
})

describe('맥락: 트렌드 / 결과물 / 입력', () => {
  test('사건·사고 표지는 트렌드 단계에서 막고, 결과물·입력에서는 표시만 한다', () => {
    for (const text of ['사망', '교통사고 소식', '실종', '압사 직전', '납치', '태풍', '화재']) {
      assert.equal(level(text, 'trend'), 'block', text)
      assert.equal(level(text, 'output'), 'caution', text)
      assert.equal(level(text, 'input'), 'caution', text)
      assert.deepEqual(checkText(text, { context: 'output' }).categories, ['tragedy'])
    }
  })
  test('참사·추모처럼 재난을 직접 가리키는 말은 어디서나 막는다', () => {
    for (const text of ['참사', '추모', '유족', '희생자', '분향소']) {
      for (const context of ['trend', 'output', 'input']) assert.equal(level(text, context), 'block', `${context}: ${text}`)
    }
  })
  test('일상 과장 표현은 결과물에서 막지 않는다', () => {
    for (const text of ['웃겨 죽겠다', '귀여워서 사망', '배고파 죽을 것 같아', '심장 납치당함', '내 월급 실종', '출근길 압사 직전']) {
      assert.equal(checkText(text, { context: 'output' }).ok, true, text)
    }
  })
  test('자해를 떠올리게 하는 말·정치 쟁점은 트렌드 단계에서만 막는다', () => {
    assert.equal(level('죽고 싶다', 'trend'), 'block')
    assert.equal(level('죽고 싶다', 'output'), 'caution')
    assert.equal(level('대통령', 'trend'), 'block')
    assert.equal(level('대통령', 'output'), 'caution')
  })
  test('욕설·혐오의 주의 단계는 맥락이 바뀌어도 주의다', () => {
    assert.equal(level('미친 듯이 웃었어', 'trend'), 'caution')
    assert.equal(level('홍어 냄새', 'trend'), 'caution')
  })
  test('알 수 없는 맥락은 결과물 기준으로 본다', () => {
    assert.deepEqual(checkText('사망', { context: 'nope' }), checkText('사망', { context: 'output' }))
    assert.deepEqual(checkText('사망', null), checkText('사망'))
  })
})

describe('평범한 말은 통과한다', () => {
  /** 예시 트렌드의 키워드·문형·완성형·비틀기·상황 구절·빈칸 기본값 */
  function seedTexts(trend) {
    const engine = trend.engine ?? {}
    return [
      trend.keyword,
      trend.pattern,
      ...Object.values(engine.forms ?? {}),
      ...(engine.twists ?? []),
      ...(engine.contexts ?? []),
      ...(engine.slot?.defaults ?? []),
    ].filter((text) => typeof text === 'string')
  }

  test('예시 트렌드는 모두 트렌드 필터를 통과한다', () => {
    assert.ok(SEED.trends.length >= 20)
    for (const trend of SEED.trends) assert.deepEqual(checkTrend(trend), { ok: true, level: 'ok', categories: [] }, trend.id)
  })

  test('예시 트렌드의 키워드와 모든 꼴은 어느 맥락에서도 걸리지 않는다', () => {
    const flagged = []
    for (const trend of SEED.trends) {
      for (const text of seedTexts(trend)) {
        for (const context of ['trend', 'output', 'input']) {
          if (level(text, context) !== 'ok') flagged.push(`${trend.id} ${context}: ${text}`)
        }
      }
    }
    assert.deepEqual(flagged, [])
  })

  test('일상 문장·유행어 40여 개', () => {
    expectLevels([
      '오히려 좋아', '킹받네 진짜', '폼 미쳤다', '중요한 건 꺾이지 않는 마음', '갓생 산다', '알잘딱깔센', '점메추 좀', '국룰이지',
      '떡볶이는 못 참지', '월요일은 못 참잖아', '야근은 못 참거든', '우리 집 붕세권이야', '난리자베스', '책없쾌야', '딸깍이면 끝이야',
      '가보자고', '동결건조하고 싶어', '모르는 개 산책이지', '첫눈 오면 만나자', '롱패딩 꺼냈다', '연말 모임 언제야', '붕어빵 사 왔어',
      '어쩔티비', '존맛탱', '개웃겨 진짜', '개꿀이다', 'ㅋㅋㅋㅋ 개웃기네', '아 진짜 약간 그렇거든', '근데 솔직히 좀 별로야',
      '밥 먹었어?', '오늘 급식 돈가스래', '퇴근하고 싶다', '금요일 퇴근 야르', '새끼 고양이 입양했어', '고추장 떡볶이',
      '어묵 국물 최고', '흑역사 생성', '잘 살자 우리', '오빠 바빠?', '외계인 가설', '노래방 가자', '대박 사건', '사고 쳤다',
      '12시 18분에 보자', '2018년에 갔어', '충전기 어디 있어?', '정보 좀요', '이 떡볶이 가게 정보', '피라미드에도 악플이 달린다',
    ], 'ok')
  })

  test('뜻이 둘인 말과 과장 표현은 표시만 하고 통과시킨다', () => {
    for (const text of ['미친 듯이 웃었어', '불이 꺼져 있네', '생선 대가리 조림', '죽어라 공부했는데', '흑산도 홍어', '초딩 입맛']) {
      assert.equal(checkText(text).ok, true, text)
    }
  })
})

describe('checkTrend', () => {
  const draft = (fields) => ({ keyword: '퇴근길', pattern: null, meaning: '', source: { type: 'youtube', label: 'YouTube 인기 차트', url: null, title: null }, ...fields })

  test('키워드·문형·뜻·제목 가운데 하나라도 걸리면 막는다', () => {
    assert.equal(checkTrend(draft({})).ok, true)
    assert.deepEqual(checkTrend(draft({ keyword: '시발' })).categories, ['profanity'])
    assert.equal(checkTrend(draft({ pattern: '{X} 존나 좋아' })).ok, false)
    assert.equal(checkTrend(draft({ meaning: '사고로 숨진 사람을 흉내 내는 말' })).ok, false)
    assert.equal(checkTrend(draft({ title: '이태원 참사 그 후' })).ok, false)
    assert.equal(checkTrend(draft({ source: { title: '김치녀 레전드' } })).ok, false)
  })
  test('트렌드 단계에서는 사건·사고 표지가 있으면 막는다', () => {
    assert.deepEqual(checkTrend(draft({ keyword: '교통사고' })), { ok: false, level: 'block', categories: ['tragedy'] })
  })
  test('객체가 아니면 막는다', () => {
    for (const bad of [null, undefined, 'x', 3, []]) assert.equal(checkTrend(bad).ok, false)
  })
})

describe('checkCandidate', () => {
  const candidate = (fields) => ({ text: '오히려 좋거든', examples: ['비 와서 약속 취소됐는데 오히려 좋거든', '버스 놓쳤는데 오히려 좋거든'], why: '‘오히려 좋아’에 내 말끝 ‘~거든’을 붙였어요.', ...fields })

  test('문구와 예문이 깨끗하면 통과한다', () => {
    assert.deepEqual(checkCandidate(candidate({})), { ok: true, level: 'ok', categories: [] })
  })
  test('문구나 예문 하나만 걸려도 막는다', () => {
    assert.equal(checkCandidate(candidate({ text: '오히려 좋아 시발' })).ok, false)
    assert.deepEqual(checkCandidate(candidate({ examples: ['괜찮은 예문', '이건 ㅅㅂ 예문'] })).categories, ['profanity'])
    assert.equal(checkCandidate(candidate({ examples: ['연락은 010-1234-5678', '괜찮은 예문'] })).ok, false)
    assert.equal(checkCandidate(candidate({ why: '세월호를 비틀었어요.' })).ok, false)
  })
  test('예문의 주의 표시도 모아 준다', () => {
    assert.deepEqual(checkCandidate(candidate({ examples: ['귀여워서 사망', '괜찮은 예문'] })), { ok: true, level: 'caution', categories: ['tragedy'] })
  })
  test('모양이 잘못된 후보', () => {
    for (const bad of [null, 'x', 1, []]) assert.equal(checkCandidate(bad).ok, false)
    assert.equal(checkCandidate({ text: '오히려 좋아', examples: null }).ok, true)
    assert.equal(checkCandidate({ text: '오히려 좋아', examples: [{}] }).ok, false)
    assert.equal(checkCandidate({ text: { nested: '시발' } }).ok, false)
  })
})

describe('filterStyleTerms', () => {
  test('막히는 말투 요소만 빼고 순서를 지킨다', () => {
    assert.deepEqual(filterStyleTerms(['거든', '존나', '약간', 'ㅅㅂ', '잖아', '개새끼', '진짜']), ['거든', '약간', '잖아', '진짜'])
  })
  test('주의 단계 요소와 기호·이모지·초성은 남긴다', () => {
    const terms = ['미친', '~', '!!', '…', '^^', ';;', 'ㅇㅈ', 'ㄹㅇ', 'ㅋㅋㅋ', '😂', '✨']
    assert.deepEqual(filterStyleTerms(terms), terms)
  })
  test('개인정보와 문자열이 아닌 값은 뺀다', () => {
    assert.deepEqual(filterStyleTerms(['010-1234-5678', 3, null, {}, '약간']), ['약간'])
  })
  test('배열이 아니면 빈 배열', () => {
    for (const bad of [null, undefined, '거든', 3, {}]) assert.deepEqual(filterStyleTerms(bad), [])
  })
})

describe('결과에는 걸린 낱말이 없다', () => {
  test('모든 사전 항목에 대해 결과는 ok·level·범주 키만 담는다', () => {
    for (const item of [...ENTRIES, ...JAMO_PATTERNS]) {
      const verdict = checkText(`아 ${item.term} 진짜`)
      assert.deepEqual(Object.keys(verdict), ['ok', 'level', 'categories'])
      assert.equal(typeof verdict.ok, 'boolean')
      assert.ok(['ok', 'caution', 'block'].includes(verdict.level))
      for (const category of verdict.categories) assert.ok(CATEGORY_KEYS.includes(category))
      // 범주 이름(sexual 등)을 걷어 낸 나머지에도 낱말이 없어야 한다
      const rest = JSON.stringify(verdict).replace(new RegExp(CATEGORY_KEYS.join('|'), 'g'), '')
      assert.ok(!rest.includes(item.term), '결과에 낱말이 들어 있다')
    }
  })
  test('결과 객체는 호출마다 새로 만든다', () => {
    const first = checkText('시발')
    first.categories.push('hate')
    assert.deepEqual(checkText('시발').categories, ['profanity'])
  })
})

describe('잘못된 입력', () => {
  test('빈 값은 통과, 알 수 없는 꼴은 막는다', () => {
    for (const empty of [null, undefined, '', '   ']) assert.deepEqual(checkText(empty), { ok: true, level: 'ok', categories: [] })
    assert.equal(checkText(123).ok, true)
    assert.equal(checkText(true).ok, true)
    for (const bad of [{}, [], ['시발'], () => '시발', Symbol('x')]) assert.deepEqual(checkText(bad), { ok: false, level: 'block', categories: ['other'] })
  })
  test('너무 긴 글은 끝까지 보지 못하므로 막는다', () => {
    // 한 번에 7글자: 600번이면 4200자, 500번이면 3500자
    assert.equal(checkText('오히려 좋아 '.repeat(600)).ok, false)
    assert.equal(checkText('오히려 좋아 '.repeat(500)).ok, true)
  })
  test('긴 입력에서도 시간이 선형으로 늘어난다', () => {
    const started = performance.now()
    for (const text of ['a1'.repeat(1999), 'ㅋ'.repeat(3999), '시'.repeat(3999), '가 '.repeat(1999)]) checkText(text)
    assert.ok(performance.now() - started < 500)
  })
})

test('200자 글 한 번 검사가 평균 1ms보다 훨씬 짧다', () => {
  const text = '오늘 진짜 킹받네 ㅋㅋㅋ 근데 오히려 좋아. 떡볶이는 못 참지! 퇴근하고 친구랑 한강 가서 야경 보면서 치킨 먹고 싶다. 아 근데 내일 월요일이라 갓생 살아야 하는데 알람 다섯 개 맞춰 놔야지. 중요한 건 꺾이지 않는 마음이니까 가보자고~ 우리 집 붕세권이라 겨울이 제일 좋아. 점메추 좀!!'
  assert.ok(text.length >= 150 && text.length <= 220)
  for (let i = 0; i < 100; i++) checkText(text)
  const rounds = 2000
  const started = performance.now()
  for (let i = 0; i < rounds; i++) checkText(text)
  const average = (performance.now() - started) / rounds
  assert.ok(average < 0.5, `평균 ${average.toFixed(3)}ms`)
})
