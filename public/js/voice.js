// 목소리 입력 — 마이크 음량과 브라우저 받아쓰기(Web Speech API)로 말투 등록에 쓸 재료를 모은다.
// 원본 음성은 남기지 않는다: MediaRecorder를 쓰지 않고, 프레임마다 음량 수치 하나와 받아쓴 글만 모은다.
// 음량 타임라인도 리듬 분석이 끝나면 바로 버린다.
import { LIMITS } from '../shared/constants.js'
import { FRAME_MS, analysisWindowSize, analyzeRhythm, emptyRhythm, frameLevel, readRecognitionResults } from '../shared/rhythm.js'

const DEFAULT_LANG = 'ko-KR'
const MAX_SECONDS_LIMIT = 600
const MAX_UTTERANCES = 500
const MIC_CONSTRAINTS = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }

/** 기다리는 시간(ms) */
const WAIT = Object.freeze({
  clock: 250, // 받아쓰기만 쓸 때 시계를 돌리는 간격
  restart: 300, // 인식이 끝난 뒤 다시 켜기까지 — 끝난 세션이 마이크를 놓을 틈을 준다
  endAfterError: 400, // error 뒤에 end가 따라오는지 지켜보는 시간 (오지 않는 엔진이 있다)
  lastResult: 1500, // 멈춘 뒤 마지막 확정 결과를 기다리는 시간
  engineProbe: 1500, // 기기 안 인식 가능 여부를 묻는 시간
  listening: 20_000, // 받아쓰기 전용 기기에서 듣기 시작(권한 창 응답 포함)을 기다리는 시간
  trackStart: 10_000, // 마이크 트랙을 넘긴 인식이 이 안에 시작되지 않으면 기본 방식으로 바꾼다
})

/** 결과 없이 연달아 다시 켤 수 있는 횟수 — 곧바로 끝나기만 하는 엔진에서 무한히 돌지 않게 */
const MAX_SILENT_RESTARTS = 8

/** 받아쓰기가 녹음 시간을 이만큼은 덮어야 말 빠르기를 잰다 — 일부만 받아쓴 글로 나누면 실제보다 느리게 나온다 */
const MIN_STT_COVERAGE = 0.9

/** start()가 거절할 때의 사유(code)와 안내 문구 */
const START_MESSAGES = Object.freeze({
  'not-allowed': '마이크 사용이 허용되지 않았어요. 브라우저에서 마이크 권한을 허용해 주세요.',
  'no-mic': '마이크를 찾지 못했어요. 마이크가 연결되어 있는지 확인해 주세요.',
  insecure: '마이크는 https 또는 localhost 주소에서만 쓸 수 있어요.',
  unsupported: '이 브라우저에서는 음성 입력을 쓸 수 없어요.',
  failed: '녹음을 시작하지 못했어요. 잠시 뒤 다시 시도해 주세요.',
})
const BUSY_MESSAGE = '이미 녹음하고 있어요.'
const CANCELLED_MESSAGE = '녹음을 시작하기 전에 멈췄어요.'

/** getUserMedia 오류 이름 → start() 거절 사유 (옛 브라우저의 이름 포함) */
const MIC_ERROR_CODES = new Map([
  ['NotAllowedError', 'not-allowed'],
  ['PermissionDeniedError', 'not-allowed'],
  ['SecurityError', 'not-allowed'],
  ['NotFoundError', 'no-mic'],
  ['DevicesNotFoundError', 'no-mic'],
  ['OverconstrainedError', 'no-mic'],
])

/** 받아쓰기만 쓰는 기기에서 인식이 시작도 못 했을 때: 인식 오류 → start() 거절 사유 */
const STT_START_CODES = new Map([
  ['not-allowed', 'not-allowed'],
  ['audio-capture', 'no-mic'],
  // Safari에서는 Siri가 꺼져 있거나 그 언어를 지원하지 않을 때 나온다
  ['service-not-allowed', 'unsupported'],
  ['language-not-supported', 'unsupported'],
])

