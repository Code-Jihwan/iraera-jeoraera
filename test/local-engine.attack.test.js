// 공격 테스트(규칙 조합 엔진·틀 문법): 명세의 규칙을 그대로 옮겨 확인한다.
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { splitTail } from '../shared/hangul.js'
import { generateLocal } from '../server/generate/local-engine.js'
import { fillTemplate } from '../server/generate/template.js'

const seed = JSON.parse(readFileSync(new URL('../server/trends/seed-trends.json', import.meta.url), 'utf8')).trends
const byId = (id) => seed.find((t) => t.id === id)
const frames = seed.filter((t) => t.engine?.asFrame === true)
const engineTrends = seed.filter((t) => t.engine)
const keywordTrends = seed.filter((t) => !t.engine)
const REGISTERS = ['banmal', 'haeyo', 'hapsyo', 'eumseum']
const norm = (s) => splitTail(String(s).toLowerCase()).core.replace(/\s+/g, '')

const gen = (trend, profile = {}, options = {}, extra = {}) => generateLocal({ profile, trend, options, feedback: {}, frames, ...extra })
const texts = (out) => out.map((c) => c.text)
const only = (endings, register = 'banmal') => ({ register, endings })

// ── 틀 문법 ───────────────────────────────────────────────

describe('공격: fillTemplate', () => {
  test('토큰과 조사, 첫 글자, 완성형', () => {
    assert.equal(fillTemplate('{X|은/는} 못 참지', { X: '떡볶이' }), '떡볶이는 못 참지')
    assert.equal(fillTemplate('{X|은/는} 못 참지', { X: '월요일' }), '월요일은 못 참지')
    assert.equal(fillTemplate('{X|은/는} 못 참지', { X: '야근' }), '야근은 못 참지')
    assert.equal(fillTemplate('{X|이/가} 보여', { X: '도서관' }), '도서관이 보여')
    assert.equal(fillTemplate('우리 집 {X1}세권', { X: '붕어빵' }), '우리 집 붕세권')
    assert.equal(fillTemplate('{X}? {form}', { X: '비', form: '오히려 좋아' }), '비? 오히려 좋아')
  })
  test('모르는 토큰은 그대로, 두 칸 공백은 하나로, 앞뒤 공백 제거', () => {
    assert.equal(fillTemplate('  {Y}  {X}  ', { X: '가' }), '{Y} 가')
  })
  test('빈칸 말이 없으면 빈칸이 있는 틀은 빈 문자열', () => {
    assert.equal(fillTemplate('{X} 정보'), '')
    assert.equal(fillTemplate('{X|은/는} 못 참지', { X: '' }), '')
    assert.equal(fillTemplate('우리 집 {X1}세권', {}), '')
    assert.equal(fillTemplate('오히려 좋아', {}), '오히려 좋아')
  })
  test('치환 특수 문자($&)를 그대로 넣는다', () => {
    assert.equal(fillTemplate('{X} 정보', { X: '$&$1' }), '$&$1 정보')
  })
})

// ── 어미 활용 (손으로 확인한 기대값) ─────────────────────────

