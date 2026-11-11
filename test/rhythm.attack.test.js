// 모듈 F 공격 테스트 — 명세(SPEC.md 모듈 F)의 요구를 그대로 옮긴 것이다. 구현의 현재 동작이 아니라 명세가 기준이다.
// voice.js는 브라우저 전용이라 가짜 window/navigator/document/AudioContext/SpeechRecognition을 깔고 Node에서 돌린다.
import { describe, test, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { analyzeRhythm, TEMPO_THRESHOLDS } from '../shared/rhythm.js'

// 브라우저에서 '/shared/…'로 불러오는 경로를 프로젝트 폴더로 돌린다
const ROOT = new URL('../', import.meta.url)
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('/shared/') || specifier.startsWith('/js/')) {
      const local = specifier.startsWith('/js/') ? './public' + specifier : '.' + specifier
      return next(new URL(local, ROOT).href, context)
    }
    return next(specifier, context)
  },
})
const { VoiceSession, voiceSupport } = await import('../public/js/voice.js')

// ── rhythm.js ─────────────────────────────────────────────

const fill = (n, v) => new Array(n).fill(v)
const Q = 0.003
const L = 0.2
const EMPTY = { seconds: 0, speakingSec: 0, pauseRatio: 0, phraseCount: 0, avgPhraseSec: 0, syllPerSec: null, tempo: 'unknown', phrasing: 'unknown' }

describe('공격: analyzeRhythm 명세 경계', () => {
  test('frameMs=20: 240ms 끊김은 메우고 260ms 끊김은 쉼', () => {
    const at = (gap) => analyzeRhythm({ levels: [...fill(50, Q), ...fill(50, L), ...fill(gap, Q), ...fill(50, L), ...fill(50, Q)], frameMs: 20 })
    assert.equal(at(12).speakingSec, 2.24)
    assert.equal(at(12).pauseRatio, 0)
    assert.equal(at(13).speakingSec, 2)
    assert.ok(at(13).pauseRatio > 0)
  })

  test('frameMs=30: 390ms 쉼은 한 덩어리, 420ms 쉼은 두 덩어리', () => {
    const at = (gap) => analyzeRhythm({ levels: [...fill(40, Q), ...fill(60, L), ...fill(gap, Q), ...fill(60, L), ...fill(40, Q)], frameMs: 30 })
    assert.equal(at(13).phraseCount, 1)
    assert.equal(at(14).phraseCount, 2)
  })

  test('frameMs=30: 90ms 소리는 버리고 120ms 소리는 남긴다', () => {
    const at = (n) => analyzeRhythm({ levels: [...fill(60, Q), ...fill(n, L), ...fill(60, Q)], frameMs: 30 })
    assert.equal(at(3).speakingSec, 0)
    assert.equal(at(4).speakingSec, 0.12)
  })

  test('syllPerSec = countSyllables / speakingSec, 경계(10음절, 3초) 포함', () => {
    const levels = [...fill(20, Q), ...fill(60, L), ...fill(20, Q)]
    const r = analyzeRhythm({ levels, transcript: '가나다라마 바사아자차' })
    assert.equal(r.speakingSec, 3)
    assert.equal(r.syllPerSec, 3.33)
    assert.equal(r.tempo, 'slow')
  })

  test('쉼 비율은 0..1, 모든 수치는 유한한 수', () => {
    const levels = []
    for (let i = 0; i < 300; i++) levels.push(i % 17 < 6 ? L : Q)
    const r = analyzeRhythm({ levels, transcript: '가'.repeat(200) })
    assert.ok(r.pauseRatio >= 0 && r.pauseRatio <= 1)
    for (const k of ['seconds', 'speakingSec', 'pauseRatio', 'phraseCount', 'avgPhraseSec']) assert.ok(Number.isFinite(r[k]), k)
  })

  test('구멍 난 배열·아주 큰 배열도 죽지 않는다', () => {
    assert.deepEqual(analyzeRhythm({ levels: new Array(100) }), EMPTY)
    const huge = new Float32Array(2_000_000)
    const t0 = Date.now()
    const r = analyzeRhythm({ levels: huge, transcript: '가'.repeat(1_000_000) })
    assert.ok(Date.now() - t0 < 3000)
    assert.equal(r.tempo, 'unknown')
  })

  test('TEMPO_THRESHOLDS는 숫자이고 slowBelow < fastAbove', () => {
    assert.equal(typeof TEMPO_THRESHOLDS.slowBelow, 'number')
    assert.equal(typeof TEMPO_THRESHOLDS.fastAbove, 'number')
    assert.ok(TEMPO_THRESHOLDS.slowBelow < TEMPO_THRESHOLDS.fastAbove)
  })
})

