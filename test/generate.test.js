// 생성 엔진 테스트: 입력 다듬기, 프롬프트, LLM 호출 계층, 그리고 전체 흐름(가짜 LLM·안전 필터·트렌드 저장소).
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Anthropic from '@anthropic-ai/sdk'
import { LIMITS, SAFETY_CATEGORIES, SITUATIONS, SPICE_LEVELS, TECHNIQUE_IDS } from '../shared/constants.js'
import { charLength } from '../shared/hangul.js'
import { cleanSlotWord, cleanText, sanitizeCustomTrend, sanitizeFeedback, sanitizeOptions, sanitizeProfilePayload, textKey } from '../server/generate/sanitize.js'
import { GENERATION_SCHEMA, SAFETY_SCHEMA, buildGenerationRequest, buildSafetyRequest } from '../server/generate/prompt.js'
import { LlmError, createLlm } from '../server/generate/llm.js'
import { GenerateError, createGenerator } from '../server/generate/engine.js'

const seed = JSON.parse(readFileSync(new URL('../server/trends/seed-trends.json', import.meta.url), 'utf8')).trends

const EMPTY_PROFILE = {
  register: 'banmal',
  cute: 0,
  endings: [],
  fillers: [],
  expressions: [],
  tail: { kk: null, hh: null, cry: null, emoji: [], emoticons: [], punct: [], choseong: [], elongation: false },
  rhythm: { avgChars: null, short: false, tempo: 'unknown', phrasing: 'unknown' },
  samples: [],
  hasVoice: false,
  hasText: false,
}

const PROFILE = {
  register: 'banmal',
  cute: 0.1,
  endings: ['거든', '잖아', '네'],
  fillers: ['아니', '진짜'],
  expressions: ['대박', '완전 좋아'],
  tail: { kk: 'ㅋㅋㅋ', hh: null, cry: null, emoji: ['😂'], emoticons: ['^^'], punct: ['~'], choseong: ['ㅇㅇ'], elongation: true },
  rhythm: { avgChars: 14.5, short: true, tempo: 'fast', phrasing: 'choppy' },
  samples: ['아 근데 오늘 진짜 웃긴 일 있었거든', '약간 매웠는데 맛있더라'],
  hasVoice: true,
  hasText: true,
}

// ── 입력 다듬기 ───────────────────────────────────────────

describe('sanitizeProfilePayload', () => {
  test('엉터리 입력은 안전한 기본값으로', () => {
    for (const raw of [undefined, null, 'x', 42, [], () => {}]) assert.deepEqual(sanitizeProfilePayload(raw), EMPTY_PROFILE)
    assert.deepEqual(sanitizeProfilePayload({ register: 'royal', cute: 'x', endings: 'no', tail: 7, rhythm: [], samples: {}, hasVoice: 'yes' }), EMPTY_PROFILE)
  })

  test('올바른 요약본은 그대로 통과한다', () => {
    assert.deepEqual(sanitizeProfilePayload(PROFILE), PROFILE)
    assert.deepEqual(sanitizeProfilePayload(sanitizeProfilePayload(PROFILE)), PROFILE)
    for (const register of ['banmal', 'haeyo', 'hapsyo', 'eumseum']) assert.equal(sanitizeProfilePayload({ register }).register, register)
  })

  test('목록은 개수와 글자 수를 자르고, 문자열이 아닌 것·빈 것·겹치는 것은 버린다', () => {
    const many = Array.from({ length: 40 }, (_, i) => `말${i}`)
    const p = sanitizeProfilePayload({
      endings: [null, 3, {}, '  거든 ', '거든', '', '~잖아', '-네', ...many],
      fillers: many,
      expressions: ['가'.repeat(50), ...many],
      samples: ['나'.repeat(200), ...many],
      tail: { emoji: ['😂', '🥹', '🔥', '✨', '😭'], emoticons: ['^^', ';;', 'ㅇㅅㅇ', '>_<'], punct: ['~', '!!', '…', '?!'], choseong: ['ㅇㅇ', 'ㄹㅇ', 'ㄱㄱ', 'ㅇㅈ'] },
    })
    assert.deepEqual(p.endings, ['거든', '잖아', '네', '말0', '말1', '말2'])
    assert.equal(p.fillers.length, 6)
    assert.equal(p.expressions.length, 8)
    assert.equal(p.expressions[0], '가'.repeat(20))
    assert.equal(p.samples.length, 12)
    assert.equal(p.samples[0], '나'.repeat(80))
    assert.deepEqual(p.tail.emoji, ['😂', '🥹', '🔥'])
    assert.deepEqual(p.tail.emoticons, ['^^', ';;', 'ㅇㅅㅇ'])
    assert.deepEqual(p.tail.punct, ['~', '!!', '…'])
    assert.deepEqual(p.tail.choseong, ['ㅇㅇ', 'ㄹㅇ', 'ㄱㄱ'])
  })

  test('제어 문자·보이지 않는 문자·줄바꿈을 걷어 낸다', () => {
    const p = sanitizeProfilePayload({ endings: ['거\u0000든\u200B', '잖\u202E아'], samples: ['첫 줄\n둘째\t줄  끝\uFEFF', 'a\uD83Db'] })
    assert.deepEqual(p.endings, ['거든', '잖아'])
    assert.deepEqual(p.samples, ['첫 줄 둘째 줄 끝', 'ab'])
    // 풀어 쓴 자모(NFD)는 합쳐서 본다
    assert.deepEqual(sanitizeProfilePayload({ endings: ['거든'.normalize('NFD')] }).endings, ['거든'])
    // 이모지를 잇는 문자는 남긴다
    assert.deepEqual(sanitizeProfilePayload({ tail: { emoji: ['👩\u200D💻'] } }).tail.emoji, ['👩\u200D💻'])
  })

  test('말끝 습관은 정해진 모양만 받는다 (후보 끝에 그대로 붙기 때문)', () => {
    const tail = (value) => sanitizeProfilePayload({ tail: value }).tail
    assert.equal(tail({ kk: 'ㅋㅋㅋ' }).kk, 'ㅋㅋㅋ')
    assert.equal(tail({ kk: 'ㅋ'.repeat(12) }).kk, 'ㅋㅋㅋㅋㅋㅋ')
    assert.equal(tail({ kk: 'ㅋ' }).kk, null)
    assert.equal(tail({ kk: 'ㅋㅋ 바보' }).kk, null)
    assert.equal(tail({ kk: 'ㅎㅎ' }).kk, null)
    assert.equal(tail({ hh: 'ㅎㅎ' }).hh, 'ㅎㅎ')
    assert.equal(tail({ cry: 'ㅠㅜㅠ' }).cry, 'ㅠㅜㅠ')
    assert.equal(tail({ cry: ['ㅠㅠ'] }).cry, null)
    assert.deepEqual(tail({ emoji: ['글자', 'a', '😂 😂', '😂'] }).emoji, ['😂'])
    assert.deepEqual(tail({ emoticons: ['안녕', 'a b', '^_^'] }).emoticons, ['^_^'])
    assert.deepEqual(tail({ punct: ['지시문', '~~~~', '!?', '.'] }).punct, ['!?', '.'])
    assert.deepEqual(tail({ choseong: ['ㅇ', '가나', 'ㄹㅇ'] }).choseong, ['ㄹㅇ'])
    assert.equal(tail({ elongation: 1 }).elongation, false)
    assert.equal(tail({ elongation: true }).elongation, true)
  })

  test('수와 종류는 범위 안에서만', () => {
    const p = (raw) => sanitizeProfilePayload(raw)
    assert.equal(p({ cute: 7 }).cute, 1)
    assert.equal(p({ cute: -1 }).cute, 0)
    assert.equal(p({ cute: Number.NaN }).cute, 0)
    assert.equal(p({ rhythm: { avgChars: 1e9 } }).rhythm.avgChars, 1000)
    assert.equal(p({ rhythm: { avgChars: '12' } }).rhythm.avgChars, null)
    assert.deepEqual(p({ rhythm: { tempo: 'warp', phrasing: 'zigzag', short: 'yes' } }).rhythm, EMPTY_PROFILE.rhythm)
    assert.deepEqual(p({ rhythm: { tempo: 'slow', phrasing: 'flowing', short: true, avgChars: 8 } }).rhythm, { avgChars: 8, short: true, tempo: 'slow', phrasing: 'flowing' })
  })
})

