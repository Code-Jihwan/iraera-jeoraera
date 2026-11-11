// 규칙 기반 조합 엔진과 문형 틀 문법 테스트. 실제 예시 트렌드 데이터(seed-trends.json)로 돌린다.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { TECHNIQUE_IDS } from '../shared/constants.js'
import { charLength, compose, splitTail } from '../shared/hangul.js'
import { generateLocal } from '../server/generate/local-engine.js'
import { fillTemplate, usesSlot } from '../server/generate/template.js'

const seed = JSON.parse(readFileSync(new URL('../server/trends/seed-trends.json', import.meta.url), 'utf8')).trends
const frames = seed.filter((trend) => trend.engine?.asFrame === true)
const trendOf = (id) => seed.find((trend) => trend.id === id)
const REGISTERS = ['banmal', 'haeyo', 'hapsyo', 'eumseum']
const TOPICS = ['', '떡볶이', '월요일', '야근']

const emptyTail = { kk: null, hh: null, cry: null, emoji: [], emoticons: [], punct: [], choseong: [], elongation: false }
const emptyRhythm = { avgChars: null, short: false, tempo: 'unknown', phrasing: 'unknown' }

/** 다듬어진 ProfilePayload 모양의 프로필을 만든다. */
function profile({ tail = {}, rhythm = {}, ...rest } = {}) {
  return {
    register: 'banmal',
    cute: 0,
    endings: [],
    fillers: [],
    expressions: [],
    samples: [],
    hasVoice: false,
    hasText: true,
    ...rest,
    tail: { ...emptyTail, ...tail },
    rhythm: { ...emptyRhythm, ...rhythm },
  }
}

const PROFILES = {
  '반말+ㅋㅋ': profile({ register: 'banmal', endings: ['거든', '잖아', '네', '는데'], tail: { kk: 'ㅋㅋㅋ' } }),
  해요체: profile({ register: 'haeyo', endings: ['요', '죠', '네요'] }),
  음슴체: profile({ register: 'eumseum', endings: ['임'] }),
  애교: profile({ register: 'banmal', cute: 0.4, endings: ['용', '당'] }),
}

/** 정규화: 소문자, 공백과 말끝 꾸밈 제거 (엔진의 유일성 기준을 테스트에서 따로 계산한다) */
const normalized = (text) => splitTail(text.toLowerCase()).core.replace(/\s+/g, '')
const textsOf = (candidates) => candidates.map((candidate) => candidate.text)

/** 말끝 습관이 붙지 않는 ‘말로 할 때’ 상황으로 만들어 문구 자체를 본다. */
function spoken(trendId, profileInput, topic = '', extra = {}) {
  return generateLocal({ profile: profileInput, trend: trendOf(trendId), options: { situation: 'talk', spice: 'medium', topic }, frames, ...extra })
}

describe('문형 틀 문법 (template.js)', () => {
  test('{X}와 {X1}, {form}을 채운다', () => {
    assert.equal(fillTemplate('{X} 정보', { X: '떡볶이' }), '떡볶이 정보')
    assert.equal(fillTemplate('우리 집 {X1}세권', { X: '붕어빵' }), '우리 집 붕세권')
    assert.equal(fillTemplate('{X}? {form}', { X: '비 오는 날', form: '오히려 좋아' }), '비 오는 날? 오히려 좋아')
  })

  test('{X|은/는}은 받침에 맞는 조사를 고른다', () => {
    assert.equal(fillTemplate('{X|은/는} 못 참지', { X: '떡볶이' }), '떡볶이는 못 참지')
    assert.equal(fillTemplate('{X|은/는} 못 참지', { X: '월요일' }), '월요일은 못 참지')
    assert.equal(fillTemplate('{X|은/는} 못 참지', { X: '야근' }), '야근은 못 참지')
    assert.equal(fillTemplate('창문 열면 {X|이/가} 보여,', { X: '도서관' }), '창문 열면 도서관이 보여,')
    assert.equal(fillTemplate('창문 열면 {X|이/가} 보여,', { X: '바다' }), '창문 열면 바다가 보여,')
    assert.equal(fillTemplate('중요한 건 꺾이지 않는 {X|이에요/예요}', { X: '마음' }), '중요한 건 꺾이지 않는 마음이에요')
    assert.equal(fillTemplate('중요한 건 꺾이지 않는 {X|이에요/예요}', { X: '출근 의지' }), '중요한 건 꺾이지 않는 출근 의지예요')
  })

  test('영문·숫자로 끝나는 말도 읽는 소리에 맞춰 조사를 붙인다', () => {
    assert.equal(fillTemplate('{X|은/는} 국룰', { X: 'AI' }), 'AI는 국룰')
    assert.equal(fillTemplate('{X|은/는} 국룰', { X: 'BGM' }), 'BGM은 국룰')
    assert.equal(fillTemplate('{X|은/는} 국룰', { X: '3' }), '3은 국룰')
  })

  test('빈칸 틀에 넣을 말이 없으면 빈 문자열, 빈칸이 없는 틀은 그대로 만든다', () => {
    assert.equal(fillTemplate('{X} 정보', { X: '' }), '')
    assert.equal(fillTemplate('{X|은/는} 못 참지'), '')
    assert.equal(fillTemplate('우리 집 {X1}세권', { X: '   ' }), '')
    assert.equal(fillTemplate('이건 못 참지'), '이건 못 참지')
    assert.equal(fillTemplate('{form}!', { form: '야르' }), '야르!')
  })

  test('모르는 토큰은 그대로 두고, 겹친 공백과 앞뒤 공백은 정리한다', () => {
    assert.equal(fillTemplate('{Y} {X} {X2} {x}', { X: '가' }), '{Y} 가 {X2} {x}')
    assert.equal(fillTemplate('  {X}   완전  {form} ', { X: '오늘 급식', form: '난리자베스야' }), '오늘 급식 완전 난리자베스야')
  })

  test('넣는 말 안의 특수 문자나 토큰 모양은 다시 풀지 않는다', () => {
    assert.equal(fillTemplate('{X} 정보', { X: '$& $1' }), '$& $1 정보')
    assert.equal(fillTemplate('{X} {form}', { X: '{form}', form: '끝' }), '{form} 끝')
  })

  test('문자열이 아닌 입력에도 죽지 않는다', () => {
    for (const template of [null, undefined, 42, {}, []]) assert.equal(fillTemplate(template, { X: '가' }), '')
    assert.equal(fillTemplate('{X} 정보', null), '')
    assert.equal(fillTemplate('{X} 정보', { X: 7 }), '7 정보')
    assert.equal(usesSlot('{X|은/는} 못 참지'), true)
    assert.equal(usesSlot('{X1}세권'), true)
    assert.equal(usesSlot('{form} 이건 못 참지'), false)
    assert.equal(usesSlot(null), false)
  })
})