// ── voice.js 가짜 브라우저 ─────────────────────────────────────

const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; SM-S918N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36'
const IPAD_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'

const res = (transcript, isFinal) => Object.assign([{ transcript, confidence: 0.9 }], { isFinal })
const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r))
}
async function advance(ms, step = 10) {
  for (let t = 0; t < ms; t += step) {
    mock.timers.tick(step)
    await flush()
  }
}

const saved = {}
function setGlobal(name, value) {
  if (!(name in saved)) saved[name] = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true, enumerable: true })
}
function restoreGlobals() {
  for (const [name, desc] of Object.entries(saved)) {
    if (desc) Object.defineProperty(globalThis, name, desc)
    else delete globalThis[name]
    delete saved[name]
  }
}

function makeEnv(opts = {}) {
  const env = { recs: [], contexts: [], tracks: [], gumCalls: [], amp: Q, mediaRecorderCalls: 0, installCalls: 0, availableCalls: [], analyserBuffers: [] }

  class Track {
    constructor() {
      this.kind = 'audio'
      this.readyState = 'live'
      this.enabled = true
      this.muted = false
      this.stopped = false
      this.listeners = {}
    }
    stop() {
      this.stopped = true
      this.readyState = 'ended'
    }
    addEventListener(t, f) {
      ;(this.listeners[t] ??= new Set()).add(f)
    }
    removeEventListener(t, f) {
      this.listeners[t]?.delete(f)
    }
    dispatch(t) {
      for (const f of [...(this.listeners[t] ?? [])]) f({ type: t })
    }
  }
  env.makeStream = () => {
    const t = new Track()
    env.tracks.push(t)
    return { getTracks: () => [t], getAudioTracks: () => [t] }
  }

  class FakeAudioContext {
    constructor() {
      env.contexts.push(this)
      this.state = 'running'
      this.sampleRate = 48000
      this.closed = false
    }
    createMediaStreamSource() {
      return { connected: false, disconnected: false, connect() { this.connected = true }, disconnect() { this.disconnected = true } }
    }
    createAnalyser() {
      return {
        fftSize: 2048,
        disconnected: false,
        disconnect() { this.disconnected = true },
        getFloatTimeDomainData(buf) {
          if (!env.analyserBuffers.includes(buf)) env.analyserBuffers.push(buf)
          for (let i = 0; i < buf.length; i++) buf[i] = i % 2 ? env.amp : -env.amp
        },
      }
    }
    resume() { return Promise.resolve() }
    close() {
      this.closed = true
      this.state = 'closed'
      return Promise.resolve()
    }
  }

  class FakeSR {
    constructor() {
      env.recs.push(this)
      this.started = false
      this.startArgs = null
      this.aborted = false
      this.stopped = false
      this.processLocally = false
      this.onstart = this.onresult = this.onerror = this.onend = null
    }
    start(...args) {
      if (opts.trackThrows && args.length > 0) throw new TypeError('start(track) not supported')
      this.started = true
      this.startArgs = args
      if (opts.autoStart !== false) queueMicrotask(() => this.onstart?.({ type: 'start' }))
    }
    stop() {
      this.stopped = true
      queueMicrotask(() => this.onend?.({ type: 'end' }))
    }
    abort() {
      this.aborted = true
    }
  }
  if (opts.available !== undefined) {
    FakeSR.available = (o) => {
      env.availableCalls.push(o)
      return typeof opts.available === 'function' ? opts.available(o) : Promise.resolve(opts.available)
    }
    FakeSR.install = () => {
      env.installCalls++
      return Promise.resolve(true)
    }
  }
  env.SR = FakeSR

  const win = {
    isSecureContext: opts.secure ?? true,
    matchMedia: () => ({ matches: Boolean(opts.coarse) }),
    MediaRecorder: function MediaRecorder() {
      env.mediaRecorderCalls++
    },
  }
  if (!opts.noAudio) win.AudioContext = FakeAudioContext
  if (opts.sr !== false) win[opts.prefixed ? 'webkitSpeechRecognition' : 'SpeechRecognition'] = FakeSR

  const gum = opts.gum ?? (async () => env.makeStream())
  const nav = {
    userAgent: opts.ua ?? DESKTOP_UA,
    maxTouchPoints: opts.maxTouchPoints ?? 0,
    userAgentData: opts.uaData,
    mediaDevices: opts.noGum
      ? {}
      : {
          getUserMedia: (c) => {
            env.gumCalls.push(c)
            return gum(c)
          },
        },
  }
  const doc = {
    hidden: false,
    listeners: {},
    addEventListener(t, f) {
      ;(this.listeners[t] ??= new Set()).add(f)
    },
    removeEventListener(t, f) {
      this.listeners[t]?.delete(f)
    },
    dispatch(t) {
      for (const f of [...(this.listeners[t] ?? [])]) f({ type: t })
    },
  }
  setGlobal('window', win)
  setGlobal('navigator', nav)
  setGlobal('document', doc)
  env.window = win
  env.navigator = nav
  env.document = doc
  return env
}