describe('sanitizeOptions', () => {
  test('모르는 값은 기본값(친구 톡·중간맛)으로', () => {
    for (const raw of [undefined, null, 'x', [], { situation: 'nope', spice: 9, topic: {} }]) assert.deepEqual(sanitizeOptions(raw), { situation: 'chat', spice: 'medium', topic: '' })
    assert.deepEqual(sanitizeOptions({ situation: 'talk', spice: 'hot', topic: '떡볶이' }), { situation: 'talk', spice: 'hot', topic: '떡볶이' })
  })

  test('넣고 싶은 말은 다듬고 20자로 자른다', () => {
    const topic = (value) => sanitizeOptions({ topic: value }).topic
    assert.equal(topic('  떡볶이  '), '떡볶이')
    assert.equal(topic('#떡볶이!!'), '떡볶이')
    assert.equal(topic('떡볶이ㅋㅋㅋ'), '떡볶이')
    assert.equal(topic('{X}떡볶이'), 'X 떡볶이')
    assert.equal(topic('떡\n볶\u0000이'), '떡 볶이')
    assert.equal(topic('가'.repeat(50)), '가'.repeat(20))
    assert.equal(topic('!!! ~~'), '')
    assert.equal(topic(12345), '')
    assert.equal(topic('C++'), 'C++')
  })
})

describe('sanitizeFeedback', () => {
  test('엉터리 입력은 빈 요약으로', () => {
    const empty = { liked: [], disliked: [], techniqueStats: {}, shown: [] }
    for (const raw of [undefined, null, 'y', 3, [], { liked: 'x', disliked: 5, techniqueStats: [], shown: {} }]) assert.deepEqual(sanitizeFeedback(raw), empty)
  })

  test('최근 것(앞쪽)부터 정해진 개수만 남긴다', () => {
    const texts = Array.from({ length: 50 }, (_, i) => `문구 ${i}`)
    const f = sanitizeFeedback({ liked: texts.map((text) => ({ text, technique: 'ending' })), disliked: texts.map((text) => ({ text, technique: 'nope' })), shown: texts })
    assert.equal(f.liked.length, LIMITS.feedback.liked)
    assert.deepEqual(f.liked[0], { text: '문구 0', technique: 'ending' })
    assert.equal(f.disliked.length, LIMITS.feedback.disliked)
    assert.deepEqual(f.disliked[0], { text: '문구 0', technique: '' })
    assert.equal(f.shown.length, LIMITS.feedback.shown)
    assert.equal(f.shown[0], '문구 0')
  })

  test('문구는 다듬고, 빈 것·겹치는 것은 버린다', () => {
    const f = sanitizeFeedback({
      liked: [{ text: '  오히려 좋거든\n' }, { text: '오히려 좋거든', technique: 'ending' }, { text: '' }, null, 7, { technique: 'ending' }, '문자열만 온 문구'],
      shown: ['가'.repeat(80), '가'.repeat(80), 3, null, ' 둘 '],
    })
    assert.deepEqual(f.liked, [
      { text: '오히려 좋거든', technique: '' },
      { text: '문자열만 온 문구', technique: '' },
    ])
    assert.deepEqual(f.shown, ['가'.repeat(48), '둘'])
  })

  test('방식별 반응 수는 아는 방식의 0 이상 정수만, 9999까지', () => {
    const stats = sanitizeFeedback({
      techniqueStats: {
        ending: { up: 3, down: 1 },
        filler: { up: 123456, down: 0 },
        slot: { up: -1, down: 2 },
        blend: { up: 1.5, down: 2 },
        rhythm: { up: '3', down: 2 },
        twist: { up: 2 },
        hack: { up: 1, down: 1 },
        __proto__: { up: 1, down: 1 },
      },
    }).techniqueStats
    assert.deepEqual(stats, { ending: { up: 3, down: 1 }, filler: { up: 9999, down: 0 } })
    assert.deepEqual(Object.keys(sanitizeFeedback({ techniqueStats: Object.fromEntries(TECHNIQUE_IDS.map((id) => [id, { up: 1, down: 1 }])) }).techniqueStats), [...TECHNIQUE_IDS])
  })
})

describe('sanitizeCustomTrend', () => {
  test('키워드와 뜻을 다듬어 자른다', () => {
    assert.deepEqual(sanitizeCustomTrend({ keyword: '  #주말 등산!! ', meaning: ' 주말마다\n산에 가는 것 ' }), { keyword: '주말 등산', meaning: '주말마다 산에 가는 것' })
    const long = sanitizeCustomTrend({ keyword: '가'.repeat(100), meaning: '나'.repeat(500) })
    assert.equal(long.keyword, '가'.repeat(LIMITS.customTrend.keywordMaxChars))
    assert.equal(long.meaning, '나'.repeat(LIMITS.customTrend.meaningMaxChars))
    assert.deepEqual(sanitizeCustomTrend({ keyword: '{X}첫눈', meaning: 5 }), { keyword: 'X 첫눈', meaning: '' })
    assert.deepEqual(sanitizeCustomTrend({ keyword: 'ㅇㅈ' }), { keyword: 'ㅇㅈ', meaning: '' }, '초성 밈도 키워드가 될 수 있다')
  })

  test('키워드가 비어 있으면 TypeError', () => {
    for (const raw of [undefined, null, 'x', {}, { keyword: '   ' }, { keyword: 12345 }, { keyword: '!!!' }, { keyword: '{}' }, { meaning: '뜻만 있음' }]) {
      assert.throws(() => sanitizeCustomTrend(raw), { name: 'TypeError', message: '트렌드 키워드를 입력해 주세요.' })
    }
  })
})

describe('글 다듬기 도우미', () => {
  test('cleanText는 한 줄로 만들고 코드 포인트 기준으로 자른다', () => {
    assert.equal(cleanText('  가\r\n나\t다  ', 10), '가 나 다')
    assert.equal(cleanText('😂😂😂😂', 2), '😂😂')
    assert.equal(cleanText('가나다 라마', 4), '가나다')
    for (const value of [null, undefined, 3, {}, []]) assert.equal(cleanText(value, 10), '')
    assert.equal(cleanText('x'.repeat(100_000), 5), 'xxxxx')
    assert.equal(cleanSlotWord('ㅋㅋㅋ', 10), '')
  })

  test('textKey는 대소문자·공백·말끝 꾸밈이 달라도 같은 열쇠를 낸다', () => {
    const key = textKey('오히려 좋거든')
    for (const variant of ['오히려좋거든', ' 오히려  좋거든 ', '오히려 좋거든 ㅋㅋㅋ', '오히려 좋거든~!!', '오히려 좋거든 😂']) assert.equal(textKey(variant), key, variant)
    assert.notEqual(textKey('오히려. 좋거든.'), key)
    assert.equal(textKey('OK 좋아'), textKey('ok 좋아'))
    assert.equal(textKey('ㅋㅋㅋ'), 'ㅋㅋㅋ', '꾸밈뿐인 글은 통째로 열쇠가 된다')
    assert.equal(textKey(null), '')
  })
})

// ── 프롬프트 ──────────────────────────────────────────────

/** 스키마의 모든 객체가 additionalProperties:false이고 모든 속성이 required인지 */
function assertStrict(schema, path = 'schema') {
  if (schema.type === 'object') {
    assert.equal(schema.additionalProperties, false, `${path}: additionalProperties`)
    assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort(), `${path}: required`)
    for (const [key, child] of Object.entries(schema.properties)) assertStrict(child, `${path}.${key}`)
  }
  if (schema.type === 'array') assertStrict(schema.items, `${path}[]`)
}

