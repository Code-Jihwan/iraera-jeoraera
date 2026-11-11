// 말 리듬 분석 — 녹음하면서 모은 음량(RMS) 타임라인과 받아쓴 글만으로 빠르기와 쉼을 잰다.
// 원본 음성은 다루지 않는다. 브라우저(녹음 직후)와 Node(테스트)에서 같은 코드가 돈다.
import { countSyllables } from './hangul.js'

/** 음량을 재는 간격(ms). 녹음 쪽(voice.js)도 이 간격으로 표본을 모은다. */
export const FRAME_MS = 50

/**
 * 말 빠르기 경계 — 쉼을 뺀 조음 속도(음절/초).
 * 근거: 한국어 문단 낭독 412명의 조음 속도 평균 5.99(표준편차 0.96)
 *   — Lee, Shin, Yoo & Kim (2017), Phonetics and Speech Sciences 9(1), 27–39.
 * 서울말 자유 발화의 화자별 평균은 5.2–8.2 — Kim (2018), 같은 학술지 10(4), 19–29.
 * 공표된 규준이 아니라 위 수치로 잡은 어림 구간(5.5 / 7.0)이고, 받아쓰기가 추임새나
 * 끊긴 말을 빠뜨려 실제보다 느리게 나오는 만큼 0.3씩 낮췄다. 실제 녹음으로 보정해야 하는 값이다.
 */
export const TEMPO_THRESHOLDS = Object.freeze({ slowBelow: 5.2, fastAbove: 6.7 })

/** 덩어리 평균 길이(초)로 가르는 말 호흡 */
const PHRASING_THRESHOLDS = Object.freeze({ choppyBelow: 1.2, flowingAbove: 3.5 })

/** 음성 구간을 가려내는 기준 */
const VAD = Object.freeze({
  noisePercentile: 0.2, // 조용한 쪽 20% 지점을 바닥 소음으로 본다
  noiseFactor: 2.5,
  minThreshold: 0.012, // 아주 조용한 방에서도 숨소리를 말로 잡지 않게
  gapFillMs: 250, // 이보다 짧은 끊김은 말이 이어진 것으로 본다
  minBurstMs: 100, // 이보다 짧은 소리는 잡음으로 본다
  phrasePauseMs: 400, // 이만큼 쉬면 덩어리가 나뉜다
})

/** 빠르기를 재는 데 필요한 최소 분량 — 이보다 적으면 값이 크게 흔들린다 */
const TEMPO_MIN = Object.freeze({ syllables: 10, speakingSec: 3 })

const MAX_FRAMES = 24_000 // 50ms 간격으로 20분
const MAX_TRANSCRIPT_CHARS = 20_000
const MAX_RESULTS = 500
const MAX_UTTERANCE_CHARS = 2000
const FRAME_MS_RANGE = Object.freeze({ min: 5, max: 1000 })
// AnalyserNode.fftSize가 받는 범위와 기본값
const WINDOW_SIZE = Object.freeze({ min: 32, max: 32768, fallback: 2048 })

const round2 = (n) => Math.round(n * 100) / 100
const sizeOf = (seg) => seg.end - seg.start
const total = (segments) => segments.reduce((n, seg) => n + sizeOf(seg), 0)

/** 아래 경계보다 작으면 첫째, 위 경계보다 크면 셋째, 그 사이면 둘째 이름 */
const band = (value, low, high, [below, between, above]) => (value < low ? below : value > high ? above : between)

const isList = (v) => Array.isArray(v) || (ArrayBuffer.isView(v) && typeof v.length === 'number')

/**
 * 말소리가 없을 때의 리듬. 음량을 잴 수 없는 환경(모바일 받아쓰기 전용)에서는 녹음 길이만 채워서 쓴다.
 * @param {number} [seconds]
 * @returns {import('./types.js').VoiceRhythm}
 */