/** 콜백 기록을 붙인 세션 */
function recorder(options = {}) {
  const log = { level: [], interim: [], final: [], tick: [], state: [], error: [] }
  const session = new VoiceSession({
    onLevel: (v) => log.level.push(v),
    onInterim: (v) => log.interim.push(v),
    onFinal: (v) => log.final.push(v),
    onTick: (v) => log.tick.push(v),
    onState: (v) => log.state.push(v),
    onError: (e) => log.error.push(e),
    ...options,
  })
  return { session, log }
}

async function started(session) {
  const p = session.start()
  await flush()
  await advance(100)
  await p
}

async function stopped(session) {
  const p = session.stop()
  await advance(2000)
  return p
}

let consoleCalls
beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 })
  setGlobal('performance', { now: () => Date.now() })
  consoleCalls = []
  for (const m of ['log', 'info', 'warn', 'error', 'debug']) mock.method(console, m, (...a) => consoleCalls.push(a))
})
afterEach(() => {
  mock.timers.reset()
  mock.restoreAll()
  restoreGlobals()
})

describe('공격: voiceSupport', () => {
  test('보안 연결·기능 유무를 그대로 알린다', () => {
    makeEnv()
    assert.deepEqual(voiceSupport(), { mic: true, stt: true, secure: true })
    makeEnv({ sr: false })
    assert.deepEqual(voiceSupport(), { mic: true, stt: false, secure: true })
    makeEnv({ secure: false })
    assert.equal(voiceSupport().secure, false)
    assert.equal(voiceSupport().mic, false)
  })
  test('접두사 webkitSpeechRecognition도 받아쓰기로 친다', () => {
    makeEnv({ prefixed: true })
    assert.equal(voiceSupport().stt, true)
  })
})

