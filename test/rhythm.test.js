import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { FRAME_MS, TEMPO_THRESHOLDS, analysisWindowSize, analyzeRhythm, emptyRhythm, frameLevel, readRecognitionResults } from '../shared/rhythm.js'

const EMPTY = { seconds: 0, speakingSec: 0, pauseRatio: 0, phraseCount: 0, avgPhraseSec: 0, syllPerSec: null, tempo: 'unknown', phrasing: 'unknown' }
const QUIET = 0.004
const LOUD = 0.2

/** 초 → 프레임 수 */
const frames = (sec, frameMs = FRAME_MS) => Math.round((sec * 1000) / frameMs)
const fill = (count, level) => new Array(count).fill(level)
const quiet = (sec, level = QUIET) => fill(frames(sec), level)
const speech = (sec, level = LOUD) => fill(frames(sec), level)
const syllables = (count) => '가'.repeat(count)
const rhythm = (levels, transcript = '') => analyzeRhythm({ levels, transcript })

/** 테스트마다 같은 값이 나오는 난수 */
function seededRng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const jitter = (count, low, high, rng) => Array.from({ length: count }, () => low + (high - low) * rng())

/** 앞뒤에 조용한 구간을 두고, 말 덩어리와 쉼을 번갈아 놓은 타임라인 */
function talk({ lead = 1, tail = 1, phrases, pauses = [] }) {
  const out = quiet(lead)
  phrases.forEach((sec, i) => {
    out.push(...speech(sec))
    if (i < phrases.length - 1) out.push(...quiet(pauses[i % pauses.length]))
  })
  return out.concat(quiet(tail))
}

/** 말소리 사이에 조용한 프레임을 gapFrames만큼 끼운 타임라인 */
const withGap = (gapFrames) => [...quiet(1), ...speech(1), ...fill(gapFrames, QUIET), ...speech(1), ...quiet(1)]

function assertTwoDecimals(result) {
  for (const key of ['seconds', 'speakingSec', 'pauseRatio', 'avgPhraseSec', 'syllPerSec']) {
    const v = result[key]
    if (v !== null) assert.equal(v, Math.round(v * 100) / 100, `${key}는 소수 둘째 자리까지`)
  }
}

describe('analyzeRhythm — 조용한 녹음', () => {
  test('소리가 전혀 없으면 길이만 남고 나머지는 0·unknown', () => {
    assert.deepEqual(rhythm(fill(200, 0)), { ...EMPTY, seconds: 10 })
  })

  test('조용한 방의 잔잔한 소음은 말이 아니다', () => {
    const rng = seededRng(1)
    const result = rhythm(jitter(240, 0.002, 0.007, rng), syllables(80))
    assert.deepEqual(result, { ...EMPTY, seconds: 12 })
  })

  test('말소리가 없으면 받아쓴 글이 있어도 빠르기를 재지 않는다', () => {
    const result = rhythm(quiet(8), syllables(60))
    assert.equal(result.syllPerSec, null)
    assert.equal(result.tempo, 'unknown')
    assert.equal(result.phrasing, 'unknown')
  })
})

describe('analyzeRhythm — 쉬지 않고 말한 녹음', () => {
  // 실제 말소리처럼 프레임마다 세기가 출렁인다
  const steady = [...quiet(1), ...Array.from({ length: frames(8) }, (_, i) => (i % 2 ? 0.12 : 0.3)), ...quiet(1)]

  test('한 덩어리로 이어지고 쉼 비율은 0', () => {
    assert.deepEqual(rhythm(steady, syllables(48)), {
      seconds: 10,
      speakingSec: 8,
      pauseRatio: 0,
      phraseCount: 1,
      avgPhraseSec: 8,
      syllPerSec: 6,
      tempo: 'normal',
      phrasing: 'flowing',
    })
  })

  test('받아쓴 글이 없으면 빠르기만 비고 나머지는 그대로', () => {
    const result = rhythm(steady)
    assert.equal(result.syllPerSec, null)
    assert.equal(result.tempo, 'unknown')
    assert.equal(result.speakingSec, 8)
    assert.equal(result.phrasing, 'flowing')
  })

  test('Float32Array로 받은 타임라인도 같은 결과', () => {
    assert.deepEqual(rhythm(Float32Array.from(steady), syllables(48)), rhythm(steady, syllables(48)))
  })
})

