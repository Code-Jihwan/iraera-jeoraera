// 랭킹 테스트: 점수 항목 하나하나와, 다양하게 고르는 규칙.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { LIMITS, TECHNIQUE_IDS } from '../shared/constants.js'
import { rankCandidates } from '../server/generate/ranking.js'

const TREND = { id: 'seed-ohiryeo-joa', keyword: '오히려 좋아', pattern: '{X}? 오히려 좋아' }
const NO_MEME = { id: 'none', keyword: '', pattern: null }

const cand = (text, technique = 'ending', extra = {}) => ({
  text,
  examples: [`하나 ${text}`, `둘 ${text}`],
  technique,
  styleElements: [],
  memeElement: '오히려 좋아',
  why: '설명이에요.',
  ...extra,
})

/** 후보 하나만 넣어 점수를 본다. */
const scoreOf = (candidate, context = {}) => rankCandidates([candidate], { trend: NO_MEME, ...context })[0].score
// 밈·말투와 겹치지 않고 길이만 다른 문구
const filler = (length) => '가나다라마바사자차카타파하'.repeat(4).slice(0, length)

describe('점수 항목', () => {
  test('기본: 간결함 0.15 + 방식 기본값 0.1', () => {
    assert.equal(scoreOf(cand('아무 상관 없는 말', 'twist')), 0.25)
  })

  test('말투 반영: 프로필 요소가 드러난 수만큼 0.22 → 0.31 → 0.35', () => {
    const profile = { endings: ['거든'], fillers: ['아니'], tail: { kk: 'ㅋㅋㅋ', punct: ['~'] } }
    const base = scoreOf(cand('오히려 좋다'), { profile })
    assert.equal(base, 0.25)
    assert.equal(scoreOf(cand('오히려 좋거든'), { profile }), 0.47)
    assert.equal(scoreOf(cand('아니 좋거든'), { profile }), 0.56)
    assert.equal(scoreOf(cand('아니 좋거든 ㅋㅋㅋ'), { profile }), 0.6)
    assert.equal(scoreOf(cand('아니 좋거든~ ㅋㅋㅋ'), { profile }), 0.6, '넷부터는 더 올리지 않는다')
    // 프로필에 없는 버릇은 쳐주지 않는다
    assert.equal(scoreOf(cand('오히려 좋거든 ㅋㅋㅋ'), { profile: { endings: ['잖아'] } }), 0.25)
  })

  test('말투 반영: 글자가 달라져도 같은 어미로 알아본다', () => {
    const hit = (text, ending) => scoreOf(cand(text), { profile: { endings: [ending] } }) === 0.47
    assert.ok(hit('오히려 좋은데', '는데'))
    assert.ok(hit('국룰인데', '는데'))
    assert.ok(hit('갓생 사는데요', '는데요'))
    assert.ok(hit('국룰입니다', '습니다'))
    assert.ok(hit('갓생 삶', 'ㅁ'))
    assert.ok(hit('오히려 좋아', '어'))
    assert.ok(hit('오히려 좋앙', '엉'))
    assert.ok(hit('국룰이에요', '어요'))
    assert.ok(hit('오히려 좋긴 해', '긴 해'))
    assert.ok(!hit('오히려 좋데', '는데'), '앞 글자에 ㄴ 받침이 없으면 ‘는데’가 아니다')
    assert.ok(!hit('오히려 좋거든', '잖아'))
  })

  test('말투 반영: 추임새는 어절 단위로, 리듬 버릇은 프로필에 있을 때만', () => {
    const withFiller = { fillers: ['아니'] }
    assert.equal(scoreOf(cand('아니, 오히려 좋다'), { profile: withFiller }), 0.47)
    assert.equal(scoreOf(cand('아니고 오히려 좋다'), { profile: withFiller }), 0.25, '‘아니고’는 추임새 ‘아니’가 아니다')
    assert.equal(scoreOf(cand('오히려 좋아아아', 'rhythm'), { profile: { tail: { elongation: true } } }), 0.47)
    assert.equal(scoreOf(cand('오히려 좋아아아', 'rhythm'), { profile: {} }), 0.25)
    assert.equal(scoreOf(cand('오히려. 좋다.', 'rhythm'), { profile: { rhythm: { short: true } } }), 0.47)
    assert.equal(scoreOf(cand('오히려. 좋다.', 'rhythm'), { profile: { rhythm: { phrasing: 'choppy' } } }), 0.47)
    assert.equal(scoreOf(cand('오히려 좋다 😂', 'slot'), { profile: { tail: { emoji: ['😂'] } } }), 0.47)
  })

  test('밈 반영: 밈의 고정된 부분이 살아 있으면 0.2', () => {
    const fit = (text, trend = TREND) => Math.round((scoreOf(cand(text, 'twist'), { trend }) - 0.25) * 1000) / 1000
    assert.equal(fit('오히려 좋아'), 0.2)
    assert.equal(fit('오히려 좋거든'), 0.2, '어미를 바꿔도 핵심이 남아 있다')
    assert.equal(fit('떡볶이? 오히려 좋잖아'), 0.2)
    assert.equal(fit('아무 상관 없는 말'), 0)
    assert.equal(fit('좋은 하루'), 0, '한 글자만 겹친 것은 우연으로 본다')
    const pattern = { keyword: '~는 못 참지', pattern: '{X}는 못 참지' }
    assert.equal(fit('떡볶이는 못 참지', pattern), 0.2)
    assert.equal(fit('떡볶이는 못 참거든', pattern), 0.2)
    assert.equal(fit('월요일은 못 참잖아', pattern), 0.167, '조사와 어미가 모두 달라지면 조금 깎인다')
    assert.equal(fit('떡못참', pattern), 0.2, '줄임말은 어절 첫 글자로 알아본다')
    const keyword = { keyword: '붕어빵', pattern: null }
    assert.equal(fit('붕어빵은 못 참지', keyword), 0.2)
    assert.equal(fit('우리 집 붕세권이야', keyword), 0)
    assert.equal(fit('저 노을 명당 정보', { keyword: 'OO 정보', pattern: '{X} 정보' }), 0.2)
    assert.equal(fit('맛있자베스', { keyword: '난리자베스', pattern: '{X}자베스' }), 0.2)
  })

  test('넣고 싶은 말을 받았는데 빠져 있으면 밈 점수를 절반만 준다', () => {
    const pattern = { keyword: '~는 못 참지', pattern: '{X}는 못 참지' }
    const score = (text, topic) => scoreOf(cand(text, 'twist'), { trend: pattern, options: { topic } })
    assert.equal(score('떡볶이는 못 참지', '떡볶이'), 0.45)
    assert.equal(score('떡 볶 이는 못 참지', '떡볶이'), 0.45, '띄어쓰기가 달라도 들어 있는 것으로 본다')
    assert.equal(score('이건 못 참지', '떡볶이'), 0.35)
    assert.equal(score('이건 못 참지', ''), 0.45)
    assert.equal(score('이건 못 참지', undefined), 0.45)
  })

  test('간결함: 14자까지 만점, 32자에서 0', () => {
    const brevity = (length) => Math.round((scoreOf(cand(filler(length), 'twist')) - 0.1) * 1000) / 1000
    assert.equal(brevity(5), 0.15)
    assert.equal(brevity(14), 0.15)
    assert.equal(brevity(23), 0.075)
    assert.equal(brevity(32), 0)
    assert.equal(brevity(45), 0)
  })

  test('방식 선호: 좋아요·별로예요를 (up+1)/(up+down+2)로 반영한다', () => {
    const prior = (stats) => Math.round((scoreOf(cand('아무 상관 없는 말', 'ending'), { feedback: { techniqueStats: stats } }) - 0.15) * 1000) / 1000
    assert.equal(prior({}), 0.1)
    assert.equal(prior({ ending: { up: 3, down: 0 } }), 0.16)
    assert.equal(prior({ ending: { up: 0, down: 3 } }), 0.04)
    assert.equal(prior({ twist: { up: 9, down: 0 } }), 0.1, '다른 방식의 반응은 상관없다')
    assert.equal(prior({ ending: { up: -1, down: 'x' } }), 0.1, '엉터리 값은 무시한다')
  })

  test('맛 단계: 순한맛은 어미·추임새를, 매운맛은 비틀기·줄임을 올린다', () => {
    const by = (spice, technique) => scoreOf(cand('아무 상관 없는 말', technique), { options: { spice } })
    assert.deepEqual(['ending', 'filler', 'slot', 'rhythm', 'twist', 'blend'].map((t) => by('mild', t)), [0.3, 0.3, 0.25, 0.25, 0.2, 0.2])
    assert.deepEqual(['ending', 'filler', 'slot', 'rhythm', 'twist', 'blend'].map((t) => by('medium', t)), [0.25, 0.25, 0.25, 0.25, 0.25, 0.25])
    assert.deepEqual(['ending', 'filler', 'slot', 'rhythm', 'twist', 'blend'].map((t) => by('hot', t)), [0.25, 0.25, 0.25, 0.25, 0.3, 0.3])
  })

  test('싫어한 문구와 닮으면 깎고(최대 0.25), 좋아한 문구와 닮으면 조금 올린다(최대 0.05)', () => {
    const text = '아무 상관 없는 말'
    assert.equal(scoreOf(cand(text, 'twist'), { feedback: { disliked: [{ text, technique: 'twist' }] } }), 0)
    assert.equal(scoreOf(cand(text, 'twist'), { feedback: { liked: [{ text, technique: 'twist' }] } }), 0.3)
    const partly = scoreOf(cand(text, 'twist'), { feedback: { disliked: [{ text: '아무 상관 없는 일', technique: 'twist' }] } })
    assert.ok(partly > 0 && partly < 0.25, `${partly}`)
    assert.equal(scoreOf(cand(text, 'twist'), { feedback: { disliked: [{ text: '전혀 다른 문구', technique: 'twist' }] } }), 0.25)
  })

  test('점수는 0과 1 사이에서 소수 셋째 자리까지', () => {
    const profile = { endings: ['거든'], fillers: ['아니'], tail: { kk: 'ㅋㅋ', punct: ['~'], emoji: ['😂'] } }
    const loved = { techniqueStats: { twist: { up: 9999, down: 0 } }, liked: [{ text: '아니 오히려 좋거든', technique: 'twist' }] }
    const high = scoreOf(cand('아니 오히려 좋거든~ ㅋㅋ', 'twist'), { profile, trend: TREND, options: { spice: 'hot' }, feedback: loved })
    assert.ok(high > 0.95 && high <= 1, `${high}`)
    const hated = { techniqueStats: { twist: { up: 0, down: 9999 } }, disliked: [{ text: filler(40), technique: 'twist' }] }
    const low = scoreOf(cand(filler(40), 'twist'), { options: { spice: 'mild' }, feedback: hated })
    assert.equal(low, 0)
    assert.equal(String(scoreOf(cand('월요일은 못 참잖아', 'twist'), { trend: { keyword: '~는 못 참지', pattern: '{X}는 못 참지' } })), '0.417')
  })
})

