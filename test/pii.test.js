// 개인정보 가리기
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { maskPII, containsPII, PII_MASK } from '../shared/pii.js'

test('연락처·메일·링크·주민번호·긴 숫자·계정을 가린다', () => {
  const cases = [
    '010-1234-5678',
    '01012345678',
    '010 1234 5678',
    '+82 10-1234-5678',
    '02-123-4567',
    '031-123-4567',
    'me@example.com',
    'https://example.com/path?q=1',
    'www.example.co.kr',
    '900101-1234567',
    '1234-5678-9012-3456',
    '110 123 456789',
    '@my_handle',
  ]
  for (const c of cases) {
    const { text, masked } = maskPII(`연락은 ${c} 로`)
    assert.ok(masked >= 1, c)
    assert.ok(!text.includes(c), `${c} → ${text}`)
    assert.ok(text.includes(PII_MASK), c)
    assert.equal(containsPII(c), true, c)
  }
})

test('시간·가격·횟수 같은 짧은 숫자는 그대로 둔다', () => {
  for (const s of ['3시에 만나', '5000원이야', '2026년 11월 11일', '3번째', '1+1 행사', '오후 3:20', '100% 동의', '키 175cm']) {
    assert.equal(maskPII(s).masked, 0, s)
    assert.equal(maskPII(s).text, s, s)
    assert.equal(containsPII(s), false, s)
  }
})

test('여러 개를 한 번에 가리고, 엉터리 입력에도 문자열을 돌려준다', () => {
  const r = maskPII('메일 a@b.com, 번호 010-1111-2222')
  assert.equal(r.masked, 2)
  assert.equal(r.text, `메일 ${PII_MASK}, 번호 ${PII_MASK}`)
  assert.deepEqual(maskPII(null), { text: '', masked: 0 })
  assert.deepEqual(maskPII(undefined), { text: '', masked: 0 })
  assert.equal(maskPII(12345).text, '12345')
  assert.equal(containsPII(null), false)
})

test('같은 정규식을 여러 번 써도 결과가 같다 (lastIndex 문제 없음)', () => {
  for (let i = 0; i < 5; i++) assert.equal(containsPII('010-1234-5678'), true)
})