describe('analyzeRhythm — 쉬어 가며 말한 녹음', () => {
  test('2초씩 네 덩어리, 사이마다 0.6초 쉼', () => {
    const result = rhythm(talk({ phrases: [2, 2, 2, 2], pauses: [0.6] }))
    // 말 8초, 첫소리부터 끝소리까지 9.8초 중 쉼 1.8초
    assert.deepEqual(result, { seconds: 11.8, speakingSec: 8, pauseRatio: 0.18, phraseCount: 4, avgPhraseSec: 2, syllPerSec: null, tempo: 'unknown', phrasing: 'even' })
  })

  test('0.8초씩 짧게 끊으면 choppy', () => {
    const result = rhythm(talk({ phrases: [0.8, 0.8, 0.8, 0.8, 0.8, 0.8], pauses: [0.5] }))
    assert.equal(result.speakingSec, 4.8)
    assert.equal(result.pauseRatio, 0.34)
    assert.equal(result.phraseCount, 6)
    assert.equal(result.avgPhraseSec, 0.8)
    assert.equal(result.phrasing, 'choppy')
  })

  test('앞뒤 침묵은 쉼 비율에 넣지 않는다', () => {
    const short = rhythm(talk({ lead: 1, tail: 1, phrases: [2, 2], pauses: [1] }))
    const long = rhythm(talk({ lead: 4, tail: 6, phrases: [2, 2], pauses: [1] }))
    assert.equal(short.pauseRatio, 0.2)
    assert.equal(long.pauseRatio, 0.2)
    assert.equal(long.seconds, 15)
  })

  test('덩어리 평균 길이의 경계: 1.2초 미만 choppy, 3.5초 초과 flowing, 그 사이 even', () => {
    const phrasingOf = (sec) => rhythm(talk({ lead: 2, tail: 2, phrases: [sec, sec], pauses: [1] }))
    assert.deepEqual([phrasingOf(1.15).avgPhraseSec, phrasingOf(1.15).phrasing], [1.15, 'choppy'])
    assert.deepEqual([phrasingOf(1.2).avgPhraseSec, phrasingOf(1.2).phrasing], [1.2, 'even'])
    assert.deepEqual([phrasingOf(3.5).avgPhraseSec, phrasingOf(3.5).phrasing], [3.5, 'even'])
    assert.deepEqual([phrasingOf(3.55).avgPhraseSec, phrasingOf(3.55).phrasing], [3.55, 'flowing'])
  })

  test('실제 녹음처럼 들쭉날쭉한 타임라인', () => {
    const rng = seededRng(20261111)
    const phraseFrames = [48, 22, 64, 18, 56, 32, 82, 44] // 합 366프레임 = 18.3초
    const pauseFrames = [10, 14, 9, 24, 12, 8, 18] // 합 95프레임 = 4.75초, 모두 400ms 이상
    const noise = (count) => jitter(count, 0.004, 0.009, rng)
    const levels = noise(14)
    phraseFrames.forEach((count, i) => {
      const phrase = jitter(count, 0.09, 0.32, rng)
      // 낱말 사이의 짧은 끊김(100ms)은 말이 이어진 것으로 본다
      for (let f = 6; f < count - 3; f += 12) phrase.splice(f, 2, ...noise(2))
      levels.push(...phrase)
      if (i < pauseFrames.length) levels.push(...noise(pauseFrames[i]))
    })
    levels.push(...noise(500 - levels.length))

    // 14음절 × 7 + 12음절 = 110음절
    assert.deepEqual(rhythm(levels, '어제 친구랑 떡볶이 먹으러 갔는데 '.repeat(7) + '진짜 맛있어서 또 가고 싶더라'), {
      seconds: 25,
      speakingSec: 18.3,
      pauseRatio: 0.21,
      phraseCount: 8,
      avgPhraseSec: 2.29,
      syllPerSec: 6.01,
      tempo: 'normal',
      phrasing: 'even',
    })
  })
})

