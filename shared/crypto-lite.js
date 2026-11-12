// 서버(Node)와 브라우저가 함께 쓰는 작은 암호 도구. node:crypto 없이 돌아가서 정적 배포(GitHub Pages)에서도 같은 결과를 낸다.
// 보안용이 아니라 식별자를 만드는 데 쓴다: 직접 입력한 트렌드의 id, 생성 요청 번호.

/** SHA-256 라운드 상수: 처음 소수 64개의 세제곱근 소수부 32비트 */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

/** 첫 해시 값: 처음 소수 8개의 제곱근 소수부 32비트 */
const H0 = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]

const rotr = (x, n) => (x >>> n) | (x << (32 - n))

/**
 * 글을 UTF-8로 바꿔 SHA-256을 구하고 소문자 16진수(64자)로 돌려준다.
 * node:crypto의 createHash('sha256').update(text).digest('hex')와 같은 값이다(짝 없는 서로게이트는 둘 다 U+FFFD로 바꾼다).
 * @param {string} text
 * @returns {string}
 */
export function sha256Hex(text) {
  const data = new TextEncoder().encode(String(text))
  const bitLength = data.length * 8
  // 끝에 0x80 한 바이트와 64비트 길이를 붙이고 64바이트 단위로 맞춘다
  const padded = new Uint8Array(Math.ceil((data.length + 9) / 64) * 64)
  padded.set(data)
  padded[data.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000))
  view.setUint32(padded.length - 4, bitLength >>> 0)

  const hash = Uint32Array.from(H0)
  const w = new Uint32Array(64)
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4)
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15]
      const y = w[i - 2]
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)
      w[i] = w[i - 16] + s0 + w[i - 7] + s1
    }
    let [a, b, c, d, e, f, g, h] = hash
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0
      h = g
      g = f
      f = e
      e = (d + t1) | 0
      d = c
      c = b
      b = a
      a = (t1 + t2) | 0
    }
    hash[0] += a
    hash[1] += b
    hash[2] += c
    hash[3] += d
    hash[4] += e
    hash[5] += f
    hash[6] += g
    hash[7] += h
  }
  return Array.from(hash, (word) => word.toString(16).padStart(8, '0')).join('')
}

/**
 * RFC 4122 버전 4 UUID. crypto.randomUUID가 있으면 그것을 쓰고, 없으면(보안 연결이 아닌 브라우저 등) getRandomValues로 만든다.
 * @param {{ randomUUID?: () => string, getRandomValues?: (array: Uint8Array) => Uint8Array }} [cryptoImpl] 테스트에서 바꿔 끼울 수 있다
 * @returns {string}
 */
export function randomUUID(cryptoImpl = globalThis.crypto) {
  if (typeof cryptoImpl?.randomUUID === 'function') return cryptoImpl.randomUUID()
  if (typeof cryptoImpl?.getRandomValues !== 'function') throw new Error('이 환경에서는 안전한 난수를 만들 수 없어요.')
  const bytes = cryptoImpl.getRandomValues(new Uint8Array(16))
  // 버전(4)과 변형(10xx) 비트를 맞춘다
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