describe('프롬프트', () => {
  const trend = seed.find((t) => t.id === 'seed-mot-chamji')
  const request = (extra = {}) => buildGenerationRequest({ profile: PROFILE, trend, options: { situation: 'sns', spice: 'hot', topic: '떡볶이' }, feedback: {}, count: 8, ...extra })

  test('응답 스키마: 모든 객체가 닫혀 있고 모든 속성이 필수다', () => {
    assertStrict(GENERATION_SCHEMA)
    assertStrict(SAFETY_SCHEMA)
    const candidate = GENERATION_SCHEMA.properties.candidates.items
    assert.deepEqual(Object.keys(candidate.properties), ['text', 'examples', 'technique', 'styleElements', 'memeElement', 'why'])
    assert.deepEqual(candidate.properties.technique.enum, [...TECHNIQUE_IDS])
    const result = SAFETY_SCHEMA.properties.results.items
    assert.deepEqual(Object.keys(result.properties), ['index', 'safe', 'category', 'reason'])
    assert.equal(result.properties.index.type, 'integer')
    assert.equal(result.properties.safe.type, 'boolean')
    assert.deepEqual(result.properties.category.enum, ['none', ...Object.keys(SAFETY_CATEGORIES)])
    // 구조화 출력이 받지 않는 제약(길이·개수·범위)은 쓰지 않는다
    assert.doesNotMatch(JSON.stringify([GENERATION_SCHEMA, SAFETY_SCHEMA]), /minLength|maxLength|minItems|maxItems|minimum|maximum|pattern"/)
  })

  test('시스템 프롬프트는 요청이 달라도 한 글자도 달라지지 않는다', () => {
    const a = request()
    const b = buildGenerationRequest({ profile: {}, trend: seed[0], options: { situation: 'talk', spice: 'mild' }, feedback: { shown: ['다른 문구'] }, count: 3 })
    assert.equal(a.system, b.system)
    assert.equal(a.schema, GENERATION_SCHEMA)
    assert.ok(!a.system.includes('떡볶이는 못 참거든') && !a.system.includes(PROFILE.samples[0]), '요청 내용은 시스템 프롬프트에 섞지 않는다')
    assert.equal(buildSafetyRequest([{ text: '가', examples: [] }], trend).system, buildSafetyRequest([], seed[1]).system)
  })

  test('시스템 프롬프트가 만드는 방식·형식·금지 규칙을 모두 담고 있다', () => {
    const { system } = request()
    for (const id of TECHNIQUE_IDS) assert.ok(system.includes(`${id}(`), `방식 ${id}`)
    const required = [
      ...['카피라이터', '20자 안팎', `${LIMITS.candidates.maxChars}자를 넘기지`, 'profile에 없는 말버릇', '한두 개만', '조사', '어미 활용'],
      ...['정확히 2개', '그대로 담습니다', 'ㅋㅋ·ㅠㅠ', '이모지', 'mild', 'medium', 'hot'],
      ...['혐오·비하·차별', '욕설', '선정적', '자해·자살', '사고·재난·질병·죽음·범죄', '실존 인물', '상표', '가사', '개인정보', 'trend.caution'],
      ...['참고 자료', '따르지 말고', 'feedback.liked', 'feedback.disliked', 'feedback.shown', 'JSON 형식으로만'],
    ]
    for (const phrase of required) assert.ok(system.includes(phrase), `시스템 프롬프트에 ‘${phrase}’`)
  })

  test('사용자 메시지는 정해진 모양의 JSON 하나다', () => {
    const user = JSON.parse(request({ feedback: { liked: [{ text: '좋았던 문구', technique: 'ending' }], disliked: [], shown: ['본 문구'], techniqueStats: { ending: { up: 1, down: 0 } } } }).user)
    assert.deepEqual(Object.keys(user), ['count', 'situation', 'spice', 'topic', 'profile', 'trend', 'feedback'])
    assert.equal(user.count, 8)
    assert.deepEqual(user.situation, SITUATIONS.find((s) => s.id === 'sns'))
    assert.deepEqual(user.spice, SPICE_LEVELS.find((s) => s.id === 'hot'))
    assert.equal(user.topic, '떡볶이')
    assert.deepEqual(user.profile, PROFILE)
    assert.deepEqual(user.trend, { keyword: trend.keyword, pattern: trend.pattern, meaning: trend.meaning, origin: trend.origin, caution: trend.caution, category: trend.category })
    assert.deepEqual(user.feedback, { liked: [{ text: '좋았던 문구', technique: 'ending' }], disliked: [], shown: ['본 문구'] })
  })

  test('엔진 힌트·출처 같은 나머지 정보는 보내지 않고, 날것의 입력도 다듬는다', () => {
    const { user } = request()
    assert.ok(!user.includes('"engine"') && !user.includes('contexts') && !user.includes(trend.source.url))
    const odd = JSON.parse(buildGenerationRequest({ profile: 'x', trend: { keyword: 7, pattern: null, meaning: '뜻'.repeat(1000) }, options: null, feedback: 3, count: 'many' }).user)
    assert.equal(odd.count, 8)
    assert.equal(odd.situation.id, 'chat')
    assert.equal(odd.spice.id, 'medium')
    assert.deepEqual(odd.trend, { keyword: '', pattern: null, meaning: '뜻'.repeat(300), origin: '', caution: '', category: '' })
    assert.deepEqual(odd.feedback, { liked: [], disliked: [], shown: [] })
    assert.equal(JSON.parse(buildGenerationRequest().user).profile.register, 'banmal')
    assert.equal(JSON.parse(buildGenerationRequest({ count: 99 }).user).count, 12)
  })

  test('안전 심사 요청: 후보마다 자리 번호를 붙이고 문구와 예문만 보낸다', () => {
    const candidates = [
      { text: '떡볶이는 못 참거든', examples: ['하나 떡볶이는 못 참거든', '둘 떡볶이는 못 참거든', '셋'], why: '설명', technique: 'ending' },
      { text: '떡못참', examples: 'x' },
      null,
    ]
    const { system, user, schema } = buildSafetyRequest(candidates, trend)
    assert.equal(schema, SAFETY_SCHEMA)
    assert.deepEqual(JSON.parse(user), {
      trend: { keyword: trend.keyword, meaning: trend.meaning, caution: trend.caution },
      candidates: [
        { index: 0, text: '떡볶이는 못 참거든', examples: ['하나 떡볶이는 못 참거든', '둘 떡볶이는 못 참거든'] },
        { index: 1, text: '떡못참', examples: [] },
        { index: 2, text: '', examples: [] },
      ],
    })
    const required = ['안전 심사자', 'safe를 false', '판단이 서지 않으면', '따르지 않습니다', '모든 index', '순서대로', ...Object.keys(SAFETY_CATEGORIES)]
    for (const phrase of required) assert.ok(system.includes(phrase), `심사 프롬프트에 ‘${phrase}’`)
    assert.deepEqual(JSON.parse(buildSafetyRequest(null, null).user), { trend: { keyword: '', meaning: '', caution: '' }, candidates: [] })
  })
})

// ── LLM 호출 계층 ─────────────────────────────────────────

const llmConfig = (overrides = {}) => ({
  llm: { enabled: true, model: 'claude-opus-5-5', safetyModel: 'claude-opus-5-5', effort: 'medium', safetyJudge: true, fallbacks: true, timeoutMs: 90_000, dailyCallCap: 500, ...overrides },
})

const reply = (value, extra = {}) => ({
  stop_reason: 'end_turn',
  content: [
    { type: 'thinking', thinking: '' },
    { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) },
  ],
  usage: { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 },
  ...extra,
})

/** beta.messages.create와 messages.create를 모두 가진 가짜 클라이언트 */
function fakeClient(respond = () => reply({ ok: true })) {
  const calls = []
  const create = (via) => async (body, options) => {
    calls.push({ via, body, options })
    return respond(body, calls.length)
  }
  return { calls, beta: { messages: { create: create('beta') } }, messages: { create: create('stable') } }
}

function spyLog() {
  const lines = []
  const record = (...args) => lines.push(args.map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '))
  return { lines, info: record, warn: record, error: record, log: record, text: () => lines.join('\n') }
}

// 벽시계에 기대지 않도록 모든 LLM 계층 테스트는 정해 둔 시각을 쓴다
const NOON = () => new Date(2026, 10, 11, 12, 0, 0).getTime()

async function readyLlm({ config = llmConfig(), client = fakeClient(), log = spyLog(), now = NOON } = {}) {
  const llm = createLlm({ config, log, clientFactory: () => client, now })
  await llm.ready()
  return { llm, client, log }
}

const sdkError = (ErrorClass, status) => new ErrorClass(status, { type: 'error', error: { type: 'some_error', message: 'sk-ant-secret 요청 본문 일부' } }, 'sk-ant-secret 요청 본문 일부', new Headers())
const SYSTEM = '시스템 프롬프트'
const USER = '{"profile":"비밀스러운 프로필 내용"}'
const SCHEMA = { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } }
const ask = (llm, extra = {}) => llm.generateJson({ system: SYSTEM, user: USER, schema: SCHEMA, ...extra })
const rejectsWith = (promise, kind) => assert.rejects(promise, (err) => err instanceof LlmError && err.kind === kind && !/비밀|sk-ant/.test(err.message))