describe('공격: 어미 활용 — 명세의 표', () => {
  const cases = [
    // [트렌드, 어미, 높임, topic, 기대 문구]
    ['seed-ohiryeo-joa', '거든', 'banmal', '', '오히려 좋거든'],
    ['seed-ohiryeo-joa', '는데', 'banmal', '', '오히려 좋은데'],
    ['seed-ohiryeo-joa', '은데', 'banmal', '', '오히려 좋은데'],
    ['seed-ohiryeo-joa', '는데요', 'haeyo', '', '오히려 좋은데요'],
    ['seed-ohiryeo-joa', '용', 'haeyo', '', '오히려 좋아용'],
    ['seed-ohiryeo-joa', '당', 'banmal', '', '오히려 좋당'],
    ['seed-ohiryeo-joa', '넹', 'banmal', '', '오히려 좋넹'],
    ['seed-ohiryeo-joa', '징', 'banmal', '', '오히려 좋징'],
    ['seed-ohiryeo-joa', '구나', 'banmal', '', '오히려 좋구나'],
    ['seed-ohiryeo-joa', '다니까', 'banmal', '', '오히려 좋다니까'],
    ['seed-ohiryeo-joa', '긴 해', 'banmal', '', '오히려 좋긴 해'],
    ['seed-gatsaeng', '네', 'banmal', '', '갓생 사네'],
    ['seed-gatsaeng', '네요', 'haeyo', '', '갓생 사네요'],
    ['seed-gatsaeng', '는데', 'banmal', '', '갓생 사는데'],
    ['seed-gatsaeng', '거든', 'banmal', '', '갓생 살거든'],
    ['seed-gatsaeng', '구나', 'banmal', '', '갓생 사는구나'],
    ['seed-gatsaeng', '용', 'haeyo', '', '갓생 살아용'],
    ['seed-gatsaeng', '당', 'banmal', '', '갓생 산당'],
    ['seed-kingbatne', '는데', 'banmal', '', '킹받는데'],
    ['seed-kingbatne', '잖아', 'banmal', '', '킹받잖아'],
    ['seed-kingbatne', '군', 'banmal', '', '킹받는군'],
    ['seed-pom-michyeotda', '는데', 'banmal', '', '오늘 급식 폼 미쳤는데'],
    ['seed-pom-michyeotda', '구나', 'banmal', '', '오늘 급식 폼 미쳤구나'],
    ['seed-pom-michyeotda', '당', 'banmal', '', '오늘 급식 폼 미쳤당'],
    ['seed-donggyeol-geonjo', '는데', 'banmal', '야근', '야근 동결건조하고 싶은데'],
    ['seed-gungnul', '거든', 'banmal', '떡볶이', '떡볶이는 국룰이거든'],
    ['seed-gungnul', '는데', 'banmal', '월요일', '월요일은 국룰인데'],
    ['seed-gungnul', '요', 'haeyo', '야근', '야근은 국룰이에요'],
    ['seed-gungnul', '용', 'haeyo', '야근', '야근은 국룰이에용'],
    ['seed-nallijabeseu', '거든', 'banmal', '', '난리자베스거든'],
    // 해요체 화자에게 ‘난리자베스예요’는 기본 문구 그 자체라 어미 후보가 될 수 없다 — 반말 화자의 ‘요’로 본다
    ['seed-nallijabeseu', '요', 'banmal', '', '난리자베스예요'],
    ['seed-nallijabeseu', '다니까', 'banmal', '', '난리자베스라니까'],
    ['seed-chaegeopkwae', '잖아', 'banmal', '', '책없쾌잖아'],
    ['seed-chaegeopkwae', '당', 'banmal', '', '책없쾌당'],
    ['seed-segwon', '야', 'eumseum', '붕어빵', '우리 집 붕세권이야'],
    ['seed-segwon', '거든', 'banmal', '월요일', '우리 집 월세권이거든'],
    ['seed-mot-chamji', '거든', 'banmal', '떡볶이', '떡볶이는 못 참거든'],
    ['seed-mot-chamji', '잖아', 'banmal', '월요일', '월요일은 못 참잖아'],
    ['seed-mot-chamji', '는데', 'banmal', '야근', '야근은 못 참는데'],
    ['seed-mot-chamji', '네', 'banmal', '야근', '야근은 못 참네'],
    ['seed-jungkkeokma', '지', 'eumseum', '식욕', '중요한 건 꺾이지 않는 식욕이지'],
    ['seed-jungkkeokma', '거든', 'banmal', '떡볶이', '중요한 건 꺾이지 않는 떡볶이거든'],
    ['seed-jinsimin-pyeon', '거든', 'banmal', '야근', '야근에 진심인 편이거든'],
    ['seed-jinsimin-pyeon', '임', 'banmal', '야근', '야근에 진심인 편임'],
    ['seed-ttalkkak', '는데', 'banmal', '', '딸깍이면 끝인데'],
    ['seed-ttalkkak', '거든', 'banmal', '야근', '야근은 딸깍이면 끝이거든'],
    ['seed-aljalttakkkalsen', '잖아', 'banmal', '', '알잘딱깔센이잖아'],
    ['seed-moreuneun-gae-sanchaek', '거든', 'banmal', '', '모르는 개 산책이거든'],
  ]
  for (const [id, ending, register, topic, expected] of cases) {
    test(`${expected}`, () => {
      const out = gen(byId(id), only([ending], register), { topic, situation: 'talk', spice: 'mild' })
      assert.ok(out.some((c) => c.text === expected), `${id}+${ending}(${register}, ${topic}) → ${texts(out).join(' / ')}`)
    })
  }

  test('표에 없는 어미는 추측하지 않는다', () => {
    for (const ending of ['겠다', '래', '냐', '니']) {
      for (const t of engineTrends) {
        const out = gen(t, only([ending]), { situation: 'talk', spice: 'mild' })
        assert.ok(out.every((c) => !c.styleElements.includes(`어미 ~${ending}`)), `${t.id}: ${ending}`)
      }
    }
  })

  test('잘못된 결합이 나오지 않는다 (받침 뒤 예요, 받침 없는 뒤 이에요 등)', () => {
    for (const t of engineTrends) {
      for (const register of REGISTERS) {
        for (const topic of ['', '떡볶이', '월요일', '야근']) {
          for (const c of gen(t, only(['요', '용', '거든', '는데'], register), { topic, situation: 'talk' })) {
            for (const m of c.text.matchAll(/(\S)(이에요|예요|이에용|예용)/gu)) {
              const prev = m[1].codePointAt(0)
              if (prev < 0xac00 || prev > 0xd7a3) continue
              const hasJong = (prev - 0xac00) % 28 !== 0
              const isI = m[2].startsWith('이에')
              // '이에요'는 받침 뒤에만, '예요'는 받침 없는 말 뒤에만 (단 '이' 자체로 끝나는 말 + 에요는 제외)
              if (m[1] === '이' && !isI) continue
              assert.ok(isI ? hasJong || m[1] === '이' : !hasJong, `${t.id}: ${c.text}`)
            }
          }
        }
      }
    }
  })
})

