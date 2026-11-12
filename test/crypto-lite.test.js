// shared/crypto-lite.js: node:crypto 없이 만든 SHA-256과 UUID가 Node와 같은 값을 내는지
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes, webcrypto } from 'node:crypto'
import { randomUUID, sha256Hex } from '../shared/crypto-lite.js'

const nodeSha = (text) => createHash('sha256').update(text).digest('hex')
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('sha256Hex', () => {
  test('알려진 값(빈 글, abc)', () => {
    assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  test('ASCII·한글·이모지·그 밖의 확장 평면 글자가 node:crypto와 같다', () => {
    const samples = [
      'hello world',
      'The quick brown fox jumps over the lazy dog',
      '킹받네',
      '한글 키워드 · 띄어쓰기와 기호!?',
      'ㅋㅋㅋㅋ ㅠㅠ ㄱㄴㄷ',
      '😀🔥👍🏽',
      '👨‍👩‍👧‍👦 가족',
      '𝌆𝄞𠀀𩸽',
      'é (조합) é',
      '\u0000\u0001\n\t',
      '\ud800 짝 없는 서로게이트 \udfff',
    ]
    for (const text of samples) assert.equal(sha256Hex(text), nodeSha(text), JSON.stringify(text))
  })

  test('블록 경계 근처(55·56·63·64·65바이트)와 긴 글', () => {
    for (const n of [55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 100_000]) assert.equal(sha256Hex('a'.repeat(n)), nodeSha('a'.repeat(n)), `${n}바이트`)
    const long = '가나다라마바사😀'.repeat(5000)
    assert.equal(sha256Hex(long), nodeSha(long))
  })

  test('무작위 글 여러 개', () => {
    for (let i = 0; i < 300; i++) {
      const length = randomBytes(1)[0]
      // 여러 평면의 코드 포인트를 섞는다(서로게이트 영역 제외)
      const chars = Array.from({ length }, () => {
        const pick = randomBytes(3)
        const plane = pick[0] % 4
        const cp = plane === 0 ? 0x20 + (pick[1] % 0x5f) : plane === 1 ? 0xac00 + ((pick[1] << 8) | pick[2]) % 11172 : plane === 2 ? 0x1f300 + (pick[1] % 0x200) : 0x20000 + ((pick[1] << 8) | pick[2])
        return String.fromCodePoint(cp)
      })
      const text = chars.join('')
      assert.equal(sha256Hex(text), nodeSha(text), JSON.stringify(text))
    }
  })

  test('소문자 16진수 64자, 문자열이 아니면 문자열로 바꿔 계산', () => {
    assert.match(sha256Hex('x'), /^[0-9a-f]{64}$/)
    assert.equal(sha256Hex(123), nodeSha('123'))
  })

  test('직접 입력한 트렌드 id는 예전(node:crypto)과 같다', () => {
    for (const keyword of ['킹받네', '럭키비키', 'abc']) assert.equal(`custom-${sha256Hex(keyword).slice(0, 10)}`, `custom-${nodeSha(keyword).slice(0, 10)}`)
  })
})

describe('randomUUID', () => {
  test('기본(crypto.randomUUID)은 v4 형식이고 겹치지 않는다', () => {
    const ids = new Set(Array.from({ length: 200 }, () => randomUUID()))
    assert.equal(ids.size, 200)
    for (const id of ids) assert.match(id, UUID_V4)
  })

  test('randomUUID가 없으면 getRandomValues로 v4를 만든다', () => {
    const fallback = { getRandomValues: (array) => webcrypto.getRandomValues(array) }
    const ids = new Set(Array.from({ length: 200 }, () => randomUUID(fallback)))
    assert.equal(ids.size, 200)
    for (const id of ids) assert.match(id, UUID_V4)
  })

  test('버전·변형 비트를 맞춘다(바이트가 모두 0xff·0x00이어도)', () => {
    assert.equal(randomUUID({ getRandomValues: (a) => a.fill(0xff) }), 'ffffffff-ffff-4fff-bfff-ffffffffffff')
    assert.equal(randomUUID({ getRandomValues: (a) => a.fill(0) }), '00000000-0000-4000-8000-000000000000')
  })

  test('난수를 만들 수 없으면 오류', () => {
    assert.throws(() => randomUUID({}), /난수/)
  })
})