describe('LLM 호출 계층 (llm.js)', () => {
  test('꺼져 있으면 SDK도 클라이언트도 건드리지 않는다', async () => {
    let made = 0
    const llm = createLlm({ config: llmConfig({ enabled: false }), log: spyLog(), now: NOON, clientFactory: () => (made++, fakeClient()) })
    await llm.ready()
    assert.equal(llm.available(), false)
    assert.deepEqual(llm.status(), { enabled: false, available: false, model: 'claude-opus-5-5', reason: '사용 안 함', callsToday: 0, dailyCap: 500 })
    await rejectsWith(ask(llm), 'disabled')
    assert.equal(made, 0)
    for (const config of [undefined, null, {}, { llm: null }]) assert.equal(createLlm({ config, log: spyLog(), now: NOON }).available(), false)
  })

  test('켜져 있으면 준비가 끝난 뒤부터 쓸 수 있다', async () => {
    const llm = createLlm({ config: llmConfig(), log: spyLog(), now: NOON, clientFactory: () => fakeClient() })
    assert.equal(llm.available(), false)
    assert.equal(llm.status().reason, '준비 중')
    await llm.ready()
    assert.equal(llm.available(), true)
    assert.deepEqual(llm.status(), { enabled: true, available: true, model: 'claude-opus-5-5', reason: null, callsToday: 0, dailyCap: 500 })
  })

  test('클라이언트를 만들지 못하면 쓸 수 없는 상태로 남는다', async () => {
    for (const clientFactory of [() => null, () => { throw new Error('자격 증명 없음') }]) {
      const llm = createLlm({ config: llmConfig(), log: spyLog(), now: NOON, clientFactory })
      await llm.ready()
      assert.equal(llm.available(), false)
      assert.equal(llm.status().reason, 'AI 엔진을 불러오지 못함')
      await rejectsWith(ask(llm), 'unavailable')
    }
  })

  test('요청 모양: 베타 메시지 API + 서버 측 대체 + 적응형 사고 + JSON 스키마 + 캐시 지점', async () => {
    const { llm, client } = await readyLlm()
    assert.deepEqual(await ask(llm), { ok: true })
    assert.equal(client.calls.length, 1)
    const [{ via, body, options }] = client.calls
    assert.equal(via, 'beta')
    assert.deepEqual(body, {
      model: 'claude-opus-5-5',
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: USER }],
    })
    assert.deepEqual(options, { timeout: 90_000, maxRetries: 1 })
  })

  test('대체를 끄면 일반 메시지 API로, betas와 fallbacks 없이 보낸다', async () => {
    const { llm, client } = await readyLlm({ config: llmConfig({ fallbacks: false, timeoutMs: 5000 }) })
    await ask(llm)
    const [{ via, body, options }] = client.calls
    assert.equal(via, 'stable')
    assert.deepEqual(Object.keys(body).sort(), ['max_tokens', 'messages', 'model', 'output_config', 'system', 'thinking'])
    assert.deepEqual(options, { timeout: 5000, maxRetries: 1 })
  })

  test('보내면 안 되는 값은 어떤 경우에도 보내지 않는다', async () => {
    const { llm, client } = await readyLlm()
    await ask(llm, { temperature: 0.2, top_p: 1, top_k: 5, budget_tokens: 1000, tool_choice: { type: 'any' }, tools: [{}] })
    const sent = JSON.stringify(client.calls[0].body)
    assert.doesNotMatch(sent, /temperature|top_p|top_k|budget_tokens|tool_choice|"tools"|"assistant"/)
    assert.deepEqual(client.calls[0].body.thinking, { type: 'adaptive' })
  })

  test('노력 수준·모델·토큰 한도는 요청마다 바꿀 수 있고, 이상한 값은 기본값으로', async () => {
    const { llm, client } = await readyLlm()
    await ask(llm, { effort: 'low', model: 'claude-haiku-5-5', maxTokens: 2000, purpose: 'safety' })
    await ask(llm, { effort: 'turbo', maxTokens: -5 })
    await ask(llm, { maxTokens: 10_000_000, effort: undefined, model: undefined })
    const bodies = client.calls.map((call) => call.body)
    assert.deepEqual([bodies[0].model, bodies[0].max_tokens, bodies[0].output_config.effort], ['claude-haiku-5-5', 2000, 'low'])
    assert.deepEqual([bodies[1].model, bodies[1].max_tokens, bodies[1].output_config.effort], ['claude-opus-5-5', 16000, 'medium'])
    assert.deepEqual([bodies[2].model, bodies[2].max_tokens, bodies[2].output_config.effort], ['claude-opus-5-5', 32000, 'medium'])
  })

  test('user 대신 사용자 턴 목록(messages)을 받아도 되지만, 어시스턴트 턴은 받지 않는다', async () => {
    const { llm, client } = await readyLlm()
    await llm.generateJson({ system: SYSTEM, messages: [{ role: 'user', content: '하나', extra: 1 }, { role: 'user', content: '둘' }], schema: SCHEMA })
    assert.deepEqual(client.calls[0].body.messages, [{ role: 'user', content: '하나' }, { role: 'user', content: '둘' }])
    await rejectsWith(llm.generateJson({ system: SYSTEM, messages: [{ role: 'user', content: '질문' }, { role: 'assistant', content: '{' }], schema: SCHEMA }), 'bad_request')
    await rejectsWith(llm.generateJson({ system: SYSTEM, messages: [], schema: SCHEMA }), 'bad_request')
    assert.equal(client.calls.length, 1)
  })

  test('형식이 어긋난 요청은 보내지 않고, 호출 수에도 넣지 않는다', async () => {
    const { llm, client } = await readyLlm()
    const malformed = [
      undefined,
      null,
      {},
      { system: SYSTEM, user: USER },
      { system: '', user: USER, schema: SCHEMA },
      { system: SYSTEM, user: 7, schema: SCHEMA },
      { system: SYSTEM, user: USER, schema: 'x' },
      { system: SYSTEM, user: USER, schema: SCHEMA, model: '' },
    ]
    for (const request of malformed) await rejectsWith(llm.generateJson(request), 'bad_request')
    assert.equal(client.calls.length, 0)
    assert.equal(llm.status().callsToday, 0)
  })

  test('종료 사유를 먼저 본다: 거절과 잘린 응답은 내용이 멀쩡해 보여도 쓰지 않는다', async () => {
    const refused = await readyLlm({ client: fakeClient(() => reply({ ok: true }, { stop_reason: 'refusal', stop_details: { type: 'refusal', category: null } })) })
    await rejectsWith(ask(refused.llm), 'refusal')
    const cut = await readyLlm({ client: fakeClient(() => reply({ ok: true }, { stop_reason: 'max_tokens' })) })
    await rejectsWith(ask(cut.llm), 'max_tokens')
    assert.equal(refused.llm.available(), true, '거절은 한 번의 실패일 뿐이다')
  })

  test('글 블록만 이어 붙여 JSON으로 읽는다', async () => {
    const content = [
      { type: 'thinking', thinking: '{"ok":false}' },
      { type: 'text', text: '{"ok":' },
      { type: 'fallback', from: {}, to: {} },
      { type: 'text', text: 'true}' },
    ]
    const split = { stop_reason: 'end_turn', content, usage: {} }
    assert.deepEqual(await ask((await readyLlm({ client: fakeClient(() => split) })).llm), { ok: true })
    const unreadable = [reply('JSON이 아님'), reply('"문자열"'), reply('null'), { stop_reason: 'end_turn', content: [] }, { stop_reason: 'end_turn' }, null, undefined, 'x']
    for (const broken of unreadable) await rejectsWith(ask((await readyLlm({ client: fakeClient(() => broken) })).llm), 'bad_json')
  })

  test('SDK 오류 종류를 가려 알리고, 자세한 내용은 밖으로 내지 않는다', async () => {
    const cases = [
      [sdkError(Anthropic.RateLimitError, 429), 'rate_limit'],
      [sdkError(Anthropic.BadRequestError, 400), 'bad_request'],
      [new Anthropic.APIConnectionError({ message: 'sk-ant-secret 연결 실패' }), 'network'],
      [new Anthropic.APIConnectionTimeoutError(), 'network'],
      [sdkError(Anthropic.InternalServerError, 500), 'api'],
      [sdkError(Anthropic.NotFoundError, 404), 'api'],
      [new Error('sk-ant-secret 알 수 없는 오류'), 'api'],
      [new TypeError('비밀'), 'api'],
    ]
    for (const [error, kind] of cases) {
      const { llm, log } = await readyLlm({ client: fakeClient(() => Promise.reject(error)) })
      await rejectsWith(ask(llm), kind)
      assert.equal(llm.available(), true, `${kind}: 다음 요청은 다시 시도할 수 있다`)
      assert.match(log.text(), new RegExp(`실패\\(${kind}\\)`))
      assert.doesNotMatch(log.text(), /비밀|sk-ant|요청 본문/)
    }
  })

  test('인증·권한 오류가 나면 다시 띄울 때까지 쓰지 않는다', async () => {
    for (const error of [sdkError(Anthropic.AuthenticationError, 401), sdkError(Anthropic.PermissionDeniedError, 403)]) {
      const { llm, client } = await readyLlm({ client: fakeClient(() => Promise.reject(error)) })
      await rejectsWith(ask(llm), 'auth')
      assert.equal(llm.available(), false)
      assert.equal(llm.status().reason, '인증 실패')
      await rejectsWith(ask(llm), 'auth')
      assert.equal(client.calls.length, 1, '두 번째부터는 호출하지 않는다')
    }
  })

  test('기록에는 용도·모델·걸린 시간·토큰 수만 남는다', async () => {
    let clock = 1_000
    const { llm, log } = await readyLlm({ now: () => (clock += 250) })
    await ask(llm, { purpose: 'safety', model: 'claude-haiku-5-5' })
    await ask(llm, { purpose: '비밀스러운 용도 {"x":1}' })
    assert.equal(log.lines.length, 2)
    assert.match(log.lines[0], /^\[llm\] safety claude-haiku-5-5 완료 \d+ms input_tokens=1200 output_tokens=340 cache_read_input_tokens=1000 cache_creation_input_tokens=0$/)
    assert.match(log.lines[1], /^\[llm\] other claude-opus-5-5 완료 /)
    assert.doesNotMatch(log.text(), /비밀|시스템 프롬프트|profile/)
  })

  test('하루 호출 한도: 넘으면 쓸 수 없고, 날이 바뀌면 다시 센다', async () => {
    let clock = new Date(2026, 10, 11, 9, 0, 0).getTime()
    const { llm, client } = await readyLlm({ config: llmConfig({ dailyCallCap: 2 }), now: () => clock })
    await ask(llm)
    await ask(llm)
    assert.equal(llm.available(), false)
    assert.deepEqual([llm.status().callsToday, llm.status().dailyCap, llm.status().reason], [2, 2, '일일 호출 한도 도달'])
    await rejectsWith(ask(llm), 'daily_cap')
    assert.equal(client.calls.length, 2)
    clock = new Date(2026, 10, 11, 23, 59, 59).getTime()
    assert.equal(llm.available(), false)
    clock = new Date(2026, 10, 12, 0, 0, 1).getTime()
    assert.equal(llm.available(), true)
    assert.equal(llm.status().callsToday, 0)
    await ask(llm)
    assert.equal(client.calls.length, 3)
    // 실패한 호출도 호출로 센다
    const failing = await readyLlm({ config: llmConfig({ dailyCallCap: 1 }), client: fakeClient(() => Promise.reject(new Error('x'))) })
    await rejectsWith(ask(failing.llm), 'api')
    await rejectsWith(ask(failing.llm), 'daily_cap')
    assert.equal((await readyLlm({ config: llmConfig({ dailyCallCap: 0 }) })).llm.available(), false)
  })

  test('실제 SDK를 불러와 클라이언트를 만들 수 있다 (네트워크 호출 없이)', async () => {
    let received = null
    const llm = createLlm({ config: llmConfig(), log: spyLog(), now: NOON, clientFactory: (sdk) => ((received = sdk), fakeClient()) })
    await llm.ready()
    assert.equal(received, Anthropic)
  })
})