// ── 전역 제약 ─────────────────────────────────────────────

const PROFILES = [
  { register: 'banmal', endings: ['거든', '잖아', '네', '는데'], fillers: ['아니'], tail: { kk: 'ㅋㅋㅋ', punct: ['~'] } },
  { register: 'haeyo', endings: ['요', '죠', '네요'], fillers: ['약간'], tail: { hh: 'ㅎㅎ', emoji: ['😂'] } },
  { register: 'eumseum', endings: ['임'] },
  { register: 'haeyo', endings: ['용', '당'] },
  { register: 'hapsyo', endings: ['습니다'], rhythm: { short: true, tempo: 'fast' }, tail: { elongation: true } },
]

describe('공격: 모든 후보의 전역 제약', () => {
  test('중괄호·두 칸 공백·undefined/null 없음, 48자 이하, 정규화 후 유일, 예문 정확히 2개, 결정적', () => {
    for (const t of seed) {
      for (const profile of PROFILES) {
        for (const topic of ['', '떡볶이', '월요일', '야근']) {
          for (const spice of ['mild', 'medium', 'hot']) {
            const out = gen(t, profile, { topic, spice, situation: 'sns' })
            const again = gen(t, profile, { topic, spice, situation: 'sns' })
            assert.deepEqual(out, again, `${t.id} 결정적`)
            // 순한맛의 고정 문구(pos fixed)는 어미·비틀기·줄임이 없고, 예시 낱말로는 ‘내 단어 넣기’를 할 수 없어
            // 명세상 추임새 2개 + 리듬 2개가 최대다
            const floor = spice === 'mild' && t.engine?.pos === 'fixed' ? 4 : 5
            assert.ok(out.length >= floor, `${t.id}/${profile.register}/${topic}/${spice}: ${out.length}개`)
            const keys = new Set()
            for (const c of out) {
              const where = `${t.id}: ${c.text}`
              assert.ok(!/[{}]/.test(c.text), where)
              assert.ok(!/\s{2,}/.test(c.text), where)
              assert.ok(!/undefined|null|NaN/.test(JSON.stringify(c)), where)
              assert.ok(Array.from(c.text).length <= 48, where)
              assert.equal(c.examples.length, 2, where)
              assert.notEqual(c.examples[0], c.examples[1], where)
              for (const e of c.examples) {
                assert.ok(e.includes(c.text), where)
                assert.ok(!/[{}]|\s{2,}/.test(e), `${where} :: ${e}`)
              }
              assert.ok(!keys.has(norm(c.text)), `중복 ${where}`)
              keys.add(norm(c.text))
              assert.equal(typeof c.why, 'string')
              assert.ok(c.why.endsWith('요.'), `해요체 ${where}: ${c.why}`)
              assert.ok(['ending', 'filler', 'slot', 'blend', 'rhythm', 'twist'].includes(c.technique))
              if (spice === 'mild') assert.ok(!['twist', 'blend'].includes(c.technique), `순한맛 ${where}`)
            }
          }
        }
      }
    }
  })

  test('이미 보여 준 문구는 다시 내지 않는다', () => {
    const t = byId('seed-ohiryeo-joa')
    const first = gen(t, PROFILES[0], {})
    const shown = texts(first)
    const second = generateLocal({ profile: PROFILES[0], trend: t, options: {}, feedback: { shown }, frames })
    for (const c of second) assert.ok(!shown.map(norm).includes(norm(c.text)), c.text)
  })

  test('memeElement: 엔진 힌트가 있으면 pattern(없으면 keyword)', () => {
    for (const t of engineTrends) for (const c of gen(t, PROFILES[0])) assert.equal(c.memeElement, t.pattern ?? t.keyword, t.id)
  })

  test('특정 조사 맞춤: 떡볶이는 / 월요일은 / 야근은', () => {
    const t = byId('seed-mot-chamji')
    for (const [topic, want] of [['떡볶이', '떡볶이는'], ['월요일', '월요일은'], ['야근', '야근은']]) {
      const out = gen(t, PROFILES[0], { topic })
      assert.ok(out.some((c) => c.text.includes(want)), topic)
      assert.ok(!out.some((c) => c.text.includes(`${topic}${want.endsWith('은') ? '는' : '은'}`)), topic)
    }
  })
})