describe('모든 예시 트렌드 × 높임 단계 × 프로필 × 넣고 싶은 말', () => {
  const WRONG_PARTICLES = /떡볶이은|떡볶이을|떡볶이이 |월요일는|월요일를|월요일가 |야근는|야근를|야근가 |‘떡볶이’을|‘월요일’를|‘야근’를/

  for (const [name, base] of Object.entries(PROFILES)) {
    test(`${name} 프로필: 후보 5개 이상, 형식과 조사가 바르다`, () => {
      for (const trend of seed) {
        for (const register of REGISTERS) {
          for (const topic of TOPICS) {
            const label = `${trend.id} / ${register} / ${topic || '(없음)'}`
            const candidates = generateLocal({ profile: { ...base, register }, trend, options: { situation: 'chat', spice: 'medium', topic }, frames })
            assert.ok(candidates.length >= 5, `${label}: 후보 ${candidates.length}개`)
            assert.equal(new Set(candidates.map((c) => normalized(c.text))).size, candidates.length, `${label}: 겹치는 후보`)
            for (const c of candidates) {
              const shown = [c.text, c.why, ...c.examples].join(' | ')
              assert.doesNotMatch(shown, /[{}]/, `${label}: 중괄호 — ${shown}`)
              assert.doesNotMatch(shown, / {2,}/, `${label}: 겹친 공백 — ${shown}`)
              assert.doesNotMatch(shown + c.memeElement + c.styleElements.join(), /undefined|null|NaN/, `${label}: 빈 값 — ${shown}`)
              assert.doesNotMatch(shown, WRONG_PARTICLES, `${label}: 조사 — ${shown}`)
              assert.ok(charLength(c.text) <= 48, `${label}: 너무 김 — ${c.text}`)
              assert.equal(c.text, c.text.trim())
              assert.ok(TECHNIQUE_IDS.includes(c.technique), `${label}: 방식 ${c.technique}`)
              assert.equal(c.examples.length, 2, `${label}: 예문 수`)
              assert.notEqual(c.examples[0], c.examples[1], `${label}: 같은 예문`)
              for (const example of c.examples) assert.ok(example.endsWith(` ${c.text}`), `${label}: 예문에 문구가 그대로 없음 — ${example}`)
              assert.ok(Array.isArray(c.styleElements) && c.styleElements.every((el) => typeof el === 'string' && el))
              assert.ok(c.memeElement, `${label}: 밈 요소`)
              assert.match(c.why, /요\.$/, `${label}: 설명 — ${c.why}`)
            }
          }
        }
      }
    })
  }

  test('조사가 받침에 맞게 붙는다: 떡볶이는 · 월요일은 · 야근은', () => {
    const cases = [
      ['떡볶이', '떡볶이는'],
      ['월요일', '월요일은'],
      ['야근', '야근은'],
    ]
    for (const id of ['seed-mot-chamji', 'seed-gungnul', 'seed-ttalkkak', 'seed-chaegeopkwae', 'seed-gatsaeng']) {
      for (const [topic, expected] of cases) {
        const texts = textsOf(spoken(id, PROFILES['반말+ㅋㅋ'], topic))
        assert.ok(texts.some((text) => text.startsWith(`${expected} `)), `${id}: ‘${expected}’로 시작하는 후보가 없음 — ${texts.join(' / ')}`)
      }
    }
    const whys = spoken('seed-mot-chamji', PROFILES['반말+ㅋㅋ'], '월요일').map((c) => c.why)
    assert.ok(whys.some((why) => why.includes('‘월요일’을 넣')), whys.join(' / '))
    const examples = spoken('seed-segwon', PROFILES['반말+ㅋㅋ'], '떡볶이').flatMap((c) => c.examples)
    assert.ok(examples.some((example) => example.startsWith('창문 열면 떡볶이가 보여,')), examples.join(' / '))
  })
})