// ── 전체 흐름 ─────────────────────────────────────────────

const BAD = '나쁜말'

/** ‘나쁜말’이 들어간 글만 막는 가짜 안전 필터 */
function fakeSafety(categories = ['profanity']) {
  const calls = []
  const verdict = (text) => (String(text).includes(BAD) ? { ok: false, level: 'block', categories } : { ok: true, level: 'ok', categories: [] })
  return {
    calls,
    checkText(text, options) {
      calls.push({ text, context: options?.context })
      return verdict(text)
    },
    checkCandidate: (candidate) => verdict([candidate.text, ...candidate.examples].join(' ')),
    filterStyleTerms: (terms) => terms.filter((term) => verdict(term).ok),
  }
}

function fakeStore(extra = []) {
  const trends = [...seed.map((trend) => ({ ...trend, status: 'approved', sample: true, collectedAt: null, publishedAt: null })), ...extra]
  return { trends, get: (id) => trends.find((trend) => trend.id === id) ?? null, frames: () => trends.filter((trend) => trend.engine?.asFrame === true) }
}

const llmCandidate = (text, extra = {}) => ({
  text,
  examples: [`하나 ${text}`, `둘 ${text}`],
  technique: 'ending',
  styleElements: ['어미 ~거든'],
  memeElement: '오히려 좋아',
  why: 'AI가 만들었어요.',
  ...extra,
})
const LLM_TEXTS = ['오히려 좋거든', '아니 오히려 좋잖아', '오히려 좋은 날이네', '오좋 그 자체', '오히려. 좋아. 진짜.', '이쯤 되면 오히려 좋지']
const TECHNIQUES_ROUND = ['ending', 'filler', 'slot', 'blend', 'rhythm', 'twist']
const allSafe = (request) => ({ results: JSON.parse(request.user).candidates.map(({ index }) => ({ index, safe: true, category: 'none', reason: '' })) })

/** 생성 요청과 심사 요청에 따로 답하는 가짜 LLM */
function fakeLlm({ available = true, generate = () => ({ candidates: LLM_TEXTS.map((text, i) => llmCandidate(text, { technique: TECHNIQUES_ROUND[i] })) }), judge = allSafe } = {}) {
  const calls = []
  return {
    calls,
    available: () => available,
    async generateJson(request) {
      calls.push(request)
      return request.purpose === 'safety' ? judge(request) : generate(request)
    },
  }
}

function setup({ llm = null, safety = fakeSafety(), store = fakeStore(), config = llmConfig(), log = spyLog() } = {}) {
  let ids = 0
  const generator = createGenerator({ config, llm, safety, trendStore: store, log, now: () => Date.UTC(2026, 10, 11, 3, 4, 5), newId: () => `req-${++ids}` })
  return { generator, llm, safety, store, log }
}

const INPUT = { profile: PROFILE, trendId: 'seed-ohiryeo-joa', options: { situation: 'chat', spice: 'medium', topic: '' }, feedback: {} }

