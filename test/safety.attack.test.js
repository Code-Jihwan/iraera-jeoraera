// 안전 필터(server/safety) 공격 테스트 — 명세의 요구를 그대로 옮긴다(현재 구현의 동작이 아니라)
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeForMatch, checkText, checkTrend, checkCandidate, filterStyleTerms } from '../server/safety/filter.js'
import { ENTRIES } from '../server/safety/lexicon.js'

const level = (text, context = 'output') => checkText(text, { context }).level

function expectAll(cases, predicate, label, context = 'output') {
  const wrong = cases.filter((text) => !predicate(level(text, context))).map((text) => `${text} → ${level(text, context)}`)
  assert.deepEqual(wrong, [], label)
}

describe('오탐: 짧은 말은 낱말 경계에서만 맞춘다', () => {
  // ‘N시발’(N시 출발)은 시간표·여행 문장에서 흔히 쓴다. 숫자를 걷어 낸 자리를 낱말 첫머리로 보면 안 된다.
  test('출발 시각 표현(N시발, N시 발)은 막히지 않는다', () => {
    expectAll(
      ['서울역 9시발 부산행 KTX', '인천공항 오후 3시 발 뉴욕행 항공편', '오후 3시발 뉴욕행', '부산행 8시 발'],
      (got) => got !== 'block',
      '출발 시각 문장이 막힘',
    )
  })

  test('금칙어를 품은 평범한 합성어는 막히지 않는다', () => {
    // 지랄탄(최루탄의 한 종류)은 연구 자료 falsePositives에 있다
    expectAll(['지랄탄', '감염병신고서', '질병신호'], (got) => got !== 'block', '평범한 합성어가 막힘')
  })
})

describe('우회 변형: 띄어쓰기·되풀이', () => {
  test('영문 금칙어를 띄우거나 점을 찍거나 글자를 늘여도 잡는다', () => {
    expectAll(['S E X', 's.e.x', 'f u c k', 'fuuuck', 'siiibal'], (got) => got === 'block', '영문 우회가 통과')
  })

  test('세 글자 이상 금칙어를 한 글자씩 띄어 써도 잡는다', () => {
    expectAll(['김 치 녀', '로 리 콘', '포 르 노', '성 폭 행'], (got) => got === 'block', '띄어 쓴 금칙어가 통과')
  })

  test('트렌드 단계에서 띄어 쓴 참사 이름도 막는다', () => {
    expectAll(['세 월 호', '세월 호'], (got) => got === 'block', '띄어 쓴 참사 이름이 통과', 'trend')
  })
})

describe('선정적 표현: 문장 속 대표 낱말', () => {
  test('성기를 가리키는 말이 문장 안에 명사로 쓰이면 막는다', () => {
    expectAll(['니 보지', '내 자지', '보지 냄새', '자지 빨아'], (got) => got === 'block', '선정적 문장이 통과')
  })

  test('흔한 활용형(보지 마, 자지 마)은 막지 않는다', () => {
    expectAll(['보지 마', '자지 마', '해보지 않았어', '남자지'], (got) => got === 'ok', '활용형이 걸림')
  })
})

describe('명세 기본 요구', () => {
  test('과장 표현은 결과물 단계에서 막히지 않는다', () => {
    expectAll(['웃겨 죽겠다', '귀여워서 사망', '배고파 죽겠어'], (got) => got !== 'block', '과장 표현이 막힘')
  })

  test('참사 고유의 말은 어느 단계에서도 막는다', () => {
    for (const context of ['trend', 'output', 'input']) {
      expectAll(['참사', '추모', '유족', '희생자', '분향소'], (got) => got === 'block', `${context}에서 통과`, context)
    }
  })

  test('사건 표지어는 트렌드에서 막고 결과물에서는 주의로 둔다', () => {
    assert.equal(level('사망', 'trend'), 'block')
    assert.equal(level('사망', 'output'), 'caution')
    assert.equal(level('사망', 'input'), 'caution')
  })

  test('결과에는 범주만 있고 맞춘 낱말은 어디에도 없다', () => {
    for (const item of ENTRIES.slice(0, 200)) {
      const verdict = checkText(`앞말 ${item.term} 뒷말`)
      assert.deepEqual(Object.keys(verdict).sort(), ['categories', 'level', 'ok'])
      assert.ok(!JSON.stringify(verdict).includes(item.term), item.category)
    }
  })

  test('잘못된 입력에 죽지 않는다', () => {
    for (const bad of [undefined, null, 0, NaN, {}, [], Symbol('x'), () => 1, '\ud800', '\u0000']) {
      const v = checkText(bad, null)
      assert.equal(typeof v.ok, 'boolean')
      const n = normalizeForMatch(bad)
      assert.equal(typeof n.compact, 'string')
    }
    assert.equal(typeof checkTrend(null).ok, 'boolean')
    assert.equal(typeof checkCandidate(undefined).ok, 'boolean')
    assert.deepEqual(filterStyleTerms(null), [])
    assert.deepEqual(filterStyleTerms(['좋아', 1, null, '씨발', '그냥']), ['좋아', '그냥'])
  })

  test('후보의 예문 하나만 나빠도 막는다', () => {
    assert.equal(checkCandidate({ text: '오늘도 딸깍', examples: ['좋다', '이 병신아'] }).ok, false)
    assert.equal(checkTrend({ keyword: '딸깍', pattern: '{X} 딸깍', meaning: '세월호 이야기' }).ok, false)
  })

  test('200자 글 검사는 평균 1ms보다 훨씬 빠르다', () => {
    const text = '오늘 진짜 웃겨 죽겠다 ㅋㅋㅋ 개웃겨 미친 존재감 시발점 다시 발표 '.repeat(10).slice(0, 200)
    for (let i = 0; i < 50; i++) checkText(text)
    const runs = 1000
    const t0 = performance.now()
    for (let i = 0; i < runs; i++) checkText(text)
    assert.ok((performance.now() - t0) / runs < 0.5)
  })
})