describe('어미 입히기: 손으로 확인한 활용', () => {
  const banmal = (...endings) => profile({ register: 'banmal', endings })
  const haeyo = (...endings) => profile({ register: 'haeyo', endings })

  /** [트렌드, 프로필, 넣고 싶은 말, 나와야 하는 문구] */
  const EXPECTED = [
    ['seed-ohiryeo-joa', banmal('거든', '잖아', '네'), '', '오히려 좋거든'],
    ['seed-ohiryeo-joa', banmal('거든', '잖아', '네'), '', '오히려 좋잖아'],
    ['seed-ohiryeo-joa', banmal('거든', '잖아', '네'), '', '오히려 좋네'],
    ['seed-ohiryeo-joa', banmal('는데'), '', '오히려 좋은데'],
    ['seed-ohiryeo-joa', banmal('긴 해', '구나', '다니까'), '', '오히려 좋긴 해'],
    ['seed-ohiryeo-joa', banmal('긴 해', '구나', '다니까'), '', '오히려 좋구나'],
    ['seed-ohiryeo-joa', banmal('긴 해', '구나', '다니까'), '', '오히려 좋다니까'],
    ['seed-ohiryeo-joa', banmal('용', '당'), '', '오히려 좋아용'],
    ['seed-ohiryeo-joa', banmal('용', '당'), '', '오히려 좋당'],
    ['seed-ohiryeo-joa', banmal('엉'), '', '오히려 좋앙'],
    ['seed-ohiryeo-joa', haeyo('죠', '네요', '거든요'), '', '오히려 좋죠'],
    ['seed-ohiryeo-joa', haeyo('죠', '네요', '거든요'), '', '오히려 좋네요'],
    ['seed-ohiryeo-joa', haeyo('죠', '네요', '거든요'), '', '오히려 좋거든요'],
    ['seed-ohiryeo-joa', haeyo('는데요'), '떡볶이', '떡볶이? 오히려 좋은데요'],
    ['seed-gatsaeng', banmal('네', '는데', '거든'), '', '갓생 사네'],
    ['seed-gatsaeng', banmal('네', '는데', '거든'), '', '갓생 사는데'],
    ['seed-gatsaeng', banmal('네', '는데', '거든'), '', '갓생 살거든'],
    ['seed-gatsaeng', banmal('구나', '다니까', '넹'), '', '갓생 사는구나'],
    ['seed-gatsaeng', banmal('구나', '다니까', '넹'), '', '갓생 산다니까'],
    ['seed-gatsaeng', banmal('구나', '다니까', '넹'), '', '갓생 사넹'],
    ['seed-gatsaeng', banmal('당', '용'), '', '갓생 산당'],
    ['seed-gatsaeng', banmal('당', '용'), '', '갓생 살아용'],
    ['seed-gatsaeng', banmal('거든'), '월요일', '월요일은 갓생 살거든'],
    ['seed-kingbatne', banmal('는데', '거든', '잖아'), '', '킹받는데'],
    ['seed-kingbatne', banmal('는데', '거든', '잖아'), '', '킹받거든'],
    ['seed-kingbatne', banmal('는데', '거든', '잖아'), '', '킹받잖아'],
    ['seed-kingbatne', banmal('징', '구나'), '', '킹받징'],
    ['seed-kingbatne', banmal('징', '구나'), '', '킹받는구나'],
    ['seed-kingbatne', banmal('거든'), '야근', '야근 킹받거든'],
    ['seed-pom-michyeotda', banmal('는데', '네', '구나'), '떡볶이', '떡볶이 폼 미쳤는데'],
    ['seed-pom-michyeotda', banmal('는데', '네', '구나'), '떡볶이', '떡볶이 폼 미쳤네'],
    ['seed-pom-michyeotda', banmal('는데', '네', '구나'), '떡볶이', '떡볶이 폼 미쳤구나'],
    ['seed-pom-michyeotda', banmal('당', '용'), '야근', '야근 폼 미쳤당'],
    ['seed-pom-michyeotda', banmal('당', '용'), '야근', '야근 폼 미쳤어용'],
    ['seed-mot-chamji', banmal('거든', '잖아', '네'), '떡볶이', '떡볶이는 못 참거든'],
    ['seed-mot-chamji', banmal('거든', '잖아', '네'), '월요일', '월요일은 못 참잖아'],
    ['seed-mot-chamji', banmal('거든', '잖아', '네'), '야근', '야근은 못 참네'],
    ['seed-mot-chamji', banmal('는데', '다니까', '구나'), '떡볶이', '떡볶이는 못 참는데'],
    ['seed-mot-chamji', banmal('는데', '다니까', '구나'), '떡볶이', '떡볶이는 못 참는다니까'],
    ['seed-mot-chamji', banmal('는데', '다니까', '구나'), '떡볶이', '떡볶이는 못 참는구나'],
    ['seed-mot-chamji', haeyo('네요', '거든요'), '월요일', '월요일은 못 참네요'],
    ['seed-donggyeol-geonjo', banmal('는데', '네'), '야근', '야근 동결건조하고 싶은데'],
    ['seed-donggyeol-geonjo', banmal('엉'), '떡볶이', '떡볶이 동결건조하고 싶엉'],
    ['seed-gungnul', banmal('거든', '잖아', '네'), '떡볶이', '떡볶이는 국룰이거든'],
    ['seed-gungnul', banmal('거든', '잖아', '네'), '월요일', '월요일은 국룰이잖아'],
    ['seed-gungnul', banmal('는데', '야', '다니까'), '야근', '야근은 국룰인데'],
    ['seed-gungnul', banmal('는데', '야', '다니까'), '야근', '야근은 국룰이야'],
    ['seed-gungnul', banmal('는데', '야', '다니까'), '야근', '야근은 국룰이라니까'],
    ['seed-gungnul', haeyo('요', '네요'), '떡볶이', '떡볶이는 국룰이에요'],
    ['seed-gungnul', haeyo('요', '네요'), '떡볶이', '떡볶이는 국룰이네요'],
    ['seed-nallijabeseu', banmal('거든', '는데', '당'), '', '난리자베스거든'],
    ['seed-nallijabeseu', banmal('거든', '는데', '당'), '', '난리자베스인데'],
    ['seed-nallijabeseu', banmal('거든', '는데', '당'), '', '난리자베스당'],
    ['seed-nallijabeseu', banmal('용'), '', '난리자베스예용'],
    ['seed-chaegeopkwae', banmal('잖아', '지'), '', '책없쾌잖아'],
    ['seed-chaegeopkwae', banmal('잖아', '지'), '', '책없쾌지'],
    ['seed-chaegeopkwae', banmal('잖아'), '월요일', '월요일은 책없쾌잖아'],
    ['seed-jungkkeokma', banmal('지'), '식욕', '중요한 건 꺾이지 않는 식욕이지'],
    ['seed-jungkkeokma', banmal('거든'), '출근 의지', '중요한 건 꺾이지 않는 출근 의지거든'],
    ['seed-jungkkeokma', profile({ register: 'eumseum', endings: ['임'] }), '식욕', '중요한 건 꺾이지 않는 식욕임'],
    ['seed-ttalkkak', banmal('거든'), '월요일', '월요일은 딸깍이면 끝이거든'],
    ['seed-jinsimin-pyeon', banmal('거든', '야'), '떡볶이', '떡볶이에 진심인 편이거든'],
    ['seed-jinsimin-pyeon', banmal('거든', '야'), '떡볶이', '떡볶이에 진심인 편이야'],
    ['seed-seupdeuk-monster', banmal('거든', '넹'), '떡볶이', '떡볶이 습득하는 몬스터거든'],
    ['seed-seupdeuk-monster', banmal('거든', '넹'), '떡볶이', '떡볶이 습득하는 몬스터넹'],
    ['seed-chugumi', banmal('야', '거든'), '미니멀리스트', '내 추구미는 미니멀리스트야'],
    ['seed-chugumi', banmal('야', '거든'), '계획형 인간', '내 추구미는 계획형 인간이거든'],
    ['seed-moreuneun-gae-sanchaek', banmal('거든', '네'), '', '모르는 개 산책이거든'],
    ['seed-moreuneun-gae-sanchaek', banmal('거든', '네'), '', '모르는 개 산책이네'],
    ['seed-aljalttakkkalsen', banmal('거든'), '', '알잘딱깔센이거든'],
    ['seed-segwon', banmal('거든'), '', '우리 집 붕세권이야'],
    ['seed-segwon', banmal('거든'), '도서관', '우리 집 도세권이거든'],
  ]

  test(`문구 ${EXPECTED.length}개가 정확히 나온다`, () => {
    for (const [id, who, topic, expected] of EXPECTED) {
      const texts = textsOf(spoken(id, who, topic))
      assert.ok(texts.includes(expected), `${id} + ${who.endings.join('·')} + ${topic || '(없음)'} → ‘${expected}’가 없음: ${texts.join(' / ')}`)
    }
  })

  test('어미를 입힌 후보에는 그 어미와 설명이 붙는다', () => {
    const made = spoken('seed-ohiryeo-joa', banmal('거든')).find((c) => c.text === '오히려 좋거든')
    assert.equal(made.technique, 'ending')
    assert.deepEqual(made.styleElements, ['어미 ~거든'])
    assert.equal(made.why, '‘오히려 좋아’에 내 말끝 ‘~거든’을 붙였어요.')
    assert.equal(made.memeElement, '{X}? 오히려 좋아')
    const slotted = spoken('seed-mot-chamji', banmal('네'), '떡볶이').find((c) => c.text === '떡볶이는 못 참네')
    assert.equal(slotted.technique, 'ending')
    assert.equal(slotted.why, '‘~는 못 참지’에 ‘떡볶이’를 넣고 내 말끝 ‘~네’를 붙였어요.')
  })

  test('원래 문구와 같아지는 어미는 새 후보로 치지 않는다', () => {
    const texts = textsOf(spoken('seed-mot-chamji', banmal('지', '거든'), '떡볶이'))
    assert.equal(texts.filter((text) => text === '떡볶이는 못 참지').length, 1)
    const base = spoken('seed-mot-chamji', banmal('지', '거든'), '떡볶이').find((c) => c.text === '떡볶이는 못 참지')
    assert.equal(base.technique, 'slot')
    // 어미를 바꾸지 않았어도 내 어미로 끝나면 쓰인 요소로 보여 준다
    assert.deepEqual(base.styleElements, ['어미 ~지'])
  })

  test('굳은 표현(fixed)은 어미를 바꾸지 않고, 표에 없는 어미는 건너뛴다', () => {
    for (const id of ['seed-gabojago', 'seed-yareu', 'seed-jeommechu', 'seed-jeongbo', 'seed-akpeul-pyramid']) {
      const made = spoken(id, banmal('거든', '잖아', '네'), '떡볶이')
      assert.ok(made.every((c) => !/거든$|잖아$/.test(c.text)), `${id}: ${textsOf(made).join(' / ')}`)
      assert.ok(made.every((c) => !c.styleElements.some((el) => el.startsWith('어미 ~거든'))))
    }
    const unknown = spoken('seed-ohiryeo-joa', banmal('ㄹ게', '려나', '거든'))
    assert.ok(unknown.every((c) => !c.styleElements.includes('어미 ~ㄹ게') && !c.styleElements.includes('어미 ~려나')))
    assert.ok(textsOf(unknown).includes('오히려 좋거든'))
  })

  test('높임 단계의 완성형을 빌렸는데 그 어미 글자로 끝나지 않으면 말투를 맞췄다고 설명한다', () => {
    const mixed = profile({ register: 'haeyo', endings: ['어', '임', '거든'], fillers: ['아니'] })
    const made = spoken('seed-kingbatne', mixed)
    const casual = made.find((c) => c.text === '킹받네')
    assert.equal(casual.technique, 'ending')
    assert.equal(casual.why, '‘킹받네’를 내 말투(반말)에 맞췄어요.')
    assert.deepEqual(casual.styleElements, [], '‘킹받네’는 ‘어’로 끝나지 않으므로 어미 표시를 달지 않는다')
    assert.equal(made.find((c) => c.text === '킹받음').why, '‘킹받네’를 내 말투(음슴체)에 맞췄어요.')
    // 추임새와 함께 쓰는 후보는 글자 그대로 붙은 어미로만 만든다
    const both = made.find((c) => c.styleElements.includes('추임새 아니') && c.technique === 'ending')
    assert.equal(both.text, '아니 킹받거든')
    assert.equal(both.why, '‘킹받네’에 내 추임새 ‘아니’와 말끝 ‘~거든’을 입혔어요.')
    for (const c of made) assert.doesNotMatch(c.why + c.styleElements.join(), /undefined/)
    // 글자 그대로 끝나면 평소처럼 어미로 표시한다
    const polite = spoken('seed-kingbatne', profile({ register: 'banmal', endings: ['요'] })).find((c) => c.text === '킹받네요')
    assert.deepEqual(polite.styleElements, ['어미 ~요'])
    assert.equal(polite.why, '‘킹받네’에 내 말끝 ‘~요’를 붙였어요.')
  })

  test('어미는 많이 쓰는 순서로 세 개까지 쓴다', () => {
    const made = spoken('seed-ohiryeo-joa', banmal('거든', '잖아', '네', '는데', '더라'))
    const used = new Set(made.flatMap((c) => c.styleElements).filter((el) => el.startsWith('어미 ')))
    assert.deepEqual([...used].sort(), ['어미 ~거든', '어미 ~네', '어미 ~잖아'])
    // 앞 어미가 원래 문구와 같아 못 쓰면 다음 어미로 넘어간다
    const skipped = spoken('seed-kingbatne', banmal('네', '거든', '잖아', '는데'))
    assert.ok(textsOf(skipped).includes('킹받는데'))
  })

  test('힌트만으로 알 수 없는 활용은 추측하지 않고, 규칙이 분명한 것만 만든다', () => {
    const custom = (engine) => ({ id: 't', keyword: '테스트', kind: 'phrase', pattern: null, category: '일상', engine: { slot: null, contexts: ['그래서', '아무튼'], twists: [], ...engine } })
    const forms = (banmalForm) => ({ banmal: banmalForm, haeyo: `${banmalForm}요`, hapsyo: banmalForm, eumseum: banmalForm, plain: banmalForm })
    const made = (engine, ...endings) => textsOf(generateLocal({ profile: banmal(...endings), trend: custom(engine), options: { situation: 'talk' } }))

    // ㅂ 불규칙 형용사: ‘귀엽은데’가 아니라 ‘귀여운데’여야 하므로 만들지 않는다
    const cute = made({ pos: 'adj', stem: '너무 귀엽', forms: forms('너무 귀여워') }, '는데', '네')
    assert.ok(!cute.some((text) => text.includes('귀엽은데')), cute.join(' / '))
    assert.ok(cute.includes('너무 귀엽네'))
    // ㄹ 탈락은 규칙이 분명하다: stemN이 없어도 ‘노네’, ‘노는데’
    const play = made({ pos: 'verb', stem: '신나게 놀', forms: forms('신나게 놀아') }, '네', '는데', '거든')
    assert.ok(play.includes('신나게 노네') && play.includes('신나게 노는데') && play.includes('신나게 놀거든'), play.join(' / '))
    // 받침 없는 형용사는 ㄴ 받침을 얹고, 있다·없다 계열은 ‘는데’
    assert.ok(made({ pos: 'adj', stem: '참 예쁘', forms: forms('참 예뻐') }, '는데').includes('참 예쁜데'))
    assert.ok(made({ pos: 'adj', stem: '은근 재밌', forms: forms('은근 재밌어') }, '는데').includes('은근 재밌는데'))
    assert.ok(made({ pos: 'adj', stem: '길이 길', forms: forms('길이 길어') }, '는데').includes('길이 긴데'))
  })
})