describe('고르기', () => {
  const profile = { endings: ['거든', '잖아', '네', '지'] }
  const pool = [
    cand('오히려 좋거든'),
    cand('오히려 좋잖아'),
    cand('오히려 좋네'),
    cand('오히려 좋지'),
    cand('아니 오히려 좋아', 'filler'),
    cand('오히려. 좋아.', 'rhythm'),
    cand('이쯤 되면 오히려 좋아', 'twist'),
    cand('오좋', 'blend'),
  ]

  test('점수 높은 순으로, 같은 방식은 두 개까지', () => {
    const ranked = rankCandidates(pool, { profile, trend: TREND, requestId: 'req' })
    assert.equal(ranked.length, LIMITS.candidates.count)
    assert.deepEqual(ranked.map((c) => c.id), ['req-1', 'req-2', 'req-3', 'req-4', 'req-5'])
    assert.equal(ranked.filter((c) => c.technique === 'ending').length, 2)
    assert.deepEqual(ranked.slice(0, 2).map((c) => c.text), ['오히려 좋거든', '오히려 좋잖아'])
    for (let i = 1; i < ranked.length; i++) assert.ok(ranked[i - 1].score >= ranked[i].score, '조건을 풀지 않았다면 점수 순서 그대로다')
  })

  test('닮은 문구(두 글자 조각 자카드 0.7 초과)는 하나만 고른다', () => {
    const similar = [
      cand('오늘 급식 폼 미쳤다', 'slot'),
      cand('오늘 급식 폼 미쳤다아아', 'rhythm'),
      cand('오늘 급식 폼 미쳤거든'),
      cand('네 발표 폼 올랐다', 'twist'),
      cand('아니 급식 진짜 대박', 'filler'),
      cand('오급폼미', 'blend'),
      cand('급식 정보 시급', 'twist'),
    ]
    const texts = rankCandidates(similar, { trend: { keyword: '폼 미쳤다', pattern: '{X} 폼 미쳤다' } }).map((c) => c.text)
    assert.equal(texts.length, 5)
    assert.ok(!(texts.includes('오늘 급식 폼 미쳤다') && texts.includes('오늘 급식 폼 미쳤다아아')), texts.join(' / '))
  })

  // 명세: 같은 방식은 두 개까지, 이미 고른 것과 자카드 0.7 초과는 건너뛴다 — 자리가 남아도 풀지 않는다
  test('자리가 남아도 다양성 조건을 풀지 않는다', () => {
    const onlyEndings = [cand('오히려 좋거든'), cand('오히려 좋잖아'), cand('오히려 좋네'), cand('오히려 좋지')]
    const ranked = rankCandidates(onlyEndings, { profile, trend: TREND })
    assert.equal(ranked.length, 2, '같은 방식뿐이면 두 개만')
    const base = '피라미드에도 악플이 달린다는 사실을 기억하자'
    const near = [cand(base, 'slot'), cand(`아니 ${base}`, 'filler'), cand(`${base}아아`, 'rhythm')]
    assert.equal(rankCandidates(near, {}).length, 1, '닮은 것뿐이면 하나만')
    assert.equal(rankCandidates(pool, { profile, trend: TREND, count: 3 }).length, 3)
    // 어미 네 개 중 둘 + 추임새·리듬·비틀기·줄임 하나씩
    assert.equal(rankCandidates(pool, { profile, trend: TREND, count: 8 }).length, 6)
  })

  test('이미 보여 준 문구는 말끝 꾸밈·띄어쓰기가 달라도 뺀다', () => {
    const ranked = rankCandidates([cand('오히려 좋거든 ㅋㅋㅋ'), cand('오히려좋잖아!!'), cand('오히려 좋네')], { feedback: { shown: ['오히려 좋거든', '오히려 좋잖아'] } })
    assert.deepEqual(ranked.map((c) => c.text), ['오히려 좋네'])
  })

  test('같은 문구가 겹쳐 들어오면 한 번만 낸다', () => {
    const ranked = rankCandidates([cand('오히려 좋거든', 'ending', { engine: 'llm' }), cand('오히려 좋거든 ㅋㅋ', 'twist'), cand('오히려  좋거든')], { profile, trend: TREND })
    assert.equal(ranked.length, 1)
    assert.equal(ranked[0].engine, 'llm', '점수가 같으면 먼저 들어온 것을 남긴다')
  })

  test('결과 모양: 받은 내용은 그대로, id·점수·엔진을 붙인다', () => {
    const raw = cand('오히려 좋거든', 'ending', { styleElements: ['어미 ~거든'], extra: 'ignored' })
    const [ranked] = rankCandidates([raw], { profile, trend: TREND })
    assert.deepEqual(ranked, {
      id: 'r-1',
      text: '오히려 좋거든',
      examples: ['하나 오히려 좋거든', '둘 오히려 좋거든'],
      technique: 'ending',
      styleElements: ['어미 ~거든'],
      memeElement: '오히려 좋아',
      why: '설명이에요.',
      score: 0.67,
      engine: 'local',
    })
  })

  test('엔진 표시: 후보에 적힌 것을 쓰고, 없으면 넘겨받은 기본값', () => {
    // 같은 방식 두 개 제한에 걸리지 않게 방식을 섞는다
    const mixed = [cand('오히려 좋거든', 'ending', { engine: 'llm' }), cand('오히려 좋잖아', 'ending', { engine: 'local' }), cand('오히려 좋네', 'slot', { engine: 'weird' })]
    const engines = (context) => Object.fromEntries(rankCandidates(mixed, context).map((c) => [c.text, c.engine]))
    assert.deepEqual(engines({ profile }), { '오히려 좋거든': 'llm', '오히려 좋잖아': 'local', '오히려 좋네': 'local' })
    assert.deepEqual(engines({ profile, engine: 'llm' }), { '오히려 좋거든': 'llm', '오히려 좋잖아': 'local', '오히려 좋네': 'llm' })
    assert.deepEqual(engines({ profile, engine: 'nope' }), { '오히려 좋거든': 'llm', '오히려 좋잖아': 'local', '오히려 좋네': 'local' })
  })

  test('두 엔진의 후보가 섞이면 AI 엔진 후보를 먼저 싣고 규칙 엔진 후보로 남는 자리를 채운다', () => {
    const by = (engine) => ([text, technique]) => cand(text, technique, { engine })
    const survivors = [
      ['오히려 좋은 하루', 'twist'],
      ['오히려 좋거든', 'ending'],
    ].map(by('llm'))
    const local = [
      ['오히려 좋거든 ㅋㅋㅋ', 'ending'],
      ['오히려 좋잖아 ㅋㅋㅋ', 'ending'],
      ['아니 오히려 좋아', 'filler'],
      ['오히려. 좋아.', 'rhythm'],
      ['오좋', 'blend'],
    ].map(by('local'))
    const ranked = rankCandidates([...local, ...survivors], { profile: { endings: ['거든', '잖아'], tail: { kk: 'ㅋㅋㅋ' } }, trend: TREND })
    assert.deepEqual(ranked.slice(0, 2).map((c) => [c.text, c.engine]), [['오히려 좋거든', 'llm'], ['오히려 좋은 하루', 'llm']])
    assert.deepEqual(ranked.slice(2).map((c) => c.engine), ['local', 'local', 'local'])
    assert.ok(!ranked.some((c) => c.text === '오히려 좋거든 ㅋㅋㅋ'), '같은 문구는 AI 엔진 것을 남긴다')
    assert.deepEqual(ranked.map((c) => c.id), ['r-1', 'r-2', 'r-3', 'r-4', 'r-5'])
  })

  test('같은 입력에는 같은 결과를 내고, 입력을 바꾸지 않는다', () => {
    const frozen = structuredClone(pool)
    const context = { profile, trend: TREND, feedback: { shown: ['오좋'] } }
    assert.deepEqual(rankCandidates(pool, context), rankCandidates(pool, context))
    assert.deepEqual(pool, frozen)
  })

  test('점수가 같으면 들어온 순서, rng가 있으면 rng가 순서를 정한다', () => {
    const tie = [cand('가나다라', 'slot'), cand('마바사아', 'slot')]
    assert.deepEqual(rankCandidates(tie, {}).map((c) => c.text), ['가나다라', '마바사아'])
    const draws = [0.1, 0.9]
    assert.deepEqual(rankCandidates(tie, { rng: () => draws.shift() }).map((c) => c.text), ['마바사아', '가나다라'])
  })
})