/** 녹음 도중 받아쓰기가 멈췄을 때 onError로 알리는 문구 */
const STT_MESSAGES = new Map([
  ['not-allowed', '받아쓰기 권한이 없어 말을 글로 옮기지 못했어요.'],
  ['service-not-allowed', '이 기기의 음성 인식 기능이 꺼져 있거나 한국어를 지원하지 않아요.'],
  ['language-not-supported', '이 브라우저의 받아쓰기는 한국어를 지원하지 않아요.'],
  ['audio-capture', '받아쓰기가 마이크 소리를 받지 못했어요.'],
  ['network', '연결 문제로 받아쓰기가 멈췄어요.'],
])
const STT_FALLBACK_MESSAGE = '받아쓰기가 멈췄어요. 말한 내용을 직접 적어 주세요.'

/** 다시 켜면 되는 오류: 말소리가 없었거나, 인식이 중단됐거나, 쓰지 않는 기능에 관한 것 */
const BENIGN_STT_ERRORS = new Set(['no-speech', 'aborted', 'phrases-not-supported', 'bad-grammar'])
/** 마이크 트랙을 넘긴 인식이 막혔을 때 나오는 오류 */
const TRACK_ERRORS = new Set(['not-allowed', 'audio-capture'])
/** 기기 안 인식을 쓸 수 없을 때 나오는 오류 — Chrome은 앞의 것, 표준 문서는 뒤의 것 */
const LOCAL_ERRORS = new Set(['language-not-supported', 'service-not-allowed'])

/** 되살릴 수 있는 오류의 처리: 설정을 바꾸고 인식을 다시 켠다 */
const RECOVERIES = Object.freeze({
  resume: () => {},
  'without-track': (run) => {
    run.useTrack = false
  },
  'default-engine': (run) => {
    run.useLocal = false
    run.stt.onDevice = false
  },
})

const hasBrowser = () => typeof window !== 'undefined' && typeof navigator !== 'undefined' && typeof document !== 'undefined'
// Safari는 접두사가 붙은 이름만 있다
const recognitionClass = () => window.SpeechRecognition || window.webkitSpeechRecognition || null
const userAgent = () => String(navigator.userAgent || '')
const now = () => performance.now()
const round2 = (n) => Math.round(n * 100) / 100

const startError = (code, message = START_MESSAGES[code]) => Object.assign(new Error(message), { code })
// DOMException에도 숫자 code가 있어서, 문자열 사유가 붙은 것만 우리가 만든 오류로 본다
const isStartError = (err) => err instanceof Error && typeof err.code === 'string' && Object.hasOwn(START_MESSAGES, err.code)
const sttError = (code) => Object.assign(new Error(STT_MESSAGES.get(code) ?? STT_FALLBACK_MESSAGE), { code })

/** 되살릴 수 있는 오류면 RECOVERIES의 키, 받아쓰기를 접어야 하는 오류면 null */
function recoveryFor(run, session, code) {
  // 가려진 화면에서는 브라우저가 인식을 끊으며 not-allowed 등을 보낸다 — 실패가 아니라 녹음을 마무리할 신호다
  if (BENIGN_STT_ERRORS.has(code) || document.hidden) return 'resume'
  if (session.trackFed && run.plan.trackRetry && TRACK_ERRORS.has(code)) return 'without-track'
  if (session.local && LOCAL_ERRORS.has(code)) return 'default-engine'
  return null
}

/** 실패해도 되는 정리·보조 호출. 동기 예외와 거절된 약속을 모두 삼킨다. */
function quietly(fn) {
  try {
    const out = fn()
    if (typeof out?.catch === 'function') out.catch(() => {})
    return out
  } catch {
    return undefined
  }
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** 약속이 ms 안에 끝나지 않거나 실패하면 fallback으로 끝낸다 */
function settleWithin(promise, ms, fallback) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms)
    const finish = (value) => {
      clearTimeout(timer)
      resolve(value)
    }
    promise.then(finish, () => finish(fallback))
  })
}