describe('방식별 후보', () => {
  const rich = profile({
    register: 'banmal',
    endings: ['거든', '잖아', '네'],
    fillers: ['아니', '너무', '진짜'],
    tail: { kk: 'ㅋㅋㅋ', punct: ['~'], elongation: true },
    rhythm: { short: true, tempo: 'fast' },
  })

  test('말투가 풍부하고 넣고 싶은 말이 있으면 여섯 방식이 모두 나온다', () => {
    const made = spoken('seed-mot-chamji', rich, '떡볶이')
    assert.deepEqual([...new Set(made.map((c) => c.technique))].sort(), [...TECHNIQUE_IDS].sort())
  })

  test('추임새 얹기: 문장 앞에 하나만 얹고, 정도 부사는 앞에 두지 않는다', () => {
    const made = spoken('seed-ohiryeo-joa', rich)
    const fillers = made.filter((c) => c.technique === 'filler')
    assert.deepEqual(textsOf(fillers), ['아니 오히려 좋아', '진짜 오히려 좋아'])
    assert.deepEqual(fillers[0].styleElements, ['추임새 아니'])
    assert.equal(fillers[0].why, '‘오히려 좋아’ 앞에 내 추임새 ‘아니’를 얹었어요.')
    assert.ok(made.every((c) => !c.text.startsWith('너무 ')), '‘너무’는 문장 앞에 두면 어색하다')
    assert.ok(made.every((c) => !/^(아니|진짜) (아니|진짜) /.test(c.text)), '추임새를 겹쳐 쌓지 않는다')
  })

  test('추임새와 어미를 함께 쓰면 방식은 어미 입히기다', () => {
    const both = spoken('seed-ohiryeo-joa', rich).find((c) => c.text === '아니 오히려 좋거든')
    assert.equal(both.technique, 'ending')
    assert.deepEqual(both.styleElements, ['어미 ~거든', '추임새 아니'])
    assert.equal(both.why, '‘오히려 좋아’에 내 추임새 ‘아니’와 말끝 ‘~거든’을 입혔어요.')
  })

  test('추임새가 문구에 이미 들어 있는 말과 겹치면 얹지 않는다', () => {
    const made = spoken('seed-gabojago', profile({ fillers: ['일단', '아 진짜'] }), '')
    assert.ok(made.every((c) => !c.text.includes('일단 일단')), textsOf(made).join(' / '))
    assert.ok(textsOf(made).includes('아 진짜 가보자고'))
    // ‘사실 …악플이 달린다는 사실을…’처럼 겹치는 추임새는 건너뛰고 다음 추임새를 쓴다
    const fillers = spoken('seed-akpeul-pyramid', profile({ fillers: ['사실', '아니', '근데'] }), '떡볶이').filter((c) => c.technique === 'filler')
    assert.deepEqual(fillers.map((c) => c.text.split(' ')[0]), ['아니', '근데'])
    const topical = spoken('seed-mot-chamji', profile({ fillers: ['진짜'] }), '진짜 맛집').filter((c) => c.technique === 'filler')
    assert.equal(topical.length, 0)
  })

  test('내 단어 넣기: 넣고 싶은 말이 있거나 빈칸이 꼭 필요한 문형일 때만', () => {
    const withTopic = spoken('seed-ohiryeo-joa', rich, '떡볶이').filter((c) => c.technique === 'slot')
    assert.deepEqual(textsOf(withTopic), ['떡볶이? 오히려 좋아'])
    assert.equal(withTopic[0].why, '‘오히려 좋아’에 ‘떡볶이’를 넣었어요.')
    assert.equal(spoken('seed-ohiryeo-joa', rich).filter((c) => c.technique === 'slot').length, 0)
    const required = spoken('seed-pom-michyeotda', rich).filter((c) => c.technique === 'slot')
    assert.deepEqual(textsOf(required).sort(), ['네 발표 폼 미쳤다', '오늘 급식 폼 미쳤다', '오늘 노을 폼 미쳤다'])
    assert.ok(required.every((c) => c.why.endsWith('넣어 봤어요.')), '예시 낱말은 내 말이 아니므로 ‘넣어 봤어요’')
  })

  test('선택 빈칸은 비운 것과 채운 것을 함께 낸다', () => {
    const texts = textsOf(spoken('seed-ohiryeo-joa', rich))
    assert.ok(texts.includes('오히려 좋거든'))
    assert.ok(texts.some((text) => /^(비 오는 날|약속 취소|막차 놓침)\? 오히려 좋(거든|잖아|네)$/.test(text)), texts.join(' / '))
    const topical = textsOf(spoken('seed-ohiryeo-joa', rich, '월요일'))
    assert.ok(topical.includes('월요일? 오히려 좋거든') && topical.includes('오히려 좋거든'))
  })

  test('리듬 맞추기: 짧게 끊기 · 늘여 쓰기 · 붙여 쓰기', () => {
    // 프로필의 리듬 버릇에서 나온 후보만 본다 (후보가 모자랄 때 채우는 ‘~해 봤어요’ 변형은 뺀다)
    const rhythmOf = (id, who, topic) => spoken(id, who, topic).filter((c) => c.technique === 'rhythm' && c.styleElements.some((el) => el.startsWith('리듬 ')))
    const choppy = profile({ rhythm: { short: true } })
    const stretchy = profile({ tail: { elongation: true } })
    const wavy = profile({ tail: { punct: ['~'] } })
    const fast = profile({ rhythm: { tempo: 'fast' } })

    assert.deepEqual(textsOf(rhythmOf('seed-ohiryeo-joa', choppy)), ['오히려. 좋아.'])
    assert.deepEqual(rhythmOf('seed-ohiryeo-joa', choppy)[0].styleElements, ['리듬 짧게 끊기'])
    assert.deepEqual(textsOf(rhythmOf('seed-ohiryeo-joa', profile({ rhythm: { phrasing: 'choppy' } }))), ['오히려. 좋아.'])
    assert.deepEqual(textsOf(rhythmOf('seed-ohiryeo-joa', choppy, '떡볶이')), ['떡볶이? 오히려. 좋아.'])
    assert.deepEqual(textsOf(rhythmOf('seed-mot-chamji', choppy, '떡볶이')), ['떡볶이는. 못 참지.'])
    assert.deepEqual(textsOf(rhythmOf('seed-pom-michyeotda', choppy, '오늘 급식')), ['오늘 급식. 폼 미쳤다.'])
    assert.deepEqual(textsOf(rhythmOf('seed-jungkkeokma', choppy, '식욕')), ['중요한 건 꺾이지 않는. 식욕.'])
    assert.deepEqual(textsOf(rhythmOf('seed-chugumi', choppy, '계획형 인간')), ['내 추구미는. 계획형 인간.'])
    assert.deepEqual(textsOf(rhythmOf('seed-segwon', choppy, '붕어빵')), ['우리 집. 붕세권이야.'])
    assert.deepEqual(textsOf(rhythmOf('seed-yareu', choppy, '퇴근')), ['퇴근. 야르.'])
    assert.deepEqual(textsOf(rhythmOf('seed-moreuneun-gae-sanchaek', choppy)), ['모르는 개. 산책이지.'])

    assert.deepEqual(textsOf(rhythmOf('seed-ohiryeo-joa', stretchy)), ['오히려 좋아아아'])
    assert.deepEqual(rhythmOf('seed-ohiryeo-joa', stretchy)[0].styleElements, ['리듬 늘여 쓰기'])
    assert.deepEqual(textsOf(rhythmOf('seed-mot-chamji', wavy, '떡볶이')), ['떡볶이는 못 참지이이'])
    assert.deepEqual(textsOf(rhythmOf('seed-gabojago', stretchy)), ['가보자고오오'])
    assert.deepEqual(textsOf(rhythmOf('seed-yareu', stretchy)), ['야르으으'])
    assert.deepEqual(textsOf(rhythmOf('seed-ohiryeo-joa', profile({ register: 'haeyo', tail: { elongation: true } }))), ['오히려 좋아요오오'])
    assert.deepEqual(textsOf(rhythmOf('seed-ttalkkak', profile({ register: 'eumseum', tail: { elongation: true } }))), ['딸깍이면 끝임~~'])

    assert.deepEqual(textsOf(rhythmOf('seed-ohiryeo-joa', fast)), ['오히려좋아'])
    assert.deepEqual(rhythmOf('seed-ohiryeo-joa', fast)[0].styleElements, ['리듬 붙여 쓰기'])
    assert.deepEqual(textsOf(rhythmOf('seed-akpeul-pyramid', fast, '떡볶이')), [], '긴 문구는 붙여 쓰지 않는다')
    assert.equal(rhythmOf('seed-mot-chamji', rich, '떡볶이').length, 2, '리듬 후보는 두 개까지')
  })

  test('늘여 쓰기는 어떤 홀소리로 끝나도 그 끝소리를 두 번 더한다', () => {
    // 가 개 갸 걔 거 게 겨 계 고 과 괘 괴 교 구 궈 궤 귀 규 그 긔 기
    const stretched = ['아', '애', '아', '애', '어', '에', '어', '에', '오', '아', '애', '에', '오', '우', '어', '에', '이', '우', '으', '이', '이']
    stretched.forEach((vowel, jung) => {
      const syllable = compose(0, jung)
      const trend = { id: `v${jung}`, keyword: '테스트', pattern: null, engine: { pos: 'fixed', forms: { banmal: `테스트 ${syllable}` }, slot: null, contexts: [], twists: [] } }
      const made = generateLocal({ profile: profile({ tail: { elongation: true } }), trend, options: { situation: 'talk' } })
      assert.ok(textsOf(made).includes(`테스트 ${syllable}${vowel}${vowel}`), `${syllable}: ${textsOf(made).join(' / ')}`)
    })
  })

  test('줄임·합성: 어절 첫 글자를 모으고 원래 말을 설명에 적는다', () => {
    const blend = spoken('seed-mot-chamji', profile(), '떡볶이').find((c) => c.technique === 'blend')
    assert.equal(blend.text, '떡못참')
    assert.equal(blend.why, '‘떡볶이는 못 참지’를 줄였어요.')
    assert.equal(spoken('seed-ohiryeo-joa', profile(), '떡볶이').find((c) => c.technique === 'blend').text, '떡오좋')
    // 한 어절이거나 다섯 어절이 넘으면 줄이지 않는다
    assert.equal(spoken('seed-kingbatne', profile()).filter((c) => c.technique === 'blend').length, 0)
    assert.equal(spoken('seed-akpeul-pyramid', profile(), '떡볶이').filter((c) => c.technique === 'blend').length, 0)
  })

  test('맛 단계: 순한맛은 비틀기·줄임 없이, 매운맛은 비틀기 두 개까지', () => {
    const count = (spice, technique) =>
      generateLocal({ profile: rich, trend: trendOf('seed-ohiryeo-joa'), options: { situation: 'talk', spice }, frames }).filter((c) => c.technique === technique).length
    assert.deepEqual([count('mild', 'twist'), count('mild', 'blend')], [0, 0])
    assert.deepEqual([count('medium', 'twist'), count('medium', 'blend')], [1, 1])
    assert.deepEqual([count('hot', 'twist'), count('hot', 'blend')], [2, 1])
    const twists = generateLocal({ profile: rich, trend: trendOf('seed-ohiryeo-joa'), options: { situation: 'talk', spice: 'hot' }, frames }).filter((c) => c.technique === 'twist')
    assert.deepEqual(textsOf(twists).sort(), ['오히려 좋은 걸지도', '이쯤 되면 오히려 좋아'])
    assert.ok(twists.every((c) => c.why === '‘오히려 좋아’를 살짝 비틀었어요.'))
  })

  test('비틀기: 넣고 싶은 말이 들어가는 문형을 먼저 쓰고, 해요체 화자에게는 높임을 맞춘다', () => {
    const twist = (id, who, topic) => spoken(id, who, topic).find((c) => c.technique === 'twist')
    assert.equal(twist('seed-mot-chamji', profile(), '월요일').text, '월요일은 진짜 못 참겠다')
    assert.equal(twist('seed-mot-chamji', profile(), '월요일').why, '‘~는 못 참지’에 ‘월요일’을 넣고 살짝 비틀었어요.')
    assert.equal(twist('seed-gabojago', profile({ register: 'haeyo' }), '월요일').text, '월요일, 일단 가보자고요')
    assert.equal(twist('seed-kingbatne', profile({ register: 'haeyo' })).text, '킹받는데 웃기네요')
    assert.match(twist('seed-mot-chamji', profile({ register: 'haeyo' })).text, /^이건 못 참지요$|진짜 못 참겠다$/)
    // ‘-다’로 끝나거나 명사로 끝나는 비틀기에는 ‘요’를 붙일 수 없다
    assert.equal(twist('seed-pom-michyeotda', profile({ register: 'haeyo' }), '떡볶이').text, '떡볶이 폼 올랐다')
    assert.equal(twist('seed-gungnul', profile({ register: 'haeyo' }), '떡볶이').text, '이건 그냥 국룰')
    assert.ok(['책없쾌 즐기는 중', '이게 바로 책없쾌'].includes(twist('seed-chaegeopkwae', profile({ register: 'haeyo' })).text))
    assert.equal(twist('seed-chugumi', profile({ register: 'haeyo' }), '떡볶이').text, '추구미는 떡볶이, 현실은 침대')
    // 반말·음슴체 화자에게는 적힌 그대로
    assert.equal(twist('seed-kingbatne', profile({ register: 'eumseum' })).text, '킹받는데 웃기네')
  })

  test('밈 요소: 문형이 있으면 문형, 없으면 이름', () => {
    assert.ok(spoken('seed-mot-chamji', rich, '떡볶이').every((c) => c.memeElement === '{X}는 못 참지'))
    assert.ok(spoken('seed-moreuneun-gae-sanchaek', rich).every((c) => c.memeElement === '모르는 개 산책'))
  })
})