describe('공격: start() 거절 사유', () => {
  test('보안 연결이 아니면 insecure', async () => {
    makeEnv({ secure: false })
    const { session } = recorder()
    await assert.rejects(session.start(), (e) => e instanceof Error && e.code === 'insecure')
  })
  test('마이크·받아쓰기 둘 다 없으면 unsupported', async () => {
    makeEnv({ noGum: true, sr: false })
    const { session } = recorder()
    await assert.rejects(session.start(), (e) => e.code === 'unsupported')
  })
  for (const [name, code] of [['NotAllowedError', 'not-allowed'], ['NotFoundError', 'no-mic'], ['NotReadableError', 'failed']]) {
    test(`getUserMedia ${name} → ${code}, 오디오 그래프와 인식기를 남기지 않는다`, async () => {
      const env = makeEnv({ gum: async () => { throw Object.assign(new Error('x'), { name }) } })
      const { session } = recorder()
      const p = session.start()
      p.catch(() => {})
      await flush()
      await assert.rejects(p, (e) => e.code === code)
      assert.ok(env.contexts.every((c) => c.closed), 'AudioContext를 닫아야 한다')
      assert.ok(env.recs.every((r) => !r.started || r.aborted || r.stopped), '인식기를 멈춰야 한다')
      assert.equal(session.state, 'idle')
    })
  }
})