describe('엉터리 입력', () => {
  test('후보 목록이 아니면 빈 배열', () => {
    for (const raw of [undefined, null, 'x', 42, {}]) assert.deepEqual(rankCandidates(raw, {}), [])
    assert.deepEqual(rankCandidates([cand('오히려 좋아')]).length, 1)
    assert.deepEqual(rankCandidates([cand('오히려 좋아')], null).length, 1)
  })

  test('쓸 수 없는 후보는 건너뛰고, 모자란 값은 채운다', () => {
    const unusable = [null, 7, 'x', [], {}, { text: '' }, { text: '   ' }, { text: 12 }, { text: '가'.repeat(49) }]
    const patchy = { text: ' 오히려 좋아 ', technique: 'nope', examples: 'x', styleElements: [1, '어미 ~아'], memeElement: 3 }
    const ranked = rankCandidates([...unusable, patchy], { profile: 'x', trend: 5, options: [], feedback: 'y', count: -1, requestId: 'q' })
    const filled = { id: 'q-1', text: '오히려 좋아', examples: [], technique: 'twist', styleElements: ['어미 ~아'], memeElement: '', why: '', score: 0.25, engine: 'local' }
    assert.deepEqual(ranked, [filled])
  })

  test('count가 이상하면 기본 개수로', () => {
    // 방식마다 두 개까지라 여섯 방식으로 많아야 열두 개가 나온다
    const many = Array.from({ length: 30 }, (_, i) => cand(`후보 ${String.fromCodePoint(0xac00 + i * 588)} 문구`, TECHNIQUE_IDS[i % TECHNIQUE_IDS.length]))
    for (const count of [0, -5, 2.5, 'x', null]) assert.equal(rankCandidates(many, { count }).length, LIMITS.candidates.count)
    assert.equal(rankCandidates(many, { count: 1000 }).length, TECHNIQUE_IDS.length * 2)
    assert.equal(rankCandidates(many, { count: 7 }).length, 7)
  })
})