describe('프로필이 빈약할 때의 보충 후보', () => {
  test('프로필에 없는 것은 내 말투라고 하지 않고 ‘~해 봤어요’로 설명한다', () => {
    const made = spoken('seed-ohiryeo-joa', profile({ register: 'eumseum', endings: ['임'] }))
    // 아무것도 바꾸지 않은 기본 문구(음슴체 화자의 ‘오히려 좋음’)는 후보로 내지 않는다
    assert.ok(!textsOf(made).includes('오히려 좋음'), textsOf(made).join(' / '))
    const common = made.find((c) => c.text === '오히려 좋거든')
    assert.equal(common.why, '‘오히려 좋아’에 흔히 쓰는 말끝 ‘~거든’을 붙여 봤어요.')
    assert.deepEqual(common.styleElements, [])
    // 선택 빈칸에 예시 낱말을 넣은 꼴은 ‘내 단어 넣기’가 아니다
    assert.ok(!made.some((c) => c.technique === 'slot'), textsOf(made).join(' / '))
    // 반말 화자의 ‘임’은 밈의 음슴체 꼴을 빌려 말투를 맞춘다 (글자가 ‘임’으로 끝나지 않으니 어미가 아니라 말투라고 설명한다)
    const adapted = spoken('seed-ohiryeo-joa', profile({ register: 'banmal', endings: ['임'] })).find((c) => c.text === '오히려 좋음')
    assert.equal(adapted.why, '‘오히려 좋아’를 내 말투(음슴체)에 맞췄어요.')
    const sample = spoken('seed-mot-chamji', profile(), '떡볶이').find((c) => c.technique === 'slot' && !c.text.startsWith('떡볶이'))
    assert.match(sample.why, /^‘~는 못 참지’에 ‘.+’[을를] 넣어 봤어요\.$/)
    const filler = spoken('seed-yareu', profile()).find((c) => c.technique === 'filler')
    assert.match(filler.why, /흔히 쓰는 추임새 ‘.+’[을를] 얹어 봤어요\.$/)
    assert.deepEqual(filler.styleElements, [])
  })

  test('문구가 내 어미로 끝나면 바꾸지 않았어도 쓰인 요소로 보여 준다', () => {
    // 기본 문구 자체는 후보가 아니므로, 추임새를 얹은 후보로 본다
    const made = spoken('seed-ttalkkak', profile({ register: 'eumseum', endings: ['임'], fillers: ['아니'] }))
    assert.deepEqual(made.find((c) => c.text === '아니 딸깍이면 끝임').styleElements, ['어미 ~임', '추임새 아니'])
  })

  test('말투 정보가 전혀 없고 순한맛이어도 후보가 다섯 개(고정 문구는 네 개)는 나온다', () => {
    for (const trend of seed) {
      for (const topic of ['', '떡볶이']) {
        const made = generateLocal({ profile: profile(), trend, options: { situation: 'talk', spice: 'mild', topic }, frames })
        // 순한맛의 고정 문구는 어미를 바꿀 수 없고 비틀기·줄임도 없어, 추임새 2개 + 리듬 2개가 최대다
        const floor = trend.engine?.pos === 'fixed' ? 4 : 5
        assert.ok(made.length >= floor, `${trend.id} / ${topic || '(없음)'}: ${made.length}개`)
        assert.ok(made.every((c) => c.technique !== 'twist' && c.technique !== 'blend'))
      }
    }
  })

  test('밈 이름에 이미 들어 있는 낱말은 넣었다고 말하지 않는다', () => {
    const made = spoken('seed-akpeul-pyramid', profile())
    const original = made.find((c) => c.text === '피라미드에도 악플이 달린다는 사실을 기억하자')
    assert.equal(original.why, '‘피라미드에도 악플이 달린다’를 있는 그대로 살렸어요.')
  })

  test('말투가 풍부하면 보충 후보를 섞지 않는다', () => {
    const rich = profile({ endings: ['거든', '잖아', '네'], fillers: ['아니', '진짜'], tail: { elongation: true }, rhythm: { short: true } })
    const made = spoken('seed-ohiryeo-joa', rich)
    assert.ok(made.length >= 10)
    assert.ok(made.every((c) => !c.why.includes('봤어요')), made.map((c) => c.why).join(' / '))
  })
})