describe('공격: 데스크톱 녹음', () => {
  test('getUserMedia 제약 조건과 인식기 설정', async () => {
    const env = makeEnv()
    const { session } = recorder()
    await started(session)
    assert.deepEqual(env.gumCalls, [{ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }])
    assert.equal(session.state, 'recording')
    const rec = env.recs[0]
    assert.ok(rec.started)
    assert.equal(rec.lang, 'ko-KR')
    assert.equal(rec.interimResults, true)
    assert.equal(rec.continuous, true)
    assert.ok(!('quality' in rec), 'quality를 넘기면 안 된다')
    await stopped(session)
  })

  test('기기 안 인식 확인은 정확히 ko-KR + processLocally:true, quality 없음, install() 금지', async () => {
    const env = makeEnv({ available: 'downloadable' })
    const { session } = recorder()
    await started(session)
    assert.deepEqual(env.availableCalls, [{ langs: ['ko-KR'], processLocally: true }])
    assert.equal(env.installCalls, 0)
    assert.notEqual(env.recs[0].processLocally, true)
    const result = await stopped(session)
    assert.equal(result.stt.onDevice, false)
  })

  test("'available'이면 processLocally=true이고 stt.onDevice=true", async () => {
    const env = makeEnv({ available: 'available' })
    const { session } = recorder()
    await started(session)
    assert.equal(env.recs[0].processLocally, true)
    const result = await stopped(session)
    assert.equal(result.stt.onDevice, true)
    assert.equal(env.installCalls, 0)
  })

  test('start(track)을 받는 엔진에는 마이크 트랙을 넘기고, 아니면 인자 없이 start()', async () => {
    let env = makeEnv({ available: 'unavailable' })
    let { session } = recorder()
    await started(session)
    assert.equal(env.recs[0].startArgs[0], env.tracks[0])
    await stopped(session)

    env = makeEnv()
    ;({ session } = recorder())
    await started(session)
    assert.equal(env.recs[0].startArgs.length, 0)
    await stopped(session)
  })

  test('start(track)이 예외를 던지면 기본 start()로 받아쓰기를 이어 간다', async () => {
    const env = makeEnv({ available: 'unavailable', trackThrows: true })
    const { session, log } = recorder()
    await started(session)
    await advance(1000)
    const plain = env.recs.find((r) => r.started && r.startArgs.length === 0)
    plain?.onresult?.({ results: [res('안녕하세요', true)] })
    const result = await stopped(session)
    assert.deepEqual(
      { error: result.stt.error, onError: log.error.map((e) => e.code), recs: env.recs.length, utterances: result.utterances },
      { error: null, onError: [], recs: 2, utterances: ['안녕하세요'] },
    )
    assert.ok(plain, '트랙 없이 다시 시작한 인식기가 있어야 한다')
  })

  test('음량 타임라인이 리듬으로 이어진다: 1초 조용 + 3초 말 + 1초 조용', async () => {
    const env = makeEnv({ sr: false })
    const { session, log } = recorder()
    await started(session)
    await advance(1000)
    env.amp = L
    await advance(3000)
    env.amp = Q
    await advance(1000)
    const result = await stopped(session)
    assert.ok(Math.abs(result.rhythm.speakingSec - 3) <= 0.15, `speakingSec ${result.rhythm.speakingSec}`)
    assert.equal(result.rhythm.phraseCount, 1)
    assert.ok(Math.abs(result.seconds - 5.1) <= 0.2, `seconds ${result.seconds}`)
    assert.ok(log.level.some((v) => Math.abs(v - L) < 1e-6))
    assert.equal(result.stt.supported, false)
    assert.equal(result.stt.used, false)
  })

  test('받아쓰기가 녹음 전체를 덮으면 말 빠르기(음절/말한 시간)를 잰다', async () => {
    const env = makeEnv()
    const { session } = recorder()
    await started(session)
    await advance(1000)
    env.amp = L
    await advance(4000)
    env.amp = Q
    await advance(1000)
    env.recs[0].onresult({ results: [res('어제 친구랑 떡볶이 먹으러 갔는데 진짜 맛있어서 또 가고 싶더라', true)] })
    const result = await stopped(session)
    assert.ok(Math.abs(result.rhythm.speakingSec - 4) <= 0.15, `speakingSec ${result.rhythm.speakingSec}`)
    assert.ok(result.rhythm.syllPerSec !== null && Math.abs(result.rhythm.syllPerSec - 26 / 4) < 0.3, `syllPerSec ${result.rhythm.syllPerSec}`)
    assert.equal(result.rhythm.tempo, 'normal')
  })

  test('결과 모양과 원본 음성 미보관: 숫자 리듬만, 분석 버퍼는 지워지고 MediaRecorder는 안 쓴다', async () => {
    const env = makeEnv()
    const { session } = recorder()
    await started(session)
    env.amp = L
    await advance(1000)
    env.recs[0].onresult({ results: [res('  오늘 진짜 웃겼어  ', true), res('  ', true)] })
    const result = await stopped(session)
    assert.deepEqual(Object.keys(result).sort(), ['rhythm', 'seconds', 'stt', 'transcript', 'utterances'])
    assert.deepEqual(Object.keys(result.stt).sort(), ['error', 'onDevice', 'supported', 'used'])
    assert.deepEqual(result.utterances, ['오늘 진짜 웃겼어'])
    assert.equal(env.mediaRecorderCalls, 0)
    const walk = (v) => {
      if (ArrayBuffer.isView(v)) assert.fail('결과에 오디오 버퍼가 있다')
      if (Array.isArray(v) && v.length && v.every((x) => typeof x === 'number')) assert.fail('결과에 음량 배열이 있다')
      if (v && typeof v === 'object') Object.values(v).forEach(walk)
    }
    walk(result)
    for (const buf of env.analyserBuffers) assert.ok(buf.every((x) => x === 0), '분석 버퍼를 비워야 한다')
    assert.ok(env.tracks.every((t) => t.stopped))
    assert.ok(env.contexts.every((c) => c.closed))
  })

  test('발화는 다듬고 빈 것은 빼며, 똑같은 말이 반복돼도 모두 남기고 줄바꿈으로 잇는다', async () => {
    const env = makeEnv()
    const { session, log } = recorder()
    await started(session)
    const a = env.recs[0]
    a.onresult({ results: [res('네', true)] })
    a.onresult({ results: [res('네', true), res(' 네 ', true)] })
    a.onend({})
    await advance(1000)
    const b = env.recs[1]
    assert.ok(b?.started, '녹음 중 인식이 끝나면 다시 켠다')
    b.onresult({ results: [res('네', true)] })
    const result = await stopped(session)
    assert.deepEqual(result.utterances, ['네', '네', '네'])
    assert.equal(result.transcript, '네\n네\n네')
    assert.deepEqual(log.final, ['네', '네', '네'])
  })

  test('사용자 말을 콘솔에 남기지 않는다', async () => {
    const env = makeEnv()
    const { session } = recorder()
    await started(session)
    env.recs[0].onresult({ results: [res('비밀번호는 일이삼사', true)] })
    env.recs[0].onerror({ error: 'network' })
    await stopped(session)
    assert.ok(!JSON.stringify(consoleCalls).includes('비밀번호'))
  })
})