// ── 방식별 규칙 ───────────────────────────────────────────

describe('공격: 방식별 규칙', () => {
  test('slot(내 단어 넣기)은 X가 options.topic에서 왔거나 빈칸이 필수일 때만', () => {
    const offenders = []
    for (const t of engineTrends) {
      const slot = t.engine.slot
      if (!slot || slot.required !== false) continue
      for (const c of gen(t, PROFILES[0], { topic: '' })) if (c.technique === 'slot') offenders.push(`${t.id}: ${c.text}`)
    }
    assert.deepEqual(offenders, [])
  })

  test('slot 후보의 why에는 넣은 말이 나온다', () => {
    for (const t of engineTrends) {
      for (const c of gen(t, PROFILES[0], { topic: '떡볶이' })) {
        if (c.technique === 'slot' && c.text.includes('떡')) assert.ok(c.why.includes('떡볶이') || t.keyword.includes('떡볶이'), `${t.id}: ${c.why}`)
      }
    }
  })

  test('pos fixed: 어미를 바꾸지 않는다 — ending 후보가 없어야 한다', () => {
    const offenders = []
    for (const t of engineTrends.filter((t) => t.engine.pos === 'fixed')) {
      for (const register of REGISTERS) {
        for (const c of gen(t, { ...PROFILES[0], register })) if (c.technique === 'ending') offenders.push(`${t.id}/${register}: ${c.text} (${c.why})`)
      }
    }
    assert.deepEqual(offenders, [])
  })

  test('ending 후보가 기본 문구와 같으면 안 된다 (Skip when the result equals the base phrase)', () => {
    const offenders = []
    for (const t of engineTrends) {
      const slot = t.engine.slot
      if (slot && slot.required !== false) continue
      for (const register of REGISTERS) {
        const base = fillTemplate(t.engine.forms[register] ?? t.engine.forms.banmal, {})
        for (const c of gen(t, { ...PROFILES[0], register }, { situation: 'talk' })) {
          if (c.technique === 'ending' && c.text === base) offenders.push(`${t.id}/${register}: ${c.text}`)
        }
      }
    }
    assert.deepEqual(offenders, [])
  })

  test('추임새는 두 개까지, 두 개를 겹쳐 쓰지 않는다', () => {
    const t = byId('seed-ohiryeo-joa')
    const out = gen(t, { register: 'banmal', fillers: ['아니', '진짜', '근데'] })
    assert.ok(out.filter((c) => c.technique === 'filler').length <= 2)
    for (const c of out) assert.ok(!/^(아니|진짜|근데) (아니|진짜|근데) /.test(c.text), c.text)
  })

  test('리듬: 짧게 끊기는 ‘오히려. 좋아.’, 늘이기는 ‘좋아아아’·‘참지이이’, 붙이기는 공백 제거; 최대 2개', () => {
    const beat = gen(byId('seed-ohiryeo-joa'), { register: 'banmal', rhythm: { short: true } }, { situation: 'chat' })
    assert.ok(texts(beat).includes('오히려. 좋아.'), texts(beat).join(' / '))
    const stretch = gen(byId('seed-ohiryeo-joa'), { register: 'banmal', tail: { elongation: true } })
    assert.ok(texts(stretch).includes('오히려 좋아아아'), texts(stretch).join(' / '))
    const stretch2 = gen(byId('seed-mot-chamji'), { register: 'banmal', tail: { elongation: true } }, { topic: '떡볶이' })
    assert.ok(texts(stretch2).includes('떡볶이는 못 참지이이'), texts(stretch2).join(' / '))
    const join = gen(byId('seed-ohiryeo-joa'), { register: 'banmal', rhythm: { tempo: 'fast' } })
    assert.ok(texts(join).includes('오히려좋아'), texts(join).join(' / '))
    const all = gen(byId('seed-ohiryeo-joa'), { register: 'banmal', rhythm: { short: true, tempo: 'fast' }, tail: { elongation: true } })
    assert.ok(all.filter((c) => c.technique === 'rhythm').length <= 2)
  })

  test('짧게 끊은 후보에는 말끝 습관을 덧붙이지 않는다', () => {
    for (const t of engineTrends) {
      for (const c of gen(t, { register: 'banmal', rhythm: { short: true }, tail: { kk: 'ㅋㅋㅋ', punct: ['!!'], emoji: ['😂'] } }, { situation: 'sns' })) {
        if (c.styleElements.includes('리듬 짧게 끊기')) assert.match(c.text, /\.$/, `${t.id}: ${c.text}`)
      }
    }
  })

  test('줄임말: 순한맛에는 없고, 키워드와 다르며, why에 풀어 쓴 말', () => {
    const t = byId('seed-mot-chamji')
    const hot = gen(t, PROFILES[0], { topic: '떡볶이', spice: 'hot' })
    const blend = hot.find((c) => c.technique === 'blend')
    assert.ok(blend, texts(hot).join(' / '))
    assert.equal(splitTail(blend.text).core, '떡못참')
    assert.ok(blend.why.includes('‘떡볶이는 못 참지’'), blend.why)
    assert.ok(!gen(t, PROFILES[0], { topic: '떡볶이', spice: 'mild' }).some((c) => c.technique === 'blend'))
  })

  test('비틀기: 중간맛 1개, 매운맛 2개까지, 순한맛 0개 (엔진 힌트가 있는 트렌드)', () => {
    for (const t of engineTrends) {
      const count = (spice) => gen(t, PROFILES[0], { spice }).filter((c) => c.technique === 'twist').length
      assert.equal(count('mild'), 0, t.id)
      assert.ok(count('medium') <= 1, t.id)
      assert.ok(count('hot') <= 2, t.id)
    }
  })
})