describe('생성 흐름 (engine.js): 기본 엔진', () => {
  test('LLM이 없으면 규칙 엔진으로 만든다', async () => {
    for (const llm of [null, undefined, fakeLlm({ available: false })]) {
      const { generator } = setup({ llm })
      const result = await generator.generate(INPUT)
      assert.deepEqual(result.engine, { mode: 'local', label: '기본 엔진(규칙 기반)', model: null, fallbackReason: null })
      assert.equal(result.candidates.length, LIMITS.candidates.count)
      assert.ok(result.candidates.every((c) => c.engine === 'local'))
      assert.equal(result.safety.judge, 'rules')
      assert.equal(result.safety.blocked, 0)
      assert.ok(result.safety.generated >= 5 && result.safety.passed === result.safety.generated)
      if (llm) assert.equal(llm.calls.length, 0)
    }
  })

  test('결과 모양', async () => {
    const { generator, store } = setup()
    const result = await generator.generate(INPUT)
    assert.deepEqual(Object.keys(result), ['requestId', 'engine', 'candidates', 'safety', 'trend', 'createdAt'])
    assert.equal(result.requestId, 'req-1')
    assert.equal(result.createdAt, '2026-11-11T03:04:05.000Z')
    assert.deepEqual(Object.keys(result.safety), ['generated', 'blocked', 'passed', 'judge'])
    result.candidates.forEach((c, i) => {
      assert.deepEqual(Object.keys(c), ['id', 'text', 'examples', 'technique', 'styleElements', 'memeElement', 'why', 'score', 'engine'])
      assert.equal(c.id, `req-1-${i + 1}`)
      assert.ok(c.text && charLength(c.text) <= 48)
      assert.equal(c.examples.length, LIMITS.candidates.examplesPerCandidate)
      assert.ok(TECHNIQUE_IDS.includes(c.technique))
      assert.ok(c.score >= 0 && c.score <= 1)
    })
    assert.equal(new Set(result.candidates.map((c) => c.text)).size, result.candidates.length)
    // 엔진 힌트는 브라우저로 보내지 않는다 — 저장소의 원본은 그대로 둔다
    const original = store.get('seed-ohiryeo-joa')
    assert.ok(!('engine' in result.trend))
    assert.ok(original.engine)
    const expected = { ...original }
    delete expected.engine
    assert.deepEqual(result.trend, expected)
  })

  test('요청 본문이 엉망이어도 다듬어서 만든다', async () => {
    const { generator } = setup()
    const result = await generator.generate({
      profile: { endings: [{}, null, 1], samples: 'no' },
      trendId: 'seed-ttalkkak',
      options: { situation: 'nope', spice: 9, topic: {} },
      feedback: { liked: 'x', techniqueStats: [] },
    })
    assert.ok(result.candidates.length >= 3)
    const sparse = await generator.generate({ trendId: 'seed-yareu' })
    assert.ok(sparse.candidates.length >= 3)
  })

  test('이미 보여 준 문구는 다시 내지 않는다', async () => {
    const { generator } = setup()
    const first = await generator.generate(INPUT)
    const shown = first.candidates.map((c) => c.text)
    const second = await generator.generate({ ...INPUT, feedback: { shown } })
    assert.equal(second.candidates.length, LIMITS.candidates.count)
    assert.ok(second.candidates.every((c) => !shown.includes(c.text)))
    assert.equal(second.requestId, 'req-2')
  })

  test('새로 보여 줄 문구가 바닥나면 빈손으로 돌려보내지 않고, 오래전에 보여 준 것부터 다시 꺼낸다', async () => {
    const { generator } = setup()
    const input = { profile: {}, trendId: 'seed-yareu', options: { situation: 'talk', spice: 'mild', topic: '떡볶이' } }
    let shown = []
    const sizes = []
    for (let round = 0; round < 8; round++) {
      const result = await generator.generate({ ...input, feedback: { shown } })
      sizes.push(result.candidates.length)
      const texts = result.candidates.map((c) => c.text)
      assert.ok(texts.length >= 3, `${round + 1}번째: ${texts.length}개`)
      assert.equal(new Set(texts).size, texts.length)
      if (shown.length) assert.ok(!texts.includes(shown[0]), `${round + 1}번째: 방금 본 문구가 또 나옴 — ${shown[0]}`)
      // 브라우저가 하듯이 최근 것을 앞에 쌓는다
      shown = [...texts, ...shown.filter((text) => !texts.includes(text))].slice(0, LIMITS.feedback.shown)
    }
    // 처음에는 아직 보여 준 것이 없으니 다양성 조건(같은 방식 2개, 닮은 문구 제외)이 허락하는 만큼 다 나온다.
    // ‘야르’ + 순한맛 + 빈 프로필은 재료가 적어(어미·비틀기·줄임 없음) 서로 닮은 후보가 빠지면 다섯이 안 될 수 있다
    assert.ok(sizes[0] >= 4 && sizes[0] <= LIMITS.candidates.count, `처음: ${sizes[0]}개`)
  })

  test('키워드형 트렌드는 틀로 쓸 수 있는 예시 트렌드를 빌려 만든다', async () => {
    const { generator } = setup()
    const result = await generator.generate({ ...INPUT, trendId: 'seed-season-bungeoppang' })
    assert.equal(result.candidates.length, LIMITS.candidates.count)
    assert.ok(result.candidates.every((c) => c.memeElement.endsWith('문형 + ‘붕어빵’')))
  })
})

describe('생성 흐름: 트렌드와 입력 검사', () => {
  test('없는 트렌드, 검수 전 트렌드, 트렌드 없는 요청은 trend_not_found', async () => {
    const pending = { id: 'yt-pending', keyword: '검수 전', kind: 'keyword', pattern: null, status: 'pending', sample: false }
    const rejected = { id: 'yt-rejected', keyword: '반려', kind: 'keyword', pattern: null, status: 'rejected', sample: false }
    const { generator } = setup({ store: fakeStore([pending, rejected]) })
    const withId = (trendId) => ({ ...INPUT, trendId })
    const missing = [
      ...['seed-does-not-exist', 'yt-pending', 'yt-rejected', 123, '', 'x'.repeat(500), ['seed-ohiryeo-joa']].map(withId),
      ...[{ profile: PROFILE }, {}, undefined, null, 'x'],
    ]
    const notFound = (err) => err instanceof GenerateError && err.code === 'trend_not_found' && Array.isArray(err.categories)
    for (const input of missing) await assert.rejects(generator.generate(input), notFound)
  })

  test('직접 입력한 트렌드로 만든다', async () => {
    const { generator, safety } = setup()
    const result = await generator.generate({ profile: PROFILE, customTrend: { keyword: ' 주말 등산 ', meaning: '주말마다 산에 가는 것' }, options: { situation: 'sns', spice: 'hot' } })
    assert.match(result.trend.id, /^custom-[0-9a-f]{10}$/)
    assert.deepEqual(result.trend, {
      id: result.trend.id,
      keyword: '주말 등산',
      kind: 'keyword',
      pattern: null,
      meaning: '주말마다 산에 가는 것',
      origin: '',
      caution: '',
      category: '일상',
      source: { type: 'custom', label: '직접 입력', url: null, title: null },
      stats: null,
      collectedAt: null,
      publishedAt: null,
      status: 'approved',
      sample: false,
      meaningVerified: false,
    })
    assert.ok(result.candidates.length >= 3)
    assert.ok(result.candidates.some((c) => c.text.includes('등산')))
    assert.deepEqual(safety.calls.slice(0, 2), [{ text: '주말 등산', context: 'trend' }, { text: '주말마다 산에 가는 것', context: 'trend' }])
  })

  test('checkCustomTrend: 통과하면 트렌드를, 막히면 범주만 돌려준다', async () => {
    const { generator } = setup({ safety: fakeSafety(['profanity', 'hate']) })
    const ok = await generator.checkCustomTrend({ keyword: '주말 등산', meaning: '' })
    assert.equal(ok.ok, true)
    assert.equal(ok.trend.keyword, '주말 등산')
    assert.equal(ok.trend.source.type, 'custom')
    assert.equal(ok.trend.engine, null)
    assert.equal((await generator.checkCustomTrend({ keyword: '주말 등산' })).trend.id, ok.trend.id, '같은 키워드는 같은 id')
    assert.deepEqual(await generator.checkCustomTrend({ keyword: `${BAD} 등산` }), { ok: false, categories: ['profanity', 'hate'] })
    assert.deepEqual(await generator.checkCustomTrend({ keyword: '등산', meaning: `뜻에 ${BAD}` }), { ok: false, categories: ['profanity', 'hate'] })
    for (const raw of [undefined, null, {}, { keyword: '   ' }, { keyword: 12345 }]) await assert.rejects(generator.checkCustomTrend(raw), TypeError)
  })

  test('막힌 직접 입력 트렌드와 넣고 싶은 말은 blocked_input — 걸린 낱말은 알려 주지 않는다', async () => {
    const { generator, safety, llm } = setup({ llm: fakeLlm(), safety: fakeSafety(['hate']) })
    const blocked = (err) => err instanceof GenerateError && err.code === 'blocked_input' && err.categories.join() === 'hate' && !err.message.includes(BAD)
    await assert.rejects(generator.generate({ profile: PROFILE, customTrend: { keyword: `${BAD}` } }), blocked)
    await assert.rejects(generator.generate({ ...INPUT, options: { topic: `${BAD}` } }), blocked)
    assert.ok(safety.calls.some((call) => call.context === 'input' && call.text === BAD), '넣고 싶은 말은 input 문맥으로 검사한다')
    assert.equal(llm.calls.length, 0, '막힌 요청은 LLM에 보내지 않는다')
    await assert.rejects(generator.generate({ profile: PROFILE, customTrend: { keyword: '  ' } }), TypeError)
  })

  test('안전 필터에 걸리는 말투 요소와 대표 문장은 프롬프트에 넣기 전에 뺀다', async () => {
    const dirty = {
      ...PROFILE,
      endings: ['거든', `${BAD}체`],
      fillers: [`아 ${BAD}`, '진짜'],
      expressions: ['대박', BAD],
      tail: { ...PROFILE.tail, emoticons: ['^^'], choseong: ['ㅇㅇ'] },
      samples: [`${BAD} 섞인 문장이야`, '멀쩡한 문장이야'],
    }
    const { generator, llm } = setup({ llm: fakeLlm() })
    const result = await generator.generate({ ...INPUT, profile: dirty })
    const sent = JSON.parse(llm.calls[0].user)
    assert.deepEqual(sent.profile.endings, ['거든'])
    assert.deepEqual(sent.profile.fillers, ['진짜'])
    assert.deepEqual(sent.profile.expressions, ['대박'])
    assert.deepEqual(sent.profile.samples, ['멀쩡한 문장이야'])
    assert.ok(!llm.calls.map((call) => call.user).join().includes(BAD))
    // 규칙 엔진으로 만들 때도 마찬가지
    const local = await setup().generator.generate({ ...INPUT, profile: { ...dirty, fillers: [BAD] } })
    assert.ok(!JSON.stringify([result, local]).includes(BAD))
  })
})