/**
 * 이 브라우저에서 쓸 수 있는 기능. 보안 연결이 아니면 마이크도 받아쓰기도 쓸 수 없다.
 * @returns {{ mic: boolean, stt: boolean, secure: boolean }}
 */
export function voiceSupport() {
  if (!hasBrowser()) return { mic: false, stt: false, secure: false }
  const secure = window.isSecureContext === true
  const mic = secure && typeof navigator.mediaDevices?.getUserMedia === 'function' && typeof window.AudioContext === 'function'
  return { mic, stt: secure && Boolean(recognitionClass()), secure }
}

function coarsePointer() {
  return quietly(() => window.matchMedia('(pointer: coarse)').matches) === true
}

/** 폰·태블릿인지 — 여기서는 음량 측정과 받아쓰기가 마이크를 함께 쓰지 못한다 */
function isMobileDevice() {
  if (navigator.userAgentData?.mobile === true) return true
  const ua = userAgent()
  if (/Android|iPhone|iPad|iPod/i.test(ua)) return true
  // iPadOS는 맥이라고 알리고, 안드로이드의 '데스크톱 사이트'는 UA에서 Android를 뺀다 → 터치로 가려낸다
  return navigator.maxTouchPoints > 1 && (/Macintosh/.test(ua) || coarsePointer())
}

/**
 * 이 기기에서 무엇을 켤지 정한다.
 * - 데스크톱: 음량 측정 + 받아쓰기. 새 엔진에서는 마이크 트랙 하나를 둘이 나눠 쓴다.
 * - 폰·태블릿: 받아쓰기가 되면 받아쓰기만, 안 되면 음량 측정만.
 */
function capturePlan() {
  const support = voiceSupport()
  const mobile = isMobileDevice()
  const SR = support.stt ? recognitionClass() : null
  const meter = support.mic && !(mobile && SR)
  // start(track)을 받는지 직접 알아낼 방법이 없어, 같은 무렵 나온 정적 메서드 available()을 어림 신호로 쓴다.
  // 보장은 아니므로 트랙을 거절하면 기본 start()로 바꾼다(#listen). 안드로이드 Chrome에도 이름만 있을 수 있어 폰은 따로 뺀다.
  const shareTrack = meter && !mobile && typeof SR?.available === 'function'
  return {
    secure: support.secure,
    SR,
    meter,
    shareTrack,
    // 안드로이드에서는 continuous를 켜도 효과가 없다. 끄고, 세션이 끝날 때마다 다시 켠다.
    continuous: !/Android/i.test(userAgent()),
    // 트랙을 넘긴 인식이 막히거나 시작되지 않으면 기본 방식으로 한 번 더 켠다. Firefox만 예외다:
    // 모델을 내려받는 동안 start 이벤트가 오지 않고, 내려받기를 거절한 사람에게 같은 창을 또 띄우게 된다.
    trackRetry: !/Firefox\//.test(userAgent()),
  }
}

/** 마이크 트랙을 인식기에 넘겨도 되는 상태인지 — 소리가 흐르지 않는 트랙을 넘기면 인식이 시작되지 않는다 */
const trackUsable = (track) => Boolean(track) && track.readyState === 'live' && track.enabled && !track.muted

/** 마이크와 오디오 그래프를 놓고, 마지막으로 읽은 표본도 지운다. 여러 번 불러도 된다. */
function releaseMic(mic) {
  if (!mic) return
  for (const track of quietly(() => mic.stream.getTracks()) ?? []) quietly(() => track.stop())
  quietly(() => mic.source?.disconnect())
  quietly(() => mic.analyser?.disconnect())
  quietly(() => mic.context?.close())
  mic.buffer?.fill(0)
}