// ── 말끝 습관 ─────────────────────────────────────────────

describe('공격: 말끝 습관 (상황별)', () => {
  const tail = { kk: 'ㅋㅋㅋ', hh: 'ㅎㅎ', cry: 'ㅠㅠ', emoji: ['😂'], punct: ['!!'] }
  const profile = { register: 'banmal', endings: ['거든'], tail }
  test('talk: 아무것도 붙이지 않는다 (ㅋ·ㅎ·ㅠ·이모지·!! 없음)', () => {
    for (const t of seed) for (const c of gen(t, profile, { situation: 'talk' })) assert.ok(!/[ㅋㅎㅠ]|\p{Extended_Pictographic}|!!/u.test(c.text), `${t.id}: ${c.text}`)
  })
  test('shorts: 문장부호만 (웃음·이모지 없음)', () => {
    for (const t of seed) for (const c of gen(t, profile, { situation: 'shorts' })) assert.ok(!/[ㅋㅎㅠ]|\p{Extended_Pictographic}/u.test(c.text), `${t.id}: ${c.text}`)
  })
  test('chat: 이모지는 붙이지 않는다, ㅠㅠ는 자조·푸념에서만', () => {
    for (const t of seed) {
      for (const c of gen(t, profile, { situation: 'chat' })) {
        assert.ok(!/\p{Extended_Pictographic}/u.test(c.text), `${t.id}: ${c.text}`)
        if (t.category !== '자조·푸념') assert.ok(!c.text.includes('ㅠㅠ'), `${t.id}: ${c.text}`)
      }
    }
  })
  test('붙인 습관은 styleElements에 적고, 대략 절반만 꾸민다', () => {
    let decorated = 0
    let total = 0
    for (const t of engineTrends) {
      for (const c of gen(t, profile, { situation: 'chat' })) {
        total++
        if (/ㅋㅋㅋ$/.test(c.text)) {
          decorated++
          assert.ok(c.styleElements.includes('웃음 ㅋㅋㅋ'), `${t.id}: ${c.text}`)
        }
      }
    }
    assert.ok(decorated > 0 && decorated < total)
  })
})