describe('생성 흐름: AI 엔진', () => {
  test('잘 되면 LLM 후보를 금칙어 필터와 AI 심사에 통과시켜 순위를 매긴다', async () => {
    const { generator, llm } = setup({ llm: fakeLlm(), config: llmConfig({ model: 'claude-opus-5-5', safetyModel: 'claude-haiku-5-5' }) })
    const result = await generator.generate(INPUT)
    assert.deepEqual(result.engine, { mode: 'llm', label: 'AI 엔진(Claude)', model: 'claude-opus-5-5', fallbackReason: null })
    assert.deepEqual(result.safety, { generated: 6, blocked: 0, passed: 6, judge: 'rules+llm' })
    assert.equal(result.candidates.length, LIMITS.candidates.count)
    assert.ok(result.candidates.every((c) => c.engine === 'llm' && LLM_TEXTS.includes(c.text)))
    assert.equal(llm.calls.length, 2)
    const [generation, judging] = llm.calls
    assert.equal(generation.purpose, undefined)
    assert.equal(JSON.parse(generation.user).count, 8)
    assert.equal(JSON.parse(generation.user).trend.keyword, '오히려 좋아')
    assert.deepEqual([judging.purpose, judging.effort, judging.model], ['safety', 'low', 'claude-haiku-5-5'])
    assert.deepEqual(JSON.parse(judging.user).candidates.map((c) => c.text), LLM_TEXTS)
  })

  test('LLM 응답은 믿지 않고 모양을 하나하나 맞춘다', async () => {
    const generate = () => ({
      candidates: [
        llmCandidate('  오히려\n좋거든  ', { technique: 'magic', examples: ['하나뿐인 예문'], styleElements: ['가'.repeat(60), 'b', 7, 'c', 'd', 'e'], memeElement: '', why: '설'.repeat(300) }),
        llmCandidate('예문 없는 후보', { examples: [] }),
        llmCandidate('예문 셋인 후보', { examples: ['하나', '', '둘', '셋'], technique: 'twist' }),
        llmCandidate('예문이 배열이 아닌 후보', { examples: '예문', styleElements: 'x', why: 9, memeElement: '밈'.repeat(100), technique: 'slot' }),
        llmCandidate('가'.repeat(49)),
        llmCandidate('{X}는 못 참지'),
        llmCandidate(''),
        { text: 12 },
        null,
        '문자열',
      ],
      extra: '무시',
    })
    const { generator } = setup({ llm: fakeLlm({ generate }) })
    const result = await generator.generate(INPUT)
    assert.equal(result.safety.generated, 4)
    const byText = Object.fromEntries(result.candidates.map((c) => [c.text, c]))
    assert.deepEqual(Object.keys(byText).sort(), ['예문 셋인 후보', '예문 없는 후보', '예문이 배열이 아닌 후보', '오히려 좋거든'])
    const first = byText['오히려 좋거든']
    assert.equal(first.technique, 'twist', '모르는 방식은 twist로')
    assert.deepEqual(first.examples, ['하나뿐인 예문', '하나뿐인 예문'])
    assert.deepEqual(first.styleElements, ['가'.repeat(24), 'b', 'c', 'd'], '요소는 네 개까지, 하나에 24자까지')
    assert.equal(first.memeElement, '{X}? 오히려 좋아', '밈 요소가 비면 트렌드의 문형으로')
    assert.equal(charLength(first.why), 120)
    assert.deepEqual(byText['예문 없는 후보'].examples, ['예문 없는 후보', '예문 없는 후보'])
    assert.deepEqual(byText['예문 셋인 후보'].examples, ['하나', '둘'])
    assert.deepEqual(byText['예문이 배열이 아닌 후보'].examples, ['예문이 배열이 아닌 후보', '예문이 배열이 아닌 후보'])
    assert.deepEqual(byText['예문이 배열이 아닌 후보'].styleElements, [])
    assert.equal(byText['예문이 배열이 아닌 후보'].why, '')
    assert.equal(charLength(byText['예문이 배열이 아닌 후보'].memeElement), 60)
    const wordy = () => ({ candidates: [llmCandidate('가나다', { examples: ['예'.repeat(500), '문'] }), llmCandidate('라마바'), llmCandidate('사아자')] })
    const long = await setup({ llm: fakeLlm({ generate: wordy }) }).generator.generate(INPUT)
    assert.equal(charLength(long.candidates.find((c) => c.text === '가나다').examples[0]), 120)
  })

  test('금칙어 필터에 걸린 LLM 후보는 심사에도 보내지 않는다', async () => {
    const generate = () => ({ candidates: [llmCandidate(`${BAD} 후보`), llmCandidate('예문이 문제', { examples: [`${BAD} 예문`, '둘'] }), ...LLM_TEXTS.slice(0, 4).map((text) => llmCandidate(text))] })
    const { generator, llm } = setup({ llm: fakeLlm({ generate }) })
    const result = await generator.generate(INPUT)
    assert.deepEqual(result.safety, { generated: 6, blocked: 2, passed: 4, judge: 'rules+llm' })
    assert.ok(!llm.calls[1].user.includes(BAD))
    assert.ok(!JSON.stringify(result.candidates).includes(BAD))
    assert.equal(result.engine.mode, 'llm')
  })

  test('AI 심사: 분명히 안전하다고 한 후보만 남긴다 (답이 없거나 엇갈리면 뺀다)', async () => {
    const judge = () => ({
      results: [
        { index: 0, safe: true, category: 'none', reason: '' },
        { index: 1, safe: false, category: 'hate', reason: '비하 표현' },
        // 2번은 답이 없다
        { index: 3, safe: 'true', category: 'none', reason: '' },
        { index: 4, safe: true, category: 'none', reason: '' },
        { index: 4, safe: false, category: 'other', reason: '엇갈린 답' },
        { index: 5, safe: true, category: 'none', reason: '' },
        { index: 99, safe: true, category: 'none', reason: '' },
        null,
      ],
    })
    const { generator } = setup({ llm: fakeLlm({ judge }) })
    const result = await generator.generate(INPUT)
    assert.equal(result.safety.judge, 'rules+llm')
    assert.equal(result.safety.blocked, 4)
    assert.equal(result.safety.passed, result.safety.generated - 4)
    assert.ok(result.safety.generated > 6, '둘만 살아남았으므로 규칙 엔진 후보를 보탰다')
    const llmTexts = result.candidates.filter((c) => c.engine === 'llm').map((c) => c.text)
    assert.deepEqual(llmTexts.sort(), [LLM_TEXTS[0], LLM_TEXTS[5]].sort())
    assert.deepEqual(result.candidates.slice(0, 2).map((c) => c.engine), ['llm', 'llm'], 'AI 엔진 후보를 먼저 싣는다')
  })

  test('LLM이 이미 보여 준 문구를 다시 내면 살아남은 것으로 치지 않는다', async () => {
    const shown = [...LLM_TEXTS.slice(0, 4).map((text) => `${text} ㅋㅋ`), '다른 문구']
    const { generator } = setup({ llm: fakeLlm() })
    const result = await generator.generate({ ...INPUT, feedback: { shown } })
    assert.deepEqual(result.candidates.filter((c) => c.engine === 'llm').map((c) => c.text).sort(), LLM_TEXTS.slice(4).sort())
    assert.equal(result.candidates.length, LIMITS.candidates.count)
    assert.ok(result.candidates.every((c) => !LLM_TEXTS.slice(0, 4).includes(c.text)))
    assert.equal(result.engine.mode, 'local')
  })

  test('살아남은 LLM 후보가 셋보다 적으면 규칙 엔진 후보로 채우고, 누가 만들었는지 표시한다', async () => {
    const two = fakeLlm({ generate: () => ({ candidates: LLM_TEXTS.slice(0, 2).map((text) => llmCandidate(text)) }) })
    const { generator } = setup({ llm: two })
    const topped = await generator.generate(INPUT)
    assert.equal(topped.candidates.length, LIMITS.candidates.count)
    assert.deepEqual(topped.candidates.filter((c) => c.engine === 'llm').map((c) => c.text).sort(), LLM_TEXTS.slice(0, 2).sort())
    assert.equal(topped.candidates.filter((c) => c.engine === 'local').length, 3)
    assert.deepEqual(topped.engine, { mode: 'local', label: '기본 엔진(규칙 기반)', model: null, fallbackReason: null }, 'LLM 후보가 절반이 안 되면 기본 엔진으로 표시')
    assert.equal(topped.safety.judge, 'rules+llm')
    assert.ok(topped.safety.generated > 2)
    assert.equal(new Set(topped.candidates.map((c) => c.text)).size, 5)

    // 랭킹이 같은 방식을 두 개까지만 고르므로 방식을 섞어 둔다
    const three = fakeLlm({ generate: () => ({ candidates: LLM_TEXTS.slice(0, 3).map((text, i) => llmCandidate(text, { technique: TECHNIQUES_ROUND[i] })) }) })
    const enough = await setup({ llm: three }).generator.generate(INPUT)
    assert.equal(enough.candidates.length, 3)
    assert.ok(enough.candidates.every((c) => c.engine === 'llm'))
    assert.equal(enough.engine.mode, 'llm')

    // 규칙 엔진이 같은 문구를 만들어도 겹쳐 내지 않는다
    const same = fakeLlm({ generate: () => ({ candidates: [llmCandidate('오히려 좋거든'), llmCandidate('오히려 좋잖아')] }) })
    const merged = await setup({ llm: same }).generator.generate({ ...INPUT, options: { situation: 'talk' } })
    assert.equal(merged.candidates.filter((c) => c.text === '오히려 좋거든').length, 1)
  })

  test('AI 심사를 끄면 금칙어 필터만 쓴다', async () => {
    const { generator, llm } = setup({ llm: fakeLlm(), config: llmConfig({ safetyJudge: false }) })
    const result = await generator.generate(INPUT)
    assert.equal(llm.calls.length, 1)
    assert.equal(result.safety.judge, 'rules')
    assert.equal(result.engine.mode, 'llm')
  })
})