export function emptyRhythm(seconds = 0) {
  const sec = typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? round2(seconds) : 0
  return { seconds: sec, speakingSec: 0, pauseRatio: 0, phraseCount: 0, avgPhraseSec: 0, syllPerSec: null, tempo: 'unknown', phrasing: 'unknown' }
}

/**
 * 한 프레임의 음량(RMS, 0..1).
 * @param {ArrayLike<number>} samples AnalyserNode의 시간 영역 표본(-1..1)
 */
export function frameLevel(samples) {
  if (!isList(samples) || samples.length === 0) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) {
    // 숫자가 아닌 표본이 섞이면 합이 NaN이 되어 아래에서 0으로 떨어진다
    const v = typeof samples[i] === 'number' ? samples[i] : NaN
    sum += v * v
  }
  const rms = Math.sqrt(sum / samples.length)
  return Number.isFinite(rms) ? Math.min(1, rms) : 0
}

/**
 * 한 프레임 길이를 넘지 않는 가장 큰 2의 거듭제곱 — 음량을 재는 창이 이웃 프레임과 겹치지 않게 한다.
 * @param {number} sampleRate 오디오 표본화 주파수(Hz)
 * @param {number} [frameMs]
 */
export function analysisWindowSize(sampleRate, frameMs = FRAME_MS) {
  const samples = typeof sampleRate === 'number' && typeof frameMs === 'number' ? (sampleRate * frameMs) / 1000 : NaN
  if (!Number.isFinite(samples) || samples <= 0) return WINDOW_SIZE.fallback
  return Math.min(WINDOW_SIZE.max, Math.max(WINDOW_SIZE.min, 2 ** Math.floor(Math.log2(samples))))
}

/** 한 줄로 다듬은 받아쓰기 글. 글이 아니면 빈 문자열. */
function tidyTranscript(text) {
  if (typeof text !== 'string') return ''
  const line = text.replace(/\s+/g, ' ').trim()
  // 코드 포인트 단위로 잘라 이모지 같은 글자가 반으로 쪼개지지 않게 한다
  return line.length > MAX_UTTERANCE_CHARS ? Array.from(line).slice(0, MAX_UTTERANCE_CHARS).join('') : line
}

/**
 * 음성 인식 결과 목록을 확정된 발화와 아직 바뀔 수 있는 글로 나눈다.
 * 이벤트마다 목록 전체를 다시 읽으므로, 같은 결과가 다시 통지되어도 발화가 겹쳐 쌓이지 않는다.
 * @param {ArrayLike<ArrayLike<{transcript:string}> & {isFinal:boolean}>} results SpeechRecognitionResultList
 * @returns {{ finals: string[], interim: string }}
 */
export function readRecognitionResults(results) {
  const finals = []
  const pending = []
  const count = Number.isInteger(results?.length) ? Math.min(results.length, MAX_RESULTS) : 0
  for (let i = 0; i < count; i++) {
    const text = tidyTranscript(results[i]?.[0]?.transcript)
    if (!text) continue
    if (results[i].isFinal === true) finals.push(text)
    else pending.push(text)
  }
  return { finals, interim: pending.join(' ') }
}

/** 숫자가 아닌 값은 조용한 프레임으로 본다. 쓸 수 있는 값이 하나도 없으면 빈 목록. */
function cleanLevels(levels) {
  if (!isList(levels)) return []
  const out = new Array(Math.min(levels.length, MAX_FRAMES))
  let valid = 0
  for (let i = 0; i < out.length; i++) {
    const v = levels[i]
    const ok = typeof v === 'number' && Number.isFinite(v)
    if (ok) valid++
    out[i] = ok ? Math.min(1, Math.max(0, v)) : 0
  }
  return valid ? out : []
}

function speechThreshold(levels) {
  const sorted = Float64Array.from(levels).sort()
  const noise = sorted[Math.floor((sorted.length - 1) * VAD.noisePercentile)]
  return Math.max(noise * VAD.noiseFactor, VAD.minThreshold)
}