// ── 예문 ──────────────────────────────────────────────────

describe('공격: 예문', () => {
  test('예문 두 개는 서로 다른 engine.contexts 뒤에 후보를 붙인 것', () => {
    const offenders = []
    for (const t of engineTrends) {
      for (const register of REGISTERS) {
        for (const c of gen(t, { register, endings: ['거든'], fillers: ['아니', '진짜'] }, { topic: '' })) {
          const contexts = t.engine.contexts
          const used = c.examples.map((e) => contexts.find((ctx) => {
            const rendered = ctx.includes('{X')
              ? null
              : ctx
            return rendered !== null && e.startsWith(`${rendered} `)
          }) ?? (contexts.some((ctx) => ctx.includes('{X')) ? 'templated' : null))
          if (used.some((u) => u === null) || (used[0] === used[1] && used[0] !== 'templated')) offenders.push(`${t.id}/${register}: ${c.examples.join(' / ')}`)
        }
      }
    }
    assert.deepEqual(offenders.slice(0, 10), [])
  })
})

// ── 키워드형 트렌드 ───────────────────────────────────────

describe('공격: 키워드형 트렌드와 문형', () => {
  test('문형마다 많아야 2개, memeElement는 ‘문형’ 문형 + ‘키워드’, 키워드가 문구에 들어간다', () => {
    for (const t of keywordTrends) {
      const out = gen(t, PROFILES[0], { spice: 'hot' })
      assert.ok(out.length >= 5, t.id)
      const perFrame = {}
      for (const c of out) {
        const m = c.memeElement.match(/^‘(.+)’ 문형 \+ ‘(.+)’$/u)
        assert.ok(m, c.memeElement)
        assert.equal(m[2], t.keyword)
        perFrame[m[1]] = (perFrame[m[1]] ?? 0) + 1
        assert.ok(c.why.includes(m[1]) || c.why.includes(t.keyword), c.why)
      }
      for (const [frame, n] of Object.entries(perFrame)) assert.ok(n <= 2, `${t.id}: ${frame} ${n}개`)
      assert.ok(Object.keys(perFrame).length >= 3, `${t.id}: 문형 ${Object.keys(perFrame).length}개`)
    }
  })

  test('frames가 비면 내장 문형 세 개로 만든다', () => {
    const out = generateLocal({ profile: PROFILES[0], trend: { id: 'custom-x', keyword: '붕어빵', engine: null }, options: {}, feedback: {}, frames: [] })
    assert.ok(out.length >= 5, texts(out).join(' / '))
    assert.ok(texts(out).some((s) => s.includes('붕어빵은 못 참')))
  })

  test('사용자 입력 키워드에 틀 문법·특수 문자가 있어도 깨지지 않는다', () => {
    for (const keyword of ['{X}', '{form}{X1}', '$&', 'a|b', '떡볶이ㅋㅋ!!', ' 공백  많은   말 ', '😂']) {
      const out = generateLocal({ profile: PROFILES[0], trend: { id: 'c', keyword, engine: null }, options: {}, feedback: {}, frames })
      for (const c of out) assert.ok(!/[{}]|\s{2,}/.test(c.text), `${keyword}: ${c.text}`)
    }
  })
})