describe('analyzeRhythm — 끊김 메우기와 짧은 소리 버리기', () => {
  test('200ms 끊김은 말이 이어진 것으로 본다', () => {
    const result = rhythm(withGap(4))
    assert.deepEqual([result.speakingSec, result.pauseRatio, result.phraseCount, result.avgPhraseSec], [2.2, 0, 1, 2.2])
  })

  test('250ms 끊김은 쉼이지만 덩어리는 나뉘지 않는다', () => {
    const result = rhythm(withGap(5))
    assert.deepEqual([result.speakingSec, result.pauseRatio, result.phraseCount, result.avgPhraseSec], [2, 0.11, 1, 2.25])
  })

  test('350ms 쉼까지는 한 덩어리, 400ms부터 두 덩어리', () => {
    const before = rhythm(withGap(7))
    assert.deepEqual([before.speakingSec, before.pauseRatio, before.phraseCount, before.avgPhraseSec], [2, 0.15, 1, 2.35])
    const after = rhythm(withGap(8))
    assert.deepEqual([after.speakingSec, after.pauseRatio, after.phraseCount, after.avgPhraseSec, after.phrasing], [2, 0.17, 2, 1, 'choppy'])
  })

  test('50ms짜리 딸깍 소리는 말이 아니다', () => {
    assert.deepEqual(rhythm([...quiet(2), LOUD, ...quiet(2)]), { ...EMPTY, seconds: 4.05 })
  })

  test('100ms 소리부터는 말로 센다', () => {
    const result = rhythm([...quiet(2), LOUD, LOUD, ...quiet(2)])
    assert.deepEqual(result, { seconds: 4.1, speakingSec: 0.1, pauseRatio: 0, phraseCount: 1, avgPhraseSec: 0.1, syllPerSec: null, tempo: 'unknown', phrasing: 'choppy' })
  })

  test('말에서 멀리 떨어진 딸깍 소리는 버리고, 쉼으로도 세지 않는다', () => {
    const result = rhythm([...quiet(1), ...speech(2), ...quiet(1), LOUD, ...quiet(1)])
    assert.deepEqual([result.speakingSec, result.pauseRatio, result.phraseCount, result.avgPhraseSec], [2, 0, 1, 2])
  })

  test('말끝에 바로 붙은 짧은 소리는 말의 일부로 본다', () => {
    const result = rhythm([...quiet(1), ...speech(2), ...fill(3, QUIET), LOUD, ...quiet(1)])
    assert.deepEqual([result.speakingSec, result.pauseRatio, result.phraseCount], [2.2, 0, 1])
  })
})

describe('analyzeRhythm — 소음이 깔린 녹음', () => {
  test('바닥 소음이 있어도 말소리 구간을 정확히 가른다', () => {
    const rng = seededRng(7)
    const noise = (sec) => jitter(frames(sec), 0.015, 0.025, rng)
    const voice = (sec) => jitter(frames(sec), 0.15, 0.3, rng)
    const levels = [...noise(1.5), ...voice(3), ...noise(0.8), ...voice(3), ...noise(1.5)]
    assert.deepEqual(rhythm(levels), { seconds: 9.8, speakingSec: 6, pauseRatio: 0.12, phraseCount: 2, avgPhraseSec: 3, syllPerSec: null, tempo: 'unknown', phrasing: 'even' })
  })

  test('소음만 있으면 말이 없는 것으로 본다', () => {
    const rng = seededRng(8)
    assert.deepEqual(rhythm(jitter(200, 0.015, 0.025, rng)), { ...EMPTY, seconds: 10 })
    assert.deepEqual(rhythm(jitter(200, 0.08, 0.1, rng)), { ...EMPTY, seconds: 10 })
  })

  test('기준은 바닥 소음의 2.5배', () => {
    const base = fill(100, 0.02)
    assert.equal(rhythm([...base, ...fill(40, 0.049), ...base]).speakingSec, 0)
    assert.equal(rhythm([...base, ...fill(40, 0.051), ...base]).speakingSec, 2)
  })

  test('아주 조용한 방에서는 최소 기준 0.012를 쓴다', () => {
    const base = fill(100, 0.001)
    assert.equal(rhythm([...base, ...fill(40, 0.011), ...base]).speakingSec, 0)
    assert.equal(rhythm([...base, ...fill(40, 0.012), ...base]).speakingSec, 0)
    assert.equal(rhythm([...base, ...fill(40, 0.013), ...base]).speakingSec, 2)
  })
})

