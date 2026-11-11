// 말투 분석기 공격 테스트: 명세(SPEC Module A)의 요구를 그대로 옮긴 것이다. 구현의 현재 동작이 아니라 명세를 기준으로 한다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeStyle, summarizeProfile, addItem } from '../shared/style-analyzer.js'
import { maskPII, containsPII } from '../shared/pii.js'

const now = new Date('2026-11-11T00:00:00Z')
const analyze = (lines, extra = {}) => analyzeStyle({ textUtterances: lines, now, ...extra })
const forms = (items) => items.map((x) => x.form)
const endingOf = (line) => forms(analyze([line]).endings)

test('견고성: analyzeStyle(null)도 죽지 않고 빈 프로필을 돌려준다 (규칙 5)', () => {
  const p = analyzeStyle(null)
  assert.equal(p.version, 1)
  assert.deepEqual(p.endings, [])
})

test('견고성: localStorage에서 망가진 프로필(laugh.emoji가 배열이 아님)도 요약·항목 추가가 죽지 않는다', () => {
  for (const emoji of ['x', {}, 5]) {
    const broken = { version: 1, laugh: { emoji }, endings: [], fillers: [], expressions: [], samples: [] }
    assert.doesNotThrow(() => summarizeProfile(broken), JSON.stringify(emoji))
    assert.doesNotThrow(() => addItem(broken, 'endings', '거든', now), JSON.stringify(emoji))
  }
})

test('애교 어미 오탐: 받침 ㅇ으로 끝나는 흔한 명사는 어미가 아니다', () => {
  for (const line of ['다음 달에 여행', '요즘 유행', '은행', '회의 진행', '안경', '환경', '대통령', '특징', '상징']) {
    assert.deepEqual(endingOf(line), [], line)
  }
})

test('어미 오탐: 명사·조사·숫자+단위로 끝나는 발화는 어미가 없다', () => {
  for (const line of ['나 혼자', '우리 20대', '차 2대', '내일까지', '어디까지', '드디어', '구독자', '사용자', '사이다', '아버지', '언니네']) {
    assert.deepEqual(endingOf(line), [], line)
  }
})

test('음슴체 오탐: ㅁ으로 끝나는 명사는 음슴체가 아니다', () => {
  for (const line of ['오늘 마감', '나 지금 강남', '녹음', '우리 담임', '흐름', '올봄', '존재감', '사물함', '말씀']) {
    assert.deepEqual(endingOf(line), [], line)
  }
  const p = analyze(['오늘 마감', '나 지금 강남', '이번 녹음', '우리 담임'])
  assert.equal(p.register.shares.eumseum, 0)
})

test('어미 놓침: 명세가 꼽은 ‘쥬’를 찾는다', () => {
  for (const line of ['맛있쥬', '그렇쥬']) assert.ok(endingOf(line).includes('쥬'), line)
})

test('어미 놓침: 용언 어간 + ㅁ인 ‘아님’은 음슴체다', () => {
  const p = analyze(['그거 아님'])
  assert.equal(p.endings.length, 1)
  assert.equal(p.endings[0].kind, 'eumseum')
})

test('어미 놓침: 해라체 의문 -니 (연구 자료 en-1, 검증됨)', () => {
  const p = analyze(['밥 먹었니'])
  assert.equal(p.endings.length, 1)
  assert.equal(p.endings[0].kind, 'banmal')
})

test('표현: 웃음만으로 된 어절(하하하·히히)은 표현이 아니다', () => {
  const ex = forms(analyze(['하하하 웃기다', '하하하 진짜', '히히 좋아', '히히 고마워']).expressions)
  for (const bad of ['하하하', '히히']) assert.ok(!ex.includes(bad), ex.join(','))
})

test('표현: 두 어절 표현은 실제로 이어 쓴 두 어절이어야 한다(숫자를 건너뛰어 붙이지 않는다)', () => {
  const ex = forms(analyze(['떡볶이 2인분 먹자', '떡볶이 3인분 먹자']).expressions)
  assert.ok(!ex.includes('떡볶이 먹자'), ex.join(','))
})

test('개인정보: 카카오톡 @멘션(한글 이름)은 대표 문장에 그대로 들어가지 않는다', () => {
  assert.equal(containsPII('@김민수 내일 봐'), true)
  assert.ok(!maskPII('@김민수 내일 봐').text.includes('김민수'))
  const p = analyze(['@김민수 내일 몇 시에 볼래', '@이지은 너도 올 거지?'])
  for (const s of p.samples) assert.ok(!/@[가-힣]/.test(s), s)
})

test('이모지: 같은 그림 문자(❤ / ❤️)는 한 가지로 센다', () => {
  const p = analyze(['좋아 ❤️', '최고 ❤', '고마워 ❤️'])
  assert.equal(p.laugh.emoji.length, 1, JSON.stringify(p.laugh.emoji))
  assert.equal(p.laugh.emoji[0].count, 3)
})

test('성능: 함수 자체 한도 안의 기호 반복 입력도 빠르게 끝난다', () => {
  const line = '~'.repeat(499) + '가'
  const lines = Array.from({ length: 200 }, () => line)
  const t0 = performance.now()
  analyzeStyle({ textUtterances: lines, voiceUtterances: lines, now })
  const ms = performance.now() - t0
  assert.ok(ms < 2000, `${Math.round(ms)}ms`)
})