describe('생성 흐름: AI 엔진이 실패했을 때', () => {
  const REASONS = {
    auth: 'AI 엔진 인증에 실패해 기본 엔진으로 만들었어요',
    rate_limit: 'AI 엔진 사용량 한도에 걸려 기본 엔진으로 만들었어요',
    daily_cap: 'AI 엔진 사용량 한도에 걸려 기본 엔진으로 만들었어요',
    refusal: 'AI 엔진이 이 요청을 거절해 기본 엔진으로 만들었어요',
    network: 'AI 엔진이 응답하지 않아 기본 엔진으로 만들었어요',
    api: 'AI 엔진이 응답하지 않아 기본 엔진으로 만들었어요',
    bad_request: 'AI 엔진이 응답하지 않아 기본 엔진으로 만들었어요',
    bad_json: 'AI 엔진이 응답하지 않아 기본 엔진으로 만들었어요',
    max_tokens: 'AI 엔진이 응답하지 않아 기본 엔진으로 만들었어요',
    unavailable: 'AI 엔진이 응답하지 않아 기본 엔진으로 만들었어요',
  }

  async function assertFallback(llm, reason) {
    const result = await setup({ llm }).generator.generate(INPUT)
    assert.deepEqual(result.engine, { mode: 'local', label: '기본 엔진(규칙 기반)', model: null, fallbackReason: reason })
    assert.equal(result.candidates.length, LIMITS.candidates.count)
    assert.ok(result.candidates.every((c) => c.engine === 'local'))
    assert.equal(result.safety.judge, 'rules')
    return result
  }

  for (const [kind, reason] of Object.entries(REASONS)) {
    test(`LlmError(${kind}) → ‘${reason}’`, async () => {
      await assertFallback(fakeLlm({ generate: () => Promise.reject(new LlmError(kind)) }), reason)
    })
  }

  test('LLM 계층 밖의 오류나 빈 결과도 기본 엔진으로 넘어간다', async () => {
    const fallback = REASONS.api
    await assertFallback(fakeLlm({ generate: () => Promise.reject(new Error('알 수 없는 오류')) }), fallback)
    for (const payload of [{ candidates: [] }, { candidates: 'x' }, {}, null, 'x', { candidates: [null, { text: '' }, { text: '가'.repeat(60) }] }]) {
      await assertFallback(fakeLlm({ generate: () => payload }), fallback)
    }
  })

  test('AI 심사가 실패하면 LLM 후보를 내보내지 않는다 (안전한 쪽으로)', async () => {
    const judgeReason = 'AI 안전 심사가 응답하지 않아 기본 엔진으로 만들었어요'
    for (const judge of [() => Promise.reject(new LlmError('network')), () => Promise.reject(new Error('x')), () => ({}), () => null, () => ({ results: 'x' })]) {
      const result = await assertFallback(fakeLlm({ judge }), judgeReason)
      assert.ok(result.candidates.every((c) => !LLM_TEXTS.includes(c.text) || c.engine === 'local'))
      assert.equal(result.safety.blocked, 6, '심사를 못 받은 후보는 막힌 것으로 센다')
      assert.equal(result.safety.passed, result.safety.generated - 6)
    }
  })
})

describe('생성 흐름: 기록', () => {
  test('기록에는 개수와 시간만 남고, 프로필·문구·직접 입력한 말은 남지 않는다', async () => {
    const secretProfile = { ...PROFILE, endings: ['거든', '비밀어미'], fillers: ['비밀추임새'], expressions: ['비밀표현'], samples: ['비밀스러운 대표 문장이야'] }
    const secretCandidates = () => ({ candidates: ['비밀후보 하나', '비밀후보 둘', '비밀후보 셋'].map((text) => llmCandidate(text)) })
    const runs = [
      { llm: null, input: { profile: secretProfile, customTrend: { keyword: '비밀키워드', meaning: '비밀스러운 뜻' }, options: { topic: '비밀토픽' } } },
      { llm: fakeLlm({ generate: secretCandidates }), input: { ...INPUT, profile: secretProfile, options: { topic: '비밀토픽' } } },
      { llm: fakeLlm({ generate: () => Promise.reject(new LlmError('auth')) }), input: { ...INPUT, profile: secretProfile } },
      { llm: fakeLlm({ judge: () => Promise.reject(new Error('비밀스러운 오류')) }), input: { ...INPUT, profile: secretProfile } },
    ]
    for (const { llm, input } of runs) {
      const { generator, log } = setup({ llm })
      const result = await generator.generate(input)
      assert.ok(log.lines.length >= 1, '무엇인가는 남긴다')
      assert.match(log.text(), /\[generate\] (llm|local) · 후보 \d+개 · 생성 \d+ · 차단 \d+ · 대체 (있음|없음) · \d+ms/)
      assert.doesNotMatch(log.text(), /비밀/)
      for (const c of result.candidates) assert.ok(!log.text().includes(c.text), `문구가 기록에 남음: ${c.text}`)
    }
    const { generator, log } = setup({ safety: fakeSafety() })
    await assert.rejects(generator.generate({ profile: secretProfile, customTrend: { keyword: `${BAD} 비밀키워드` } }), GenerateError)
    assert.doesNotMatch(log.text(), /비밀|나쁜말/)
  })
})

describe('생성 흐름: 실제 안전 필터와 함께', async () => {
  const real = await import('../server/safety/filter.js').catch(() => null)
  const usable = ['checkText', 'checkCandidate', 'filterStyleTerms'].every((name) => typeof real?.[name] === 'function')

  test('예시 트렌드와 평범한 말투로는 막히는 후보 없이 다섯 개가 나온다', { skip: usable ? false : 'server/safety/filter.js가 아직 없다' }, async () => {
    const { generator } = setup({ safety: real })
    for (const trendId of ['seed-ohiryeo-joa', 'seed-mot-chamji', 'seed-kingbatne', 'seed-season-cheonnun']) {
      const result = await generator.generate({ ...INPUT, trendId, options: { situation: 'chat', spice: 'hot', topic: '떡볶이' } })
      assert.equal(result.candidates.length, LIMITS.candidates.count, trendId)
      assert.equal(result.safety.blocked, 0, trendId)
      assert.equal(result.safety.judge, 'rules')
    }
    const custom = await generator.checkCustomTrend({ keyword: '주말 등산', meaning: '주말마다 산에 가는 것' })
    assert.equal(custom.ok, true)
  })
})