describe('analyzeRhythm — 말 빠르기', () => {
  // 말한 시간이 정확히 100초라 음절 수 ÷ 100이 곧 빠르기다
  const hundredSeconds = [...quiet(15), ...speech(100), ...quiet(15)]
  const tempoAt = (syllPerSec) => rhythm(hundredSeconds, syllables(Math.round(syllPerSec * 100)))

  test('경계값은 연구 수치의 범위 안에 있다', () => {
    assert.ok(Object.isFrozen(TEMPO_THRESHOLDS))
    assert.ok(TEMPO_THRESHOLDS.slowBelow < TEMPO_THRESHOLDS.fastAbove)
    // 낭독 조음 속도 평균 5.99에서 ±1.5 안쪽
    assert.ok(TEMPO_THRESHOLDS.slowBelow >= 4.5 && TEMPO_THRESHOLDS.slowBelow < 5.99)
    assert.ok(TEMPO_THRESHOLDS.fastAbove > 5.99 && TEMPO_THRESHOLDS.fastAbove <= 7.5)
  })

  test('slowBelow 바로 아래는 slow, 딱 그 값은 normal', () => {
    const { slowBelow } = TEMPO_THRESHOLDS
    assert.deepEqual([tempoAt(slowBelow - 0.01).syllPerSec, tempoAt(slowBelow - 0.01).tempo], [Math.round((slowBelow - 0.01) * 100) / 100, 'slow'])
    assert.deepEqual([tempoAt(slowBelow).syllPerSec, tempoAt(slowBelow).tempo], [slowBelow, 'normal'])
  })

  test('fastAbove 바로 위는 fast, 딱 그 값은 normal', () => {
    const { fastAbove } = TEMPO_THRESHOLDS
    assert.deepEqual([tempoAt(fastAbove).syllPerSec, tempoAt(fastAbove).tempo], [fastAbove, 'normal'])
    assert.deepEqual([tempoAt(fastAbove + 0.01).syllPerSec, tempoAt(fastAbove + 0.01).tempo], [Math.round((fastAbove + 0.01) * 100) / 100, 'fast'])
  })

  test('두 경계 사이는 normal, 한참 벗어나면 slow·fast', () => {
    assert.equal(tempoAt((TEMPO_THRESHOLDS.slowBelow + TEMPO_THRESHOLDS.fastAbove) / 2).tempo, 'normal')
    assert.equal(tempoAt(3).tempo, 'slow')
    assert.equal(tempoAt(9).tempo, 'fast')
  })

  test('쉼을 뺀 말한 시간으로 나눈다', () => {
    // 20초 녹음 중 말한 시간은 10초
    const result = rhythm(talk({ lead: 2, tail: 2, phrases: [5, 5], pauses: [6] }), syllables(60))
    assert.equal(result.speakingSec, 10)
    assert.equal(result.syllPerSec, 6)
  })

  test('받아쓴 글이 10음절보다 적으면 재지 않는다', () => {
    const levels = [...quiet(2), ...speech(5), ...quiet(2)]
    assert.equal(rhythm(levels, syllables(9)).syllPerSec, null)
    assert.equal(rhythm(levels, syllables(9)).tempo, 'unknown')
    assert.equal(rhythm(levels, syllables(10)).syllPerSec, 2)
    assert.equal(rhythm(levels, syllables(10)).tempo, 'slow')
  })

  test('말한 시간이 3초보다 짧으면 재지 않는다', () => {
    const at = (speechFrames) => rhythm([...quiet(2), ...fill(speechFrames, LOUD), ...quiet(2)], syllables(18))
    assert.equal(at(59).speakingSec, 2.95)
    assert.equal(at(59).syllPerSec, null)
    assert.equal(at(59).tempo, 'unknown')
    assert.equal(at(60).speakingSec, 3)
    assert.equal(at(60).syllPerSec, 6)
  })

  test('음절은 한글과 숫자만 센다(웃음 자모·영문·기호 제외)', () => {
    const levels = [...quiet(2), ...speech(4), ...quiet(2)]
    // 한글 22음절 + 숫자 2자리 = 24음절
    const result = rhythm(levels, '아 근데 진짜ㅋㅋㅋ 오늘 3시에 OMG 완전 웃겼어!! ㅠㅠ\n7번이나 다시 봤잖아~')
    assert.equal(result.syllPerSec, 6)
  })

  test('글이 아닌 transcript는 없는 것으로 본다', () => {
    const levels = [...quiet(2), ...speech(5), ...quiet(2)]
    for (const transcript of [null, 12345678901, {}, ['가나다라마바사아자차카타'], true]) {
      const result = analyzeRhythm({ levels, transcript })
      assert.equal(result.syllPerSec, null)
      assert.equal(result.speakingSec, 5)
    }
  })
})