describe('말끝 습관과 예문', () => {
  const habits = profile({ endings: ['거든', '잖아', '네'], fillers: ['아니'], tail: { kk: 'ㅋㅋㅋ', cry: 'ㅠㅠ', punct: ['~', '?!'], emoji: ['😂'] }, rhythm: { short: true } })
  const make = (id, situation, who = habits) => generateLocal({ profile: who, trend: trendOf(id), options: { situation, spice: 'medium' }, frames })
  const labels = (candidates, kind) => candidates.flatMap((c) => c.styleElements).filter((el) => el.startsWith(`${kind} `))

  test('친구 톡: 후보의 절반쯤에만 웃음·기호를 붙인다', () => {
    const made = make('seed-ohiryeo-joa', 'chat')
    const decorated = made.filter((c) => c.styleElements.some((el) => /^(웃음|기호) /.test(el)))
    assert.ok(decorated.length >= 2 && decorated.length <= made.length - 2, `${decorated.length}/${made.length}`)
    for (const c of decorated) {
      if (c.styleElements.includes('웃음 ㅋㅋㅋ')) assert.ok(c.text.endsWith(' ㅋㅋㅋ'), c.text)
      if (c.styleElements.includes('기호 ~')) assert.match(c.text, /[가-힣]~( ㅋㅋㅋ)?$/, c.text)
    }
    assert.equal(labels(made, '이모지').length, 0, '이모지는 SNS에서만')
    assert.equal(labels(made, '울음').length, 0, 'ㅠㅠ는 자조·푸념 밈에서만')
    assert.ok(made.every((c) => !c.text.includes('?!')), '뜻을 바꾸는 물음표 습관은 붙이지 않는다')
  })

  test('자조·푸념 밈에서는 ㅠㅠ도 붙인다', () => {
    const tearful = profile({ endings: ['거든'], tail: { cry: 'ㅠㅠ' } })
    const made = make('seed-kingbatne', 'chat', tearful)
    assert.ok(labels(made, '울음').length >= 1)
    assert.ok(made.filter((c) => c.styleElements.includes('울음 ㅠㅠ')).every((c) => c.text.endsWith(' ㅠㅠ')))
    assert.equal(labels(make('seed-ohiryeo-joa', 'chat', tearful), '울음').length, 0)
  })

  test('SNS는 이모지도, 숏폼 자막은 기호만, 말로 할 때는 아무것도 붙이지 않는다', () => {
    assert.ok(labels(make('seed-ohiryeo-joa', 'sns'), '이모지').length >= 1)
    const shorts = make('seed-ohiryeo-joa', 'shorts')
    assert.ok(labels(shorts, '기호').length >= 1)
    assert.equal(labels(shorts, '웃음').length + labels(shorts, '이모지').length, 0)
    const talk = make('seed-ohiryeo-joa', 'talk')
    assert.equal(labels(talk, '웃음').length + labels(talk, '기호').length + labels(talk, '이모지').length, 0)
    assert.ok(talk.every((c) => !/[ㅋㅎㅠ~😂]/u.test(c.text)), textsOf(talk).join(' / '))
  })

  test('짧게 끊은 후보 뒤에는 아무것도 붙이지 않는다', () => {
    for (const situation of ['chat', 'sns', 'shorts']) {
      const beats = make('seed-ohiryeo-joa', situation).filter((c) => c.styleElements.includes('리듬 짧게 끊기'))
      assert.equal(beats.length, 1)
      assert.equal(beats[0].text, '오히려. 좋아.')
    }
  })

  test('말끝 습관을 붙여도 48자를 넘지 않는다', () => {
    const long = generateLocal({ profile: habits, trend: trendOf('seed-akpeul-pyramid'), options: { situation: 'sns', topic: '스무 글자짜리 아주 아주 긴 낱말 하나' }, frames })
    assert.ok(long.length >= 3)
    assert.ok(long.every((c) => charLength(c.text) <= 48))
  })

  test('예문은 상황 구절 뒤에 문구를 그대로 붙인다', () => {
    const made = spoken('seed-ohiryeo-joa', profile({ endings: ['거든'] })).find((c) => c.text === '오히려 좋거든')
    const contexts = trendOf('seed-ohiryeo-joa').engine.contexts
    for (const example of made.examples) {
      const context = example.slice(0, -' 오히려 좋거든'.length)
      assert.ok(contexts.includes(context), example)
    }
    // 구절 안의 {X}도 채운다
    const near = spoken('seed-segwon', profile(), '도서관').flatMap((c) => c.examples)
    assert.ok(near.some((example) => example.startsWith('걸어서 3분이면 도서관 나오는 거 보면 ')))
  })

  test('예문에서 같은 말이 겹치거나, 추임새가 문장 한가운데로 들어가지 않는다', () => {
    const go = spoken('seed-gabojago', profile({ fillers: ['아니'] }), '').flatMap((c) => c.examples)
    assert.ok(go.every((example) => !example.includes('일단 일단')), go.join(' / '))
    // 예문은 밈의 상황 구절로만 만든다(명세). 말이 끊기는 구절이 하나뿐이면 그 구절을 먼저 쓰고, 나머지는 밈의 다른 구절로 채운다
    const filler = spoken('seed-ttalkkak', profile({ fillers: ['아니'] })).filter((c) => c.styleElements.includes('추임새 아니'))
    assert.equal(filler.length, 1)
    const contexts = trendOf('seed-ttalkkak').engine.contexts
    assert.equal(filler[0].examples[0], '자동 저장 켜 놨더니 아니 딸깍이면 끝이야')
    assert.ok(contexts.some((context) => filler[0].examples[1] === `${context} 아니 딸깍이면 끝이야`), filler[0].examples[1])
  })
})