/** 참인 프레임이 이어진 구간을 { start, end } (end는 포함하지 않음) 목록으로 */
function toSegments(mask) {
  const segments = []
  let start = -1
  for (let i = 0; i <= mask.length; i++) {
    const on = i < mask.length && mask[i]
    if (on && start < 0) start = i
    if (!on && start >= 0) {
      segments.push({ start, end: i })
      start = -1
    }
  }
  return segments
}

/** 사이가 gapFrames보다 짧은 이웃 구간을 하나로 잇는다 */
function joinAcrossGaps(segments, gapFrames) {
  const joined = []
  for (const seg of segments) {
    const last = joined[joined.length - 1]
    if (last && seg.start - last.end < gapFrames) last.end = seg.end
    else joined.push({ ...seg })
  }
  return joined
}

/** 말소리 구간: 짧은 끊김은 메우고(행오버), 그러고도 너무 짧은 소리는 버린다 */
function speechSegments(levels, frameMs) {
  const threshold = speechThreshold(levels)
  const raw = toSegments(levels.map((v) => v > threshold))
  return joinAcrossGaps(raw, VAD.gapFillMs / frameMs).filter((seg) => sizeOf(seg) >= VAD.minBurstMs / frameMs)
}

function syllableRate(transcript, speakingSec) {
  const text = typeof transcript === 'string' ? transcript.slice(0, MAX_TRANSCRIPT_CHARS) : ''
  const syllables = countSyllables(text)
  if (syllables < TEMPO_MIN.syllables || speakingSec < TEMPO_MIN.speakingSec) return null
  return round2(syllables / speakingSec)
}

/**
 * 음량 타임라인에서 말 리듬을 뽑는다.
 * @param {{ levels: ArrayLike<number>, frameMs?: number, transcript?: string }} input
 *   levels: 프레임별 RMS(0..1), transcript: 같은 녹음을 받아쓴 글(빠르기 계산용)
 * @returns {import('./types.js').VoiceRhythm}
 */
export function analyzeRhythm(input) {
  const { levels, frameMs: rawFrameMs, transcript = '' } = input ?? {}
  const frames = cleanLevels(levels)
  if (!frames.length) return emptyRhythm()
  const validFrameMs = typeof rawFrameMs === 'number' && rawFrameMs >= FRAME_MS_RANGE.min && rawFrameMs <= FRAME_MS_RANGE.max
  const frameMs = validFrameMs ? rawFrameMs : FRAME_MS
  const toSec = (frameCount) => (frameCount * frameMs) / 1000

  const seconds = toSec(frames.length)
  const segments = speechSegments(frames, frameMs)
  if (!segments.length) return emptyRhythm(seconds)

  // 400ms 이상 쉬지 않고 이어 말한 부분이 한 덩어리 (그 안의 짧은 쉼은 덩어리 길이에 들어간다)
  const phrases = joinAcrossGaps(segments, VAD.phrasePauseMs / frameMs)
  const speaking = total(segments)
  const span = segments[segments.length - 1].end - segments[0].start
  const avgPhraseSec = round2(toSec(total(phrases)) / phrases.length)
  const syllPerSec = syllableRate(transcript, toSec(speaking))

  return {
    seconds: round2(seconds),
    speakingSec: round2(toSec(speaking)),
    pauseRatio: round2((span - speaking) / span),
    phraseCount: phrases.length,
    avgPhraseSec,
    syllPerSec,
    tempo: syllPerSec === null ? 'unknown' : band(syllPerSec, TEMPO_THRESHOLDS.slowBelow, TEMPO_THRESHOLDS.fastAbove, ['slow', 'normal', 'fast']),
    phrasing: band(avgPhraseSec, PHRASING_THRESHOLDS.choppyBelow, PHRASING_THRESHOLDS.flowingAbove, ['choppy', 'even', 'flowing']),
  }
}