describe('공격: error 뒤에 end가 오지 않는 엔진', () => {
  test('치명적 오류(network)만 오고 end가 없어도: 인식기를 정리하고, 다시 켜지 않고, 음량은 계속 잰다', async () => {
    const env = makeEnv()
    const { session, log } = recorder()
    await started(session)
    const rec = env.recs[0]
    rec.onerror({ error: 'network' })
    const before = log.level.length
    await advance(2000)
    assert.ok(rec.aborted || rec.stopped, 'end가 없어도 정리해야 한다')
    assert.equal(env.recs.length, 1, '치명적 오류 뒤에는 다시 켜지 않는다')
    assert.equal(log.error.length, 1)
    assert.equal(log.error[0].code, 'network')
    assert.ok(log.level.length > before + 20, '받아쓰기 오류가 음량 측정을 멈추면 안 된다')
    assert.equal(session.state, 'recording')
    const result = await stopped(session)
    assert.equal(result.stt.error, 'network')
    assert.equal(typeof result.rhythm.tempo, 'string')
  })

  test('되살릴 수 있는 오류(no-speech)만 오고 end가 없어도 다시 켠다', async () => {
    const env = makeEnv()
    const { session } = recorder()
    await started(session)
    env.recs[0].onerror({ error: 'no-speech' })
    await advance(1500)
    assert.equal(env.recs.length, 2)
    assert.ok(env.recs[1].started)
    const result = await stopped(session)
    assert.equal(result.stt.error, null)
  })

  test('기기 안 인식의 language-not-supported(end 없음) → 기본 엔진으로 다시 켠다', async () => {
    const env = makeEnv({ available: 'available' })
    const { session, log } = recorder()
    const p = session.start()
    await flush()
    await p
    const rec = env.recs[0]
    assert.equal(rec.processLocally, true)
    rec.onerror({ error: 'language-not-supported' })
    await advance(1500)
    const next = env.recs[1]
    assert.ok(next?.started, '다시 켜야 한다')
    assert.notEqual(next.processLocally, true)
    const result = await stopped(session)
    assert.equal(result.stt.onDevice, false)
    assert.equal(result.stt.error, null)
    assert.equal(log.error.length, 0)
  })

  test('첫 치명적 오류 코드만 남긴다 (not-allowed 다음 network)', async () => {
    const env = makeEnv()
    const { session, log } = recorder()
    await started(session)
    const rec = env.recs[0]
    const onerror = rec.onerror
    const onend = rec.onend
    onerror({ error: 'not-allowed' })
    onerror({ error: 'network' })
    onend?.({})
    await advance(1000)
    const result = await stopped(session)
    assert.equal(result.stt.error, 'not-allowed')
    assert.equal(log.error.length, 1)
  })

  test('받아쓰기 전용 기기에서 시작 오류 뒤 end가 없어도 start()가 곧 거절된다', async () => {
    const env = makeEnv({ ua: ANDROID_UA, autoStart: false })
    const { session } = recorder()
    let outcome = null
    session.start().then(() => (outcome = 'resolved'), (e) => (outcome = e.code))
    await flush()
    env.recs[0].onerror({ error: 'not-allowed' })
    await advance(1500)
    assert.equal(outcome, 'not-allowed')
    assert.equal(session.state, 'idle')
  })
})