describe('키워드형 트렌드: 다른 밈의 문형을 빌린다', () => {
  const keywordTrends = seed.filter((trend) => !trend.engine)

  test('예시 데이터에 키워드형 트렌드와 틀이 있다', () => {
    assert.ok(keywordTrends.length >= 4)
    assert.ok(frames.length >= 5)
  })

  test('문형마다 두 개까지, 여러 문형에 고르게 나눠 담는다', () => {
    for (const trend of keywordTrends) {
      for (const [name, who] of Object.entries(PROFILES)) {
        const made = generateLocal({ profile: who, trend, options: { situation: 'talk' }, frames })
        const perFrame = Object.groupBy(made, (c) => c.memeElement)
        assert.ok(Object.keys(perFrame).length >= 5, `${trend.keyword}/${name}: 문형 ${Object.keys(perFrame).length}가지`)
        for (const [meme, list] of Object.entries(perFrame)) {
          assert.ok(list.length <= 2, `${meme}: ${list.length}개`)
          assert.match(meme, new RegExp(`^‘.+’ 문형 \\+ ‘${trend.keyword}’$`))
        }
        assert.ok(made.every((c) => c.why.includes(' 문형') || c.technique === 'blend'), made.map((c) => c.why).join(' / '))
        assert.ok(made.filter((c) => c.text.includes(trend.keyword)).length >= made.length / 2, textsOf(made).join(' / '))
        assert.ok(new Set(made.map((c) => c.technique)).size >= 2, `${trend.keyword}/${name}: 방식이 한 가지뿐`)
      }
    }
  })

  test('문형 이름과 키워드를 설명에 함께 적는다', () => {
    const made = generateLocal({ profile: profile({ endings: ['거든'] }), trend: trendOf('seed-season-bungeoppang'), options: { situation: 'talk' }, frames })
    const texts = textsOf(made)
    assert.ok(texts.some((text) => text.startsWith('붕어빵은 못 참')), texts.join(' / '))
    const ending = made.find((c) => c.text === '붕어빵은 못 참거든')
    if (ending) assert.equal(ending.why, '‘~는 못 참지’ 문형에 ‘붕어빵’을 넣고 내 말끝 ‘~거든’을 붙였어요.')
    const slot = made.find((c) => c.technique === 'slot')
    assert.match(slot.why, /^‘.+’ 문형에 ‘붕어빵’을 넣었어요\.$/)
    assert.match(slot.memeElement, /^‘.+’ 문형 \+ ‘붕어빵’$/)
  })

  test('문형마다 다른 어미·추임새가 먼저 나오고, 줄임말은 맛 단계가 허락하는 만큼만 낸다', () => {
    const who = profile({ endings: ['거든', '잖아', '네'], fillers: ['아니', '진짜'] })
    const make = (spice) => generateLocal({ profile: who, trend: trendOf('seed-season-long-padding'), options: { situation: 'talk', spice }, frames })
    const medium = make('medium')
    const labels = (kind) => new Set(medium.flatMap((c) => c.styleElements).filter((el) => el.startsWith(`${kind} `)))
    assert.ok(labels('어미').size >= 2, [...labels('어미')].join())
    assert.equal(labels('추임새').size, 2)
    const blends = (list) => list.filter((c) => c.technique === 'blend').length
    assert.deepEqual([blends(make('mild')), blends(medium), blends(make('hot'))], [0, 1, 2])
    assert.equal(make('mild').filter((c) => c.technique === 'twist').length, 0)
  })

  test('틀이 하나도 없으면 내장 문형 세 가지를 쓴다', () => {
    for (const given of [[], undefined, null, [{ keyword: '망가진 틀' }, 'x']]) {
      const made = generateLocal({ profile: PROFILES['반말+ㅋㅋ'], trend: trendOf('seed-season-cheonnun'), options: { situation: 'talk' }, frames: given })
      assert.ok(made.length >= 5, `${made.length}개`)
      assert.deepEqual(new Set(made.map((c) => c.memeElement)), new Set(['‘~는 못 참지’ 문형 + ‘첫눈’', '‘~에 진심인 편’ 문형 + ‘첫눈’', '‘오늘도 ~’ 문형 + ‘첫눈’']))
      assert.ok(textsOf(made).some((text) => text.startsWith('첫눈은 못 참')))
    }
  })

  test('직접 입력한 트렌드도 같은 방식으로 만든다', () => {
    const custom = { id: 'custom-abc', keyword: '주말 등산', kind: 'keyword', pattern: null, meaning: '', category: '일상', engine: null }
    const made = generateLocal({ profile: PROFILES['해요체'], trend: custom, options: { situation: 'sns', spice: 'hot' }, frames })
    assert.ok(made.length >= 5)
    assert.ok(made.filter((c) => c.text.includes('주말 등산')).length >= 5, textsOf(made).join(' / '))
    assert.ok(textsOf(made).some((text) => text.startsWith('주말 등산은 ')), textsOf(made).join(' / '))
    assert.ok(made.every((c) => c.memeElement.endsWith('문형 + ‘주말 등산’')))
  })

  test('키워드에 섞인 중괄호·해시 기호는 떼고 쓴다', () => {
    const made = generateLocal({ profile: profile(), trend: { id: 'k', keyword: '#{X}첫눈{form}!!', engine: null }, frames })
    assert.ok(made.length >= 5)
    assert.ok(made.every((c) => !/[{}#]/.test(c.text + c.examples.join(''))))
  })
})

describe('되풀이 방지와 결정성', () => {
  const who = PROFILES['반말+ㅋㅋ']
  const input = (extra = {}) => ({ profile: who, trend: trendOf('seed-ohiryeo-joa'), options: { situation: 'chat', spice: 'medium', topic: '' }, frames, ...extra })

  test('같은 입력에는 늘 같은 결과', () => {
    assert.deepEqual(generateLocal(input()), generateLocal(input()))
    const seeded = () => {
      let n = 0
      return () => (n = (n * 9301 + 49297) % 233280) / 233280
    }
    assert.deepEqual(generateLocal(input({ rng: seeded() })), generateLocal(input({ rng: seeded() })))
  })

  test('트렌드나 넣고 싶은 말이 달라지면 씨앗도 달라진다', () => {
    const shape = (list) => list.map((c) => `${c.styleElements.join()}|${c.examples[0]}`).join('\n')
    const a = generateLocal(input({ options: { situation: 'chat', topic: '떡볶이' } }))
    const b = generateLocal(input({ options: { situation: 'chat', topic: '월요일' } }))
    assert.notEqual(shape(a).replaceAll('떡볶이', 'X'), shape(b).replaceAll('월요일', 'X'))
  })

  test('이미 보여 준 문구는 말끝 꾸밈이 달라도 다시 내지 않는다', () => {
    const first = generateLocal(input())
    const shown = first.slice(0, 5).map((c) => c.text)
    const second = generateLocal(input({ feedback: { shown: [...shown, '오히려 좋거든 ㅋㅋㅋ', '오히려   좋잖아!!'] } }))
    const blocked = new Set([...shown, '오히려 좋거든', '오히려 좋잖아'].map(normalized))
    assert.ok(second.length >= 5)
    assert.ok(second.every((c) => !blocked.has(normalized(c.text))), textsOf(second).join(' / '))
  })

  test('다시 만들기를 거듭해도 새 후보가 이어진다', () => {
    let shown = []
    const seen = new Set()
    for (let round = 0; round < 4; round++) {
      const made = generateLocal(input({ feedback: { shown } })).slice(0, 5)
      assert.equal(made.length, 5, `${round + 1}번째: ${made.length}개`)
      for (const c of made) {
        assert.ok(!seen.has(normalized(c.text)), `${round + 1}번째에 되풀이: ${c.text}`)
        seen.add(normalized(c.text))
      }
      shown = [...textsOf(made), ...shown]
    }
  })

  test('다 보여 준 뒤에는 억지로 되풀이하지 않고 빈 목록을 돌려준다', () => {
    let shown = []
    let made = []
    for (let round = 0; round < 30; round++) {
      made = generateLocal({ profile: profile(), trend: trendOf('seed-yareu'), options: { situation: 'talk', topic: '떡볶이' }, frames, feedback: { shown } })
      if (!made.length) break
      shown = [...textsOf(made), ...shown].slice(0, 30)
    }
    assert.deepEqual(made, [])
  })
})

describe('엉터리 입력', () => {
  test('트렌드가 없거나 쓸 수 없으면 빈 배열', () => {
    for (const input of [undefined, null, {}, 'x', 42, [], { trend: null }, { trend: 'x' }, { trend: {} }, { trend: { keyword: '   ' } }, { trend: { keyword: 12 } }]) {
      assert.deepEqual(generateLocal(input), [])
    }
  })

  test('프로필·옵션·반응·난수가 엉망이어도 죽지 않는다', () => {
    const trend = trendOf('seed-mot-chamji')
    const garbage = [
      { profile: null, options: null, feedback: null },
      { profile: 'x', options: 3, feedback: [] },
      { profile: { endings: [{}, null, 1, '거든'], fillers: 'no', tail: 7, rhythm: [] }, options: { situation: 'nope', spice: 9, topic: {} }, feedback: { shown: 'x' } },
      { profile: { register: 'unknown', endings: ['거든'] }, count: -3, rng: () => Number.NaN },
      { profile: {}, count: 1e9, rng: () => 5, frames: 'nope' },
      { profile: {}, rng: 'not a function' },
    ]
    for (const extra of garbage) {
      const made = generateLocal({ trend, frames, ...extra })
      assert.ok(made.length >= 5, JSON.stringify(Object.keys(extra)))
      assert.ok(made.every((c) => typeof c.text === 'string' && c.examples.length === 2))
    }
    assert.ok(textsOf(generateLocal({ trend, frames, ...garbage[2] })).some((text) => text.endsWith('못 참거든')))
  })

  test('망가진 엔진 힌트는 무시하거나 건너뛴다', () => {
    const base = { id: 'broken', keyword: '망가진 밈', pattern: null, category: '일상' }
    // 완성형이 없으면 힌트가 없는 것으로 보고 다른 밈의 문형을 빌린다
    const noForms = generateLocal({ profile: profile(), trend: { ...base, engine: { pos: 'verb', forms: null } }, frames })
    assert.ok(noForms.length >= 5 && noForms.every((c) => c.memeElement.includes('문형 + ‘망가진 밈’')))
    // 빈칸이 꼭 필요한데 채울 말이 없으면 만들 수 없다
    const noWord = { ...base, engine: { pos: 'noun', stem: '{X} 밈', forms: { banmal: '{X} 밈' }, slot: { required: true, defaults: [] } } }
    assert.deepEqual(generateLocal({ profile: profile(), trend: noWord, frames }), [])
    assert.ok(generateLocal({ profile: profile(), trend: noWord, options: { topic: '떡볶이' }, frames }).some((c) => c.text === '떡볶이 밈'))
    // 품사·구절·비틀기가 엉망이어도 완성형만으로 만든다
    const odd = { ...base, engine: { pos: 'weird', forms: { banmal: '망가진 밈이야', haeyo: 7 }, slot: 'x', contexts: [null, 3], twists: 'no' } }
    const made = generateLocal({ profile: profile({ register: 'haeyo', endings: ['거든요'] }), trend: odd, frames })
    // 기본 문구 그대로는 내지 않지만, 그 문구에 변형을 얹은 후보는 나온다
    assert.ok(made.some((c) => c.text !== '망가진 밈이야' && c.text.includes('망가진 밈이야')), textsOf(made).join(' / '))
    assert.ok(made.every((c) => c.examples.length === 2 && !/undefined|null/.test(c.examples.join())))
  })

  test('넣고 싶은 말의 중괄호·기호는 떼고 쓴다', () => {
    const made = generateLocal({ profile: PROFILES['반말+ㅋㅋ'], trend: trendOf('seed-mot-chamji'), options: { topic: '#{떡볶이}!!' }, frames })
    assert.ok(textsOf(made).some((text) => text.startsWith('떡볶이는 못 참')), textsOf(made).join(' / '))
    const tokens = generateLocal({ profile: PROFILES['반말+ㅋㅋ'], trend: trendOf('seed-mot-chamji'), options: { topic: '{X}{form}' }, frames })
    assert.ok(tokens.length >= 5)
    for (const c of [...made, ...tokens]) assert.doesNotMatch(c.text + c.why + c.examples.join(''), /[{}#]/)
  })

  test('count는 보충 후보를 어디까지 채울지 정할 뿐, 프로필에서 나온 후보를 자르지 않는다', () => {
    const who = profile({ register: 'eumseum', endings: ['임'] })
    const few = generateLocal({ profile: who, trend: trendOf('seed-ohiryeo-joa'), options: { situation: 'talk' }, frames, count: 3 })
    const many = generateLocal({ profile: who, trend: trendOf('seed-ohiryeo-joa'), options: { situation: 'talk' }, frames, count: 12 })
    assert.ok(few.length >= 3 && few.length < many.length, `${few.length} < ${many.length}`)
    assert.deepEqual(textsOf(many).slice(0, few.length), textsOf(few))
  })
})