// ── 엉터리 입력 ───────────────────────────────────────────

describe('공격: 엉터리 입력', () => {
  test('throw 없이 배열을 돌려준다', () => {
    const inputs = [undefined, null, {}, { trend: null }, { trend: 'x' }, { trend: { keyword: 5 } }, { trend: seed[0], profile: 'x', options: 1, feedback: [], frames: 'x', count: -1, rng: 'x' }, { trend: { keyword: 'x', engine: { forms: 'x' } } }, { trend: { keyword: 'x', engine: { pos: 'noun', forms: { banmal: '{X}' }, slot: { required: true } } } }]
    for (const input of inputs) assert.ok(Array.isArray(generateLocal(input)))
  })

  test('rng가 범위를 벗어난 값을 줘도 깨지지 않는다', () => {
    for (const value of [NaN, 1, -5, 1e9, Infinity]) {
      const out = gen(byId('seed-ohiryeo-joa'), PROFILES[0], {}, { rng: () => value })
      assert.ok(out.length >= 5)
    }
  })

  test('아주 큰 입력도 빨리 끝낸다', () => {
    const big = 'ㄱ가'.repeat(100000)
    const started = performance.now()
    const out = generateLocal({ profile: { endings: Array(100000).fill(big), fillers: Array(100000).fill(big), samples: Array(1e5).fill(big) }, trend: { id: big, keyword: big, engine: null }, options: { topic: big }, feedback: { shown: Array(1e5).fill(big) }, frames })
    assert.ok(Array.isArray(out))
    assert.ok(performance.now() - started < 2000)
  })
})