/** 마이크 → 분석기. 스피커에는 잇지 않는다: 소리를 내보내지도, 담아 두지도 않고 지금 음량만 읽는다. */
function wireMeter(stream, context) {
  const mic = { stream, context, track: stream.getAudioTracks()[0] ?? null, source: null, analyser: null, buffer: null, read: () => 0 }
  mic.source = context.createMediaStreamSource(stream)
  mic.analyser = context.createAnalyser()
  mic.analyser.fftSize = analysisWindowSize(context.sampleRate)
  mic.source.connect(mic.analyser)
  mic.buffer = new Float32Array(mic.analyser.fftSize)
  mic.read = () => {
    mic.analyser.getFloatTimeDomainData(mic.buffer)
    return frameLevel(mic.buffer)
  }
  return mic
}

/** 녹음 한 번의 상태 */
function newRun(plan) {
  return {
    plan,
    done: deferred(),
    over: false, // 끝내기 시작함
    discarded: false, // 결과를 버리기로 함
    // 시계
    startedAt: null,
    endedAt: null,
    timer: 0,
    lastTick: -1,
    onHidden: null,
    // 음량 측정
    mic: null,
    levels: [],
    onTrackEnded: null,
    // 받아쓰기
    session: null,
    wantStt: Boolean(plan.SR),
    useTrack: plan.shareTrack,
    useLocal: false,
    silentRestarts: 0,
    restartTimer: 0,
    listenedMs: 0,
    utterances: [],
    stt: { used: false, onDevice: false, error: null },
    // 받아쓰기 전용 기기: 인식기가 실제로 듣기 시작했는지
    gate: plan.meter ? null : deferred(),
    gateTimer: 0,
  }
}

/**
 * @typedef {Object} VoiceResult
 * @property {string[]} utterances  받아쓴 발화
 * @property {string} transcript    발화를 줄바꿈으로 이은 글
 * @property {import('../../shared/types.js').VoiceRhythm} rhythm  음량을 재지 못한 기기에서는 길이만 채운 빈 리듬
 * @property {number} seconds       녹음 길이(초)
 * @property {{ supported: boolean, used: boolean, onDevice: boolean, error: string|null }} stt
 *   supported: 받아쓰기 기능이 있는지 / used: 실제로 듣기 시작했는지 /
 *   onDevice: 기기 안에서 처리된 것이 확인됐는지 / error: 받아쓰기를 멈추게 한 첫 오류
 */

/**
 * 녹음 한 번을 맡는다: start() → 녹음 → stop() 또는 자동 종료. 끝난 뒤에는 다시 start()할 수 있다.
 */
export class VoiceSession {
  #maxMs
  #lang
  #handlers
  #state = 'idle'
  #run = null
  #done = Promise.resolve(null)

  /**
   * @param {{ maxSeconds?: number, lang?: string, onLevel?: (rms: number) => void, onInterim?: (text: string) => void,
   *   onFinal?: (text: string) => void, onTick?: (elapsedSeconds: number) => void,
   *   onState?: (state: string) => void, onError?: (error: Error & { code: string }) => void }} [options]
   *   onError는 녹음 도중 받아쓰기가 멈췄을 때 한 번 불린다(음량 측정은 계속된다).
   */
  constructor(options) {
    const { maxSeconds, lang, onLevel, onInterim, onFinal, onTick, onState, onError } = options ?? {}
    const seconds = typeof maxSeconds === 'number' && maxSeconds > 0 ? Math.min(maxSeconds, MAX_SECONDS_LIMIT) : LIMITS.voice.maxSeconds
    this.#maxMs = seconds * 1000
    this.#lang = typeof lang === 'string' && lang.trim() ? lang.trim() : DEFAULT_LANG
    this.#handlers = { level: onLevel, interim: onInterim, final: onFinal, tick: onTick, state: onState, error: onError }
  }

  /** @returns {'idle'|'starting'|'recording'|'stopping'} */
  get state() {
    return this.#state
  }

  /**
   * 지금(또는 마지막) 녹음의 결과. 최대 시간이 되어 스스로 멈췄을 때도 여기로 받는다. 취소한 녹음은 null.
   * @returns {Promise<VoiceResult|null>}
   */
  get done() {
    return this.#done
  }