describe('공격: 지난 인식기의 뒤늦은 이벤트', () => {
  test('끝난 세션의 처리기가 새 세션을 건드리지 못한다', async () => {
    const env = makeEnv()
    const { session } = recorder()
    await started(session)
    const a = env.recs[0]
    const old = { onresult: a.onresult, onerror: a.onerror, onend: a.onend }
    a.onend({})
    await advance(1000)
    const b = env.recs[1]
    assert.ok(b?.started)
    old.onresult({ results: [res('유령', true)] })
    old.onerror({ error: 'network' })
    old.onend({})
    await advance(1000)
    assert.equal(b.aborted, false, '새 세션이 닫히면 안 된다')
    assert.equal(env.recs.length, 2)
    b.onresult({ results: [res('진짜 말', true)] })
    const result = await stopped(session)
    assert.deepEqual(result.utterances, ['진짜 말'])
    assert.equal(result.stt.error, null)
  })

  test('cancel 직후 다시 start한 녹음을 지난 녹음의 이벤트가 건드리지 못한다', async () => {
    const env = makeEnv()
    const { session } = recorder()
    await started(session)
    const a = env.recs[0]
    const old = { onresult: a.onresult, onerror: a.onerror, onend: a.onend, onstart: a.onstart }
    session.cancel()
    await started(session)
    const b = env.recs[1]
    old.onstart?.({})
    old.onresult({ results: [res('지난 말', true)] })
    old.onerror({ error: 'not-allowed' })
    old.onend({})
    await advance(1000)
    assert.equal(session.state, 'recording')
    assert.equal(b.aborted, false)
    const result = await stopped(session)
    assert.deepEqual(result.utterances, [])
    assert.equal(result.stt.error, null)
  })
})

describe('공격: 권한 창이 떠 있는 동안 끝낸 녹음', () => {
  for (const how of ['cancel', 'stop']) {
    test(`${how}() 뒤 늦게 열린 마이크를 바로 놓는다`, async () => {
      let release
      const env = makeEnv({ gum: () => new Promise((r) => (release = r)) })
      const { session } = recorder()
      const p = session.start()
      p.catch(() => {})
      await flush()
      if (how === 'cancel') session.cancel()
      else session.stop()
      await flush()
      assert.equal(session.state, 'idle')
      release(env.makeStream())
      await flush()
      await assert.rejects(p)
      assert.equal(env.tracks.length, 1)
      assert.ok(env.tracks[0].stopped, '늦게 열린 마이크 트랙을 멈춰야 한다')
      assert.ok(env.contexts.every((c) => c.closed))
      assert.ok(env.recs.every((r) => !r.started || r.aborted || r.stopped))
      await advance(2000)
      assert.equal(session.state, 'idle')
    })
  }
})