describe('analyzeRhythm — 프레임 길이와 반올림', () => {
  test('frameMs를 바꾸면 시간 기준도 같이 바뀐다', () => {
    const at100 = (gapFrames) => analyzeRhythm({ levels: [...fill(10, QUIET), ...fill(10, LOUD), ...fill(gapFrames, QUIET), ...fill(10, LOUD), ...fill(10, QUIET)], frameMs: 100 })
    assert.deepEqual([at100(2).seconds, at100(2).speakingSec, at100(2).phraseCount], [4.2, 2.2, 1])
    assert.deepEqual([at100(3).speakingSec, at100(3).phraseCount], [2, 1])
    assert.deepEqual([at100(4).speakingSec, at100(4).phraseCount], [2, 2])
  })

  test('쓸 수 없는 frameMs는 기본 50ms로 본다', () => {
    const levels = talk({ phrases: [2, 2], pauses: [1] })
    const expected = analyzeRhythm({ levels })
    assert.equal(expected.seconds, 7)
    for (const frameMs of [0, -50, 1, 5000, NaN, Infinity, '50', null, {}]) {
      assert.deepEqual(analyzeRhythm({ levels, frameMs }), expected)
    }
  })

  test('모든 수치는 소수 둘째 자리까지', () => {
    const rng = seededRng(33)
    const levels = [...jitter(31, 0.003, 0.006, rng), ...jitter(97, 0.1, 0.3, rng), ...jitter(13, 0.003, 0.006, rng), ...jitter(71, 0.1, 0.3, rng), ...jitter(29, 0.003, 0.006, rng)]
    const result = analyzeRhythm({ levels, frameMs: 33, transcript: syllables(37) })
    assertTwoDecimals(result)
    assert.deepEqual(result, { seconds: 7.95, speakingSec: 5.54, pauseRatio: 0.07, phraseCount: 2, avgPhraseSec: 2.77, syllPerSec: 6.67, tempo: 'normal', phrasing: 'even' })
  })
})