  /**
   * 마이크를 열고 녹음을 시작한다. 실제로 듣기 시작하면 끝난다.
   * 실패하면 code가 'not-allowed' | 'no-mic' | 'insecure' | 'unsupported' | 'failed'인 Error로 거절한다.
   * 권한 창이 사용자 동작을 요구하므로 클릭 처리기 안에서 바로 불러야 한다.
   */
  async start() {
    if (!hasBrowser()) throw startError('unsupported')
    if (this.#state !== 'idle') throw startError('failed', BUSY_MESSAGE)
    const plan = capturePlan()
    if (!plan.secure) throw startError('insecure')
    if (!plan.meter && !plan.SR) throw startError('unsupported')

    const run = newRun(plan)
    this.#run = run
    this.#done = run.done.promise
    this.#setState('starting')
    try {
      await this.#open(run)
    } catch (err) {
      if (!run.over) this.#abort(run)
      throw isStartError(err) ? err : startError('failed')
    }
  }

  /**
   * 녹음을 끝내고 결과를 돌려준다. 이미 끝나는 중이거나 끝났으면 같은 결과를 돌려준다.
   * @returns {Promise<VoiceResult|null>}
   */
  async stop() {
    const run = this.#run
    if (run && this.#state === 'starting') this.#abort(run, { empty: true })
    else if (run) this.#finish(run)
    return this.#done
  }

  /** 바로 멈추고 모은 것을 버린다. */
  cancel() {
    if (this.#run) this.#abort(this.#run)
  }

  #setState(state) {
    if (this.#state === state) return
    this.#state = state
    this.#emit('state', state)
  }

  /** 화면 쪽 콜백에서 난 오류가 녹음을 끊지 않게 한다. 오류는 콘솔에 남도록 따로 던진다. */
  #emit(name, value) {
    const handler = this.#handlers[name]
    if (typeof handler !== 'function') return
    try {
      handler(value)
    } catch (err) {
      setTimeout(() => {
        throw err
      })
    }
  }

  #ensureLive(run) {
    if (run.over) throw startError('failed', CANCELLED_MESSAGE)
  }

  // ── 시작 ──────────────────────────────────────────

  async #open(run) {
    const { plan } = run
    this.#ensureLive(run)
    if (!plan.meter) {
      await this.#awaitListening(run)
    } else {
      // 트랙을 넘길 수 없는 엔진(Safari 등)은 누른 순간 안에서 인식을 먼저 켜야 한다
      if (plan.SR && !plan.shareTrack) this.#listen(run)
      await this.#openMic(run)
      if (plan.shareTrack) await this.#listenOnTrack(run)
    }
    this.#startClock(run)
  }

  /** 받아쓰기 전용 기기: 인식기가 듣기 시작해야(권한 허용 포함) 녹음이 시작된 것이다 */
  async #awaitListening(run) {
    const listening = run.gate.promise
    run.gateTimer = setTimeout(() => this.#settleGate(run, startError('failed')), WAIT.listening)
    this.#listen(run)
    await listening
  }