describe('공격: 폰·태블릿', () => {
  const cases = [
    ['안드로이드 UA', { ua: ANDROID_UA }],
    ['userAgentData.mobile', { uaData: { mobile: true } }],
    ['맥으로 알리는 iPad', { ua: IPAD_UA, maxTouchPoints: 5 }],
  ]
  for (const [name, opts] of cases) {
    test(`${name} + 받아쓰기 있음 → 받아쓰기만, 리듬은 0·unknown, 길이는 시계로`, async () => {
      const env = makeEnv(opts)
      const { session } = recorder()
      await started(session)
      assert.equal(env.gumCalls.length, 0, 'getUserMedia를 부르면 안 된다')
      assert.equal(env.contexts.length, 0)
      await advance(5000)
      env.recs[env.recs.length - 1].onresult({ results: [res('안녕하세요 반가워요 오늘 날씨 좋네요', true)] })
      const result = await stopped(session)
      assert.ok(result.seconds >= 4.9 && result.seconds <= 5.5, `seconds ${result.seconds}`)
      const { seconds, ...rest } = result.rhythm
      assert.deepEqual(rest, { speakingSec: 0, pauseRatio: 0, phraseCount: 0, avgPhraseSec: 0, syllPerSec: null, tempo: 'unknown', phrasing: 'unknown' })
      assert.deepEqual(result.utterances, ['안녕하세요 반가워요 오늘 날씨 좋네요'])
    })
  }

  test('안드로이드 + 받아쓰기 없음 → 음량 측정만', async () => {
    const env = makeEnv({ ua: ANDROID_UA, sr: false })
    const { session } = recorder()
    await started(session)
    assert.equal(env.gumCalls.length, 1)
    const result = await stopped(session)
    assert.equal(result.stt.supported, false)
  })

  test('받아쓰기 전용에서 녹음 중 치명적 오류(end 없음) → 모은 데까지로 마무리', async () => {
    const env = makeEnv({ ua: ANDROID_UA })
    const { session } = recorder()
    await started(session)
    let done = null
    session.done.then((r) => (done = r))
    const rec = env.recs[0]
    rec.onresult({ results: [res('여기까지 말했어', true)] })
    rec.onerror({ error: 'network' })
    await advance(3000)
    assert.ok(done, '녹음이 끝나야 한다')
    assert.deepEqual(done.utterances, ['여기까지 말했어'])
    assert.equal(done.stt.error, 'network')
  })
})

describe('공격: 자동 종료와 done', () => {
  test('maxSeconds가 되면 stopping을 알리고 done이 stop()과 같은 결과로 풀린다', async () => {
    makeEnv({ sr: false })
    const { session, log } = recorder({ maxSeconds: 2 })
    await started(session)
    let doneResult = null
    session.done.then((r) => (doneResult = r))
    await advance(2600)
    assert.ok(log.state.includes('stopping'))
    assert.ok(doneResult, 'done이 풀려야 한다')
    assert.equal(doneResult.seconds, 2)
    assert.deepEqual(await session.stop(), doneResult)
    assert.equal(session.state, 'idle')
  })

  test('화면이 가려지면 모은 데까지로 마무리', async () => {
    const env = makeEnv({ sr: false })
    const { session } = recorder()
    await started(session)
    await advance(1000)
    let doneResult = null
    session.done.then((r) => (doneResult = r))
    env.document.hidden = true
    env.document.dispatch('visibilitychange')
    await advance(2000)
    assert.ok(doneResult)
    assert.ok(Math.abs(doneResult.seconds - 1) < 0.2)
    assert.ok(env.tracks[0].stopped)
  })

  test('트랙이 갑자기 끝나면 모은 데까지로 마무리', async () => {
    const env = makeEnv({ sr: false })
    const { session } = recorder()
    await started(session)
    await advance(1500)
    let doneResult = null
    session.done.then((r) => (doneResult = r))
    env.tracks[0].dispatch('ended')
    await advance(2000)
    assert.ok(doneResult)
    assert.ok(Math.abs(doneResult.seconds - 1.5) < 0.2)
  })

  test('cancel()은 결과를 버리고 모든 자원을 놓으며 더 이상 콜백을 부르지 않는다', async () => {
    const env = makeEnv()
    const { session, log } = recorder()
    await started(session)
    await advance(500)
    session.cancel()
    const after = { level: log.level.length, tick: log.tick.length }
    await advance(2000)
    assert.equal(await session.done, null)
    assert.equal(log.level.length, after.level)
    assert.equal(log.tick.length, after.tick)
    assert.ok(env.tracks[0].stopped)
    assert.ok(env.contexts[0].closed)
    assert.ok(env.recs[0].aborted || env.recs[0].stopped)
    assert.equal(session.state, 'idle')
  })
})