describe('analyzeRhythm — 엉뚱한 입력', () => {
  test('입력이 없거나 타임라인이 목록이 아니면 0으로 채운 결과', () => {
    assert.deepEqual(analyzeRhythm(), EMPTY)
    for (const input of [null, undefined, 42, 'levels', true, [], {}, { levels: null }, { levels: 'abc' }, { levels: 123 }, { levels: {} }, { levels: { length: 3 } }, { levels: [] }, { levels: new DataView(new ArrayBuffer(8)) }]) {
      assert.deepEqual(analyzeRhythm(input), EMPTY)
    }
  })

  test('숫자가 하나도 없는 목록도 0으로 채운 결과', () => {
    assert.deepEqual(analyzeRhythm({ levels: ['a', null, undefined, {}, NaN, Infinity, '0.5', 10n], transcript: syllables(50) }), EMPTY)
  })

  test('숫자가 아닌 프레임은 조용한 프레임으로, 범위를 벗어난 값은 0..1로 본다', () => {
    const levels = [...quiet(1), ...speech(2), NaN, 'x', null, ...speech(2), ...fill(10, -3), ...fill(40, 7), ...quiet(1)]
    const result = rhythm(levels)
    // 숫자가 아닌 3프레임(150ms)은 메워지고, 음수 10프레임(500ms)은 쉼, 7은 1로 잘려 말소리
    assert.deepEqual([result.seconds, result.speakingSec, result.phraseCount, result.pauseRatio], [8.65, 6.15, 2, 0.08])
  })

  test('타임라인이 너무 길면 앞 20분만 본다', () => {
    const result = rhythm(fill(30_000, 0))
    assert.equal(result.seconds, 1200)
  })

  test('입력을 바꾸지 않고, 같은 입력에는 같은 결과를 낸다', () => {
    const levels = talk({ phrases: [1.5, 2.5, 0.5], pauses: [0.7, 0.3] })
    const copy = [...levels]
    const first = rhythm(levels, syllables(30))
    assert.deepEqual(levels, copy)
    assert.deepEqual(rhythm(levels, syllables(30)), first)
  })
})

describe('emptyRhythm', () => {
  test('기본은 전부 0·unknown', () => {
    assert.deepEqual(emptyRhythm(), EMPTY)
  })

  test('녹음 길이만 채울 수 있다', () => {
    assert.deepEqual(emptyRhythm(42.126), { ...EMPTY, seconds: 42.13 })
  })

  test('쓸 수 없는 길이는 0', () => {
    for (const seconds of [-1, NaN, Infinity, '30', null, {}]) assert.deepEqual(emptyRhythm(seconds), EMPTY)
  })

  test('부를 때마다 새 객체', () => {
    assert.notEqual(emptyRhythm(), emptyRhythm())
  })
})

describe('frameLevel', () => {
  test('표본의 RMS', () => {
    assert.equal(frameLevel(new Float32Array([0.5, -0.5, 0.5, -0.5])), 0.5)
    assert.equal(frameLevel(new Float32Array(2048)), 0)
    assert.equal(frameLevel([0.25, -0.25]), 0.25)
    const sine = Float32Array.from({ length: 2000 }, (_, i) => 0.4 * Math.sin((2 * Math.PI * i) / 100))
    assert.ok(Math.abs(frameLevel(sine) - 0.4 / Math.SQRT2) < 1e-6)
  })

  test('부호와 상관없이 세기만 본다', () => {
    assert.equal(frameLevel(new Float32Array([-0.5, -0.5])), frameLevel(new Float32Array([0.5, 0.5])))
  })

  test('1을 넘지 않는다', () => {
    assert.equal(frameLevel(new Float32Array([3, -3])), 1)
    assert.equal(frameLevel([1.5, 1.5]), 1)
  })

  test('엉뚱한 입력은 0', () => {
    for (const samples of [null, undefined, 'abc', 42, {}, [], new Float32Array(0), [NaN, 0.5], ['a', 'b'], [1n, 2n], new BigInt64Array(4), new DataView(new ArrayBuffer(8))]) {
      assert.equal(frameLevel(samples), 0)
    }
  })
})