  async #openMic(run) {
    let context = null
    let stream = null
    try {
      // 누른 순간 안에서 만들어야 자동재생 정책에 막히지 않는다
      context = new window.AudioContext()
      stream = await navigator.mediaDevices.getUserMedia(MIC_CONSTRAINTS)
      // 권한 창이 떠 있는 동안 녹음이 끝났다면, 뒤늦게 열린 마이크를 바로 놓는다
      this.#ensureLive(run)
      run.mic = wireMeter(stream, context)
    } catch (err) {
      releaseMic({ stream, context })
      throw isStartError(err) ? err : startError(MIC_ERROR_CODES.get(err?.name) ?? 'failed')
    }
    if (context.state === 'suspended') quietly(() => context.resume())
    // 마이크가 뽑히거나 권한이 거둬지면 모은 데까지로 마무리한다
    run.onTrackEnded = () => this.#finish(run)
    run.mic.track?.addEventListener('ended', run.onTrackEnded)
  }

  /**
   * 음량 측정과 같은 마이크 트랙으로 인식을 켠다.
   * 기기 안 인식은 브라우저가 지금 바로 쓸 수 있다고 답할 때만 쓴다 — 모델을 내려받게 하는 install()은 부르지 않는다.
   */
  async #listenOnTrack(run) {
    const probe = new Promise((resolve) => resolve(run.plan.SR.available({ langs: [this.#lang], processLocally: true })))
    run.useLocal = (await settleWithin(probe, WAIT.engineProbe, 'unavailable')) === 'available'
    this.#ensureLive(run)
    this.#listen(run)
  }

  #startClock(run) {
    this.#ensureLive(run)
    run.startedAt = now()
    run.timer = setInterval(() => this.#onFrame(run), run.mic ? FRAME_MS : WAIT.clock)
    // 화면이 가려지면 타이머가 느려지고 폰에서는 인식도 끊긴다 → 모은 데까지로 마무리한다
    run.onHidden = () => {
      if (document.hidden) this.#finish(run)
    }
    document.addEventListener('visibilitychange', run.onHidden)
    this.#setState('recording')
    this.#onFrame(run)
  }

  #onFrame(run) {
    if (run.over) return
    const elapsed = now() - run.startedAt
    if (run.mic) this.#sample(run, elapsed)
    const second = Math.floor(Math.min(elapsed, this.#maxMs) / 1000)
    if (second !== run.lastTick) {
      run.lastTick = second
      this.#emit('tick', second)
    }
    if (elapsed >= this.#maxMs) this.#finish(run)
  }

  #sample(run, elapsed) {
    const level = quietly(run.mic.read) ?? 0
    // 타이머가 밀려도 타임라인이 실제 시간과 어긋나지 않게, 지나간 프레임 수만큼 채운다
    const due = Math.floor(Math.min(elapsed, this.#maxMs) / FRAME_MS)
    while (run.levels.length < due) run.levels.push(level)
    this.#emit('level', level)
  }

  // ── 받아쓰기 ──────────────────────────────────────────
  // 인식 세션은 언제든 끝날 수 있다(침묵, 서버 사정). 녹음하는 동안에는 끝날 때마다 새 세션을 연다.

  #listen(run) {
    if (run.over || !run.wantStt || run.session || document.hidden) return
    let session = null
    try {
      session = this.#newSession(run)
      run.session = session
      if (session.trackFed) session.rec.start(run.mic.track)
      else session.rec.start()
      if (session.trackFed && run.plan.trackRetry) session.watchdog = setTimeout(() => this.#onTrackSilent(run, session), WAIT.trackStart)
    } catch (err) {
      // available()이 있다고 start(track)을 받는다는 보장은 없다 → 트랙을 거절하면 기본 방식으로 곧바로 다시 켠다
      if (session?.trackFed) {
        this.#closeSession(run, session, false)
        run.useTrack = false
        this.#listen(run)
        return
      }
      if (session && run.session === session) this.#closeSession(run, session, false)
      run.session = null
      this.#sttFailed(run, err?.name === 'NotAllowedError' ? 'not-allowed' : 'start-failed')
      this.#afterSession(run)
    }
  }

  #newSession(run) {
    const rec = new run.plan.SR()
    rec.lang = this.#lang
    rec.interimResults = true
    rec.continuous = run.plan.continuous
    rec.maxAlternatives = 1
    const local = run.useLocal && 'processLocally' in rec
    if (local) rec.processLocally = true
    const session = { rec, local, trackFed: run.useTrack && trackUsable(run.mic?.track), finals: [], interim: '', announced: 0, since: null, failed: false, watchdog: 0, graceTimer: 0, onClosed: null }
    // 지난 세션의 뒤늦은 이벤트가 새 세션을 건드리지 못하게, 처리기마다 지금 세션인지 확인한다
    const guard = (handle) => (event) => {
      if (run.session === session) handle(event)
    }
    rec.onstart = guard(() => this.#onListening(run, session))
    rec.onresult = guard((event) => this.#onResult(run, session, event))
    rec.onerror = guard((event) => this.#onSttError(run, session, event?.error))
    rec.onend = guard(() => this.#endSession(run, session))
    return session
  }

  #onListening(run, session) {
    clearTimeout(session.watchdog)
    if (session.since !== null) return
    session.since = now()
    run.stt.used = true
    if (session.local) run.stt.onDevice = true
    this.#settleGate(run)
  }

  #onResult(run, session, event) {
    this.#onListening(run, session) // start 이벤트 없이 결과부터 주는 엔진 대비
    const { finals, interim } = readRecognitionResults(event?.results)
    const fresh = finals.slice(session.announced)
    session.finals = finals
    session.announced = Math.max(session.announced, finals.length)
    run.silentRestarts = 0
    for (const text of fresh) this.#emit('final', text)
    if (fresh.length || interim !== session.interim) this.#emit('interim', interim)
    session.interim = interim
  }

  #onSttError(run, session, code) {
    if (run.over) {
      // 끝내는 중에 온 오류는 알릴 필요가 없다. end를 기다리지 않고 바로 닫는다.
      this.#endSession(run, session)
      return
    }
    // 한 번의 실패에 오류가 두 번 올 수 있다(구체적인 코드 뒤에 network·aborted) → 세션마다 첫 오류만 본다
    if (session.failed) return
    session.failed = true
    const recovery = recoveryFor(run, session, code)
    if (recovery) RECOVERIES[recovery](run)
    else this.#sttFailed(run, typeof code === 'string' && code ? code : 'unknown')
    // error 뒤에 end가 오지 않는 엔진이 있다(WebKit의 권한 오류, Chrome의 기기 안 인식 오류) → 조금 기다렸다가 직접 닫는다
    session.graceTimer = setTimeout(() => this.#endSession(run, session), WAIT.endAfterError)
  }

  /** 마이크 트랙을 넘긴 인식이 시작 신호를 주지 않는다 → 브라우저가 직접 마이크를 여는 기본 방식으로 다시 켠다 */
  #onTrackSilent(run, session) {
    if (run.session !== session || session.since !== null) return
    run.useTrack = false
    this.#endSession(run, session)
  }

  /** 받아쓰기를 더 쓸 수 없다. 첫 오류만 남기고 알린다 — 음량 측정은 멈추지 않는다. */
  #sttFailed(run, code) {
    run.wantStt = false
    if (run.stt.error) return
    run.stt.error = code
    // 아직 시작 전(받아쓰기 전용 기기)이면 start()의 거절로 알린다
    if (!run.gate) this.#emit('error', sttError(code))
  }

  /** end에서도, end가 오지 않는 오류 뒤에서도 불린다. 같은 세션을 두 번 닫지 않는다. */
  #endSession(run, session) {
    if (run.session !== session) return
    this.#closeSession(run, session, true)
    this.#afterSession(run)
  }

  #closeSession(run, session, keep) {
    run.session = null
    clearTimeout(session.watchdog)
    clearTimeout(session.graceTimer)
    const { rec } = session
    rec.onstart = rec.onresult = rec.onerror = rec.onend = null
    quietly(() => rec.abort())
    if (session.since !== null && run.startedAt !== null) {
      run.listenedMs += Math.max(0, (run.endedAt ?? now()) - Math.max(session.since, run.startedAt))
    }
    if (keep) this.#commit(run, session)
    session.onClosed?.()
  }

  /** 확정된 발화를 결과로 옮긴다. 확정되기 전에 세션이 끊겼으면 들은 데까지라도 남긴다. */
  #commit(run, session) {
    const heard = [...session.finals]
    if (session.interim) {
      heard.push(session.interim)
      this.#emit('final', session.interim)
      this.#emit('interim', '')
    }
    for (const text of heard) {
      if (run.utterances.length < MAX_UTTERANCES) run.utterances.push(text)
    }
  }

  /** 세션이 끝난 뒤: 더 받아써야 하면 잠시 뒤 다시 켜고, 받아쓰기뿐인 기기에서 더 받아쓸 수 없으면 녹음을 끝낸다 */
  #afterSession(run) {
    if (run.over) return
    if (run.wantStt && !document.hidden && run.silentRestarts < MAX_SILENT_RESTARTS) {
      run.silentRestarts++
      run.restartTimer = setTimeout(() => this.#listen(run), WAIT.restart)
      return
    }
    run.wantStt = false
    if (run.plan.meter) return
    const startFailure = startError(STT_START_CODES.get(run.stt.error) ?? 'failed')
    if (!this.#settleGate(run, startFailure)) this.#finish(run)
  }

  /** 받아쓰기 전용 기기에서 start()가 기다리는 약속을 푼다. 이미 풀렸으면 false. */
  #settleGate(run, error) {
    const gate = run.gate
    if (!gate) return false
    run.gate = null
    clearTimeout(run.gateTimer)
    if (error) gate.reject(error)
    else gate.resolve()
    return true
  }

  // ── 마무리 ──────────────────────────────────────────

  /** 녹음을 끝내고 결과를 만든다. 여러 번 불려도 한 번만 진행한다. */
  async #finish(run) {
    if (run.over) return
    run.over = true
    run.endedAt = now()
    this.#setState('stopping')
    this.#halt(run)
    await this.#drainRecognition(run)
    if (run.discarded) return
    releaseMic(run.mic)
    this.#conclude(run, this.#buildResult(run))
  }

  /** 기다리지 않고 바로 끝낸다. 모은 것은 버리고, empty면 빈 결과를, 아니면 null을 돌려준다. */
  #abort(run, { empty = false } = {}) {
    run.over = true
    run.discarded = true
    this.#halt(run)
    if (run.session) this.#closeSession(run, run.session, false)
    releaseMic(run.mic)
    run.levels.length = 0
    run.utterances.length = 0
    this.#settleGate(run, startError('failed', CANCELLED_MESSAGE))
    this.#conclude(run, empty ? this.#buildResult(run) : null)
  }

  #halt(run) {
    run.wantStt = false
    clearInterval(run.timer)
    clearTimeout(run.restartTimer)
    document.removeEventListener('visibilitychange', run.onHidden)
    run.mic?.track?.removeEventListener('ended', run.onTrackEnded)
  }

  /** 인식기에 그만 들으라고 하고 마지막 확정 결과를 잠깐 기다린다. 그래도 끝나지 않으면 직접 닫는다. */
  async #drainRecognition(run) {
    const session = run.session
    if (!session) return
    const closed = new Promise((resolve) => {
      session.onClosed = resolve
    })
    quietly(() => session.rec.stop())
    await settleWithin(closed, WAIT.lastResult)
    if (run.session === session) this.#closeSession(run, session, !run.discarded)
  }

  /** @returns {VoiceResult} */
  #buildResult(run) {
    const elapsedMs = run.startedAt === null ? 0 : Math.min(run.endedAt - run.startedAt, this.#maxMs)
    const seconds = round2(elapsedMs / 1000)
    const transcript = run.utterances.join('\n')
    const covered = run.listenedMs >= elapsedMs * MIN_STT_COVERAGE
    const measured = run.mic ? analyzeRhythm({ levels: run.levels, frameMs: FRAME_MS, transcript: covered ? transcript : '' }) : emptyRhythm()
    run.levels.length = 0 // 음량 타임라인은 분석이 끝나면 버린다
    return {
      utterances: [...run.utterances],
      transcript,
      rhythm: { ...measured, seconds },
      seconds,
      stt: { supported: Boolean(run.plan.SR), ...run.stt },
    }
  }

  #conclude(run, result) {
    if (this.#run === run) this.#run = null
    this.#setState('idle')
    run.done.resolve(result)
  }
}