describe('analysisWindowSize', () => {
  test('한 프레임(50ms)을 넘지 않는 가장 큰 2의 거듭제곱', () => {
    assert.equal(analysisWindowSize(48000), 2048)
    assert.equal(analysisWindowSize(44100), 2048)
    assert.equal(analysisWindowSize(96000), 4096)
    assert.equal(analysisWindowSize(16000), 512)
    assert.equal(analysisWindowSize(8000), 256)
    assert.equal(analysisWindowSize(40960), 2048)
    assert.equal(analysisWindowSize(48000, 100), 4096)
  })

  test('AnalyserNode가 받는 범위(32..32768)를 벗어나지 않는다', () => {
    assert.equal(analysisWindowSize(100), 32)
    assert.equal(analysisWindowSize(1e9), 32768)
  })

  test('엉뚱한 입력은 기본 창 크기', () => {
    for (const rate of [null, undefined, NaN, Infinity, 0, -48000, '48000', {}, 48000n]) assert.equal(analysisWindowSize(rate), 2048)
    assert.equal(analysisWindowSize(48000, null), 2048)
    assert.equal(analysisWindowSize(48000, 0), 2048)
  })
})

describe('readRecognitionResults', () => {
  /** SpeechRecognitionResult 흉내: 후보 목록 + isFinal */
  const result = (transcript, isFinal) => Object.assign([{ transcript, confidence: 0.9 }], { isFinal })

  test('확정된 발화와 아직 바뀔 수 있는 글을 나눈다', () => {
    const list = [result(' 어제 친구랑 떡볶이 먹었거든 ', true), result(' 근데 진짜  맛있더라', true), result(' 그래서 오늘도', false), result(' 갈까', false)]
    assert.deepEqual(readRecognitionResults(list), { finals: ['어제 친구랑 떡볶이 먹었거든', '근데 진짜 맛있더라'], interim: '그래서 오늘도 갈까' })
  })

  test('같은 목록을 다시 읽어도 발화가 늘지 않는다', () => {
    const list = [result('아 진짜', true), result('대박', false)]
    assert.deepEqual(readRecognitionResults(list), readRecognitionResults(list))
    assert.equal(readRecognitionResults(list).finals.length, 1)
  })

  test('똑같은 말을 두 번 했으면 두 번 다 남긴다', () => {
    assert.deepEqual(readRecognitionResults([result('네', true), result('네', true)]).finals, ['네', '네'])
  })

  test('빈 결과와 공백뿐인 결과는 버린다', () => {
    const list = [result('', true), result('   ', true), result('\n', false), Object.assign([], { isFinal: true }), result('좋아', true)]
    assert.deepEqual(readRecognitionResults(list), { finals: ['좋아'], interim: '' })
  })

  test('줄바꿈은 한 칸 띄어쓰기로 바꿔 한 줄로 만든다', () => {
    assert.deepEqual(readRecognitionResults([result('오늘은\n일찍  잘래\t진짜', true)]).finals, ['오늘은 일찍 잘래 진짜'])
  })

  test('isFinal이 true가 아닌 결과는 확정으로 치지 않는다', () => {
    assert.deepEqual(readRecognitionResults([result('아직', undefined), result('몰라', 'yes')]), { finals: [], interim: '아직 몰라' })
  })

  test('유사 배열(ArrayLike)도 읽는다', () => {
    const list = { length: 2, 0: result('하나', true), 1: result('둘', false) }
    assert.deepEqual(readRecognitionResults(list), { finals: ['하나'], interim: '둘' })
  })

  test('지나치게 긴 발화는 2000자에서 자르되 글자를 쪼개지 않는다', () => {
    const [text] = readRecognitionResults([result('가'.repeat(1999) + '😀😀', true)]).finals
    assert.equal(Array.from(text).length, 2000)
    assert.ok(text.endsWith('😀'))
    assert.ok(text.isWellFormed())
  })

  test('결과가 너무 많으면 앞 500개만 읽는다', () => {
    const list = Array.from({ length: 800 }, (_, i) => result(`말 ${i}`, true))
    assert.equal(readRecognitionResults(list).finals.length, 500)
  })

  test('엉뚱한 입력은 빈 결과', () => {
    for (const results of [null, undefined, 42, 'abc', {}, { length: -1 }, { length: 2.5 }, [null, undefined, 7, 'x', {}, [], [null], [{}], [{ transcript: 5 }]]]) {
      assert.deepEqual(readRecognitionResults(results), { finals: [], interim: '' })
    }
  })
})
