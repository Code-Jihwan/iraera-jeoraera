// 규칙 기반 조합 엔진 — API 키가 없어도 "내 말투 × 밈" 후보를 만든다.
// 어미 활용은 아래 표에 있는 것만 쓴다. 표에 없는 어미는 추측하지 않고 건너뛴다.
import { REGISTERS } from '../../shared/constants.js'
import { JONG, JUNG, addBatchim, attach, charLength, compose, decompose, initialsOfWords } from '../../shared/hangul.js'
import { MAX_TEXT_CHARS, cleanSlotWord, isRecord, sanitizeFeedback, sanitizeOptions, sanitizeProfilePayload, textKey } from './sanitize.js'
import { fillTemplate, usesSlot } from './template.js'

const DEFAULT_COUNT = 10
const MAX_COUNT = 30
const ENDINGS_USED = 3
const FILLERS_USED = 2
const RHYTHMS_USED = 2
const PER_FRAME = 2
const JOIN_MAX_CHARS = 8
const SLOT_WORD_MAX_CHARS = 30
const ROTATION_SPAN = 60 // 2·3·4·5·6으로 나누어떨어져, 어떤 길이의 목록이든 고르게 돈다
/** 밈을 과감하게 바꾸는 방식(비틀기는 문형마다, 줄임은 결과 전체에서)을 몇 개까지 낼지 */
const BOLD_LIMIT = { mild: 0, medium: 1, hot: 2 }

const lastChar = (phrase) => Array.from(phrase).at(-1) ?? ''
const pick = (list, i) => list[i % list.length]
const rotate = (list, n) => (list.length ? [...list.slice(n % list.length), ...list.slice(0, n % list.length)] : [])
const text = (value) => (typeof value === 'string' ? value : '')
const strings = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim()) : [])
const bareWord = (word) => word.replace(/[^\p{L}\p{N}]/gu, '')
/** { 값: 열쇠들 } 꼴로 적은 표를 열쇠 → 값 Map으로 뒤집는다. */
const invert = (groups) => new Map(Object.entries(groups).flatMap(([value, keys]) => Array.from(keys, (key) => [key, value])))

// ── 어미 활용 ─────────────────────────────────────────────

const jongOf = (word) => {
  const d = decompose(lastChar(word))
  return d ? JONG[d.jong] : null
}

/** ㄴ으로 시작하는 어미 앞에서는 줄기 끝 ㄹ이 빠진다 (살 + 네 → 사네). */
function dropRieul(stem) {
  const d = decompose(lastChar(stem))
  if (!d || JONG[d.jong] !== 'ㄹ') return stem
  return Array.from(stem).slice(0, -1).join('') + compose(d.cho, d.jung)
}

// 받침이 ㅂ·ㅅ·ㅎ인 형용사는 불규칙 활용(추운데·나은데·그런데)이 많아 추측하지 않는다. 규칙 활용인 줄기만 예외로 둔다.
const IRREGULAR_PRONE = new Set(['ㅂ', 'ㅅ', 'ㅎ'])
const REGULAR_ADJECTIVE_ENDS = new Set(['좋', '좁'])

/** 형용사 + (으)ㄴ데: 좋은데 · 예쁜데 · 긴데. 있다·없다 계열은 '는데'. */
function adjectiveBut(p, tail) {
  const jong = jongOf(p.stemN)
  const last = lastChar(p.stemN)
  if (jong === null) return ''
  if (jong === '') return `${addBatchim(p.stemN, 'ㄴ')}데${tail}`
  if (jong === 'ㅆ' || last === '없') return `${p.stem}는데${tail}`
  if (IRREGULAR_PRONE.has(jong) && !REGULAR_ADJECTIVE_ENDS.has(last)) return ''
  return `${p.stemN}은데${tail}`
}

const onStem = (suffix) => (p) => p.stem && p.stem + suffix
const onStemN = (suffix) => (p) => p.stemN && p.stemN + suffix
const ofForm = (key) => (p) => p.forms[key]
const but = (tail) => (p) => (p.pos === 'adj' ? adjectiveBut(p, tail) : onStemN(`는데${tail}`)(p))
// 동사에는 '는'이 끼어든다: 참는구나 / 좋구나 · 미쳤구나
const exclaim = (suffix) => (p) => (p.pos === 'verb' ? onStemN(`는${suffix}`)(p) : onStem(suffix)(p))
// 완성형이 정해진 글자로 끝날 때만 거기에서 새 꼴을 만든다
const extend = (source, ends, grow) => (p) => {
  const base = source(p)
  return base && ends.includes(lastChar(base)) ? grow(base) : ''
}
const cute = (source, ends, jong) => extend(source, ends, (base) => addBatchim(base, jong))
/** 어미 여러 개에 같은 규칙을 매긴다. toRule은 (어미) → 규칙. */
const table = (endings, toRule) => endings.map((ending) => [ending, toRule(ending)])

/**
 * 높임 단계 자체를 나타내는 어미 → 그 단계. 서술어에는 손으로 쓴 완성형을 그대로 가져다 쓰므로,
 * 결과가 그 어미 글자로 끝나지 않을 수 있다 (‘어’ → ‘킹받네’, ‘임’ → ‘킹받음’).
 */
const REGISTER_ENDINGS = invert({
  banmal: ['어', '아', '야'],
  haeyo: ['요', '어요', '아요', '해요'],
  hapsyo: ['습니다', 'ㅂ니다'],
  eumseum: ['임', '음', '함', 'ㅁ'],
})

// 줄기 끝소리와 상관없이 그대로 붙는 어미
const DIRECT_ENDINGS = ['거든', '거든요', '거덩', '잖아', '잖아요', '지', '죠', '쥬', '더라', '더라고', '더라고요', '던데', '던데요', '긴 해']

/** 서술어(동사·형용사·과거형) 줄기에 어미를 붙이는 규칙. 값은 (줄기 정보) → 완성형. */
const PREDICATE_ENDINGS = new Map([
  ...table(DIRECT_ENDINGS, onStem),
  ...table(['네', '네요'], onStemN),
  ...table(['는데', '은데', 'ㄴ데'], () => but('')),
  ...table(['는데요', '은데요', 'ㄴ데요'], () => but('요')),
  ...table(['구나', '군', '군요'], exclaim),
  ['다니까', extend(ofForm('plain'), ['다'], (plain) => `${plain}니까`)],
  ...table([...REGISTER_ENDINGS.keys()], (ending) => ofForm(REGISTER_ENDINGS.get(ending))),
  ['다', ofForm('plain')],
  // 애교 어미는 완성형 끝 글자에 받침을 얹는다
  ['용', cute(ofForm('haeyo'), ['요'], 'ㅇ')],
  ['욤', cute(ofForm('haeyo'), ['요'], 'ㅁ')],
  ['당', cute(ofForm('plain'), ['다'], 'ㅇ')],
  ['넹', cute(onStemN('네'), ['네'], 'ㅇ')],
  ['징', cute(onStem('지'), ['지'], 'ㅇ')],
  ...table(['엉', '앙'], () => cute(ofForm('banmal'), ['어', '아'], 'ㅇ')),
  ['얌', cute(ofForm('banmal'), ['야'], 'ㅁ')],
])

const withI = (rest) => `이${rest}/${rest}`
const same = (form) => () => `${form}/${form}`

/** 명사 뒤에 붙는 꼴. 값은 '받침 있을 때/없을 때'. 대부분은 받침 뒤에 '이'만 끼워 넣으면 된다. */
const NOUN_ENDINGS = new Map([
  ...table([...DIRECT_ENDINGS, '네', '네요', '구나', '군', '군요', '다', '야', '당', '넹', '징', '얌'], withI),
  ['다니까', withI('라니까')],
  ...table(['어', '아'], () => withI('야')),
  ...table(['는데', '은데', 'ㄴ데'], same('인데')),
  ...table(['는데요', '은데요', 'ㄴ데요'], same('인데요')),
  ...table(['임', '음', '함', 'ㅁ'], same('임')),
  ...table(['습니다', 'ㅂ니다'], same('입니다')),
  ...table(['요', '어요', '아요', '해요'], () => '이에요/예요'),
  ['용', '이에용/예용'],
  ['욤', '이에욤/예욤'],
])

/** 프로필에 추임새가 모자랄 때 얹어 보는, 누구나 쓰는 무난한 추임새 */
const COMMON_FILLERS = {
  banmal: ['진짜', '와'],
  haeyo: ['진짜', '와'],
  hapsyo: ['정말', '와'],
  eumseum: ['진짜', '와'],
}

/** 프로필에 쓸 어미가 모자랄 때 대신 붙여 보는, 높임 단계별로 흔한 말끝 */
const COMMON_ENDINGS = {
  banmal: ['거든', '잖아', '네', '는데', '지'],
  haeyo: ['거든요', '잖아요', '네요', '는데요', '죠'],
  hapsyo: ['네요', '죠', '거든요', '는데요'],
  eumseum: ['거든', '잖아', '네', '는데'],
}

const fillForms = (forms, X) => Object.fromEntries(Object.entries(forms).map(([key, form]) => [key, fillTemplate(form, { X })]))

function predicateOf(hints, X) {
  const stem = fillTemplate(hints.stem, { X })
  return { pos: hints.pos, stem, stemN: fillTemplate(hints.stemN, { X }) || dropRieul(stem), forms: fillForms(hints.forms, X) }
}

/** 밈의 핵심 구에 어미를 입힌다. 만들 수 없으면 빈 문자열. */
function conjugate(hints, X, ending) {
  if (hints.pos === 'noun') {
    // 받침이 빈칸 말에서 올 수 있으므로 빈칸을 먼저 채운다
    const noun = fillTemplate(hints.stem, { X })
    const pair = NOUN_ENDINGS.get(ending)
    return noun && pair ? attach(noun, pair) : ''
  }
  const rule = hints.pos === 'fixed' ? null : PREDICATE_ENDINGS.get(ending)
  return (rule && rule(predicateOf(hints, X))) || ''
}

// ── 리듬 ──────────────────────────────────────────────────

const closed = (phrase) => (/[.!?…]$/.test(phrase) ? phrase : `${phrase}.`)

/** 호흡을 끊을 자리(앞 덩어리의 어절 수). 빈칸 말과 밈 사이를 먼저 찾고, 없으면 마지막 어절 앞. */
function beatIndex(words, phrase, X) {
  const at = X ? phrase.indexOf(X) : -1
  if (at === 0) {
    const head = X.split(' ').length
    if (head < words.length) return head
  }
  if (at > 0 && phrase[at - 1] === ' ') return phrase.slice(0, at - 1).split(' ').length
  return words.length - 1
}

/** 짧게 끊어 쓰기: ‘오히려. 좋아.’ */
function beatSplit(phrase, X) {
  const words = phrase.split(' ')
  if (words.length < 2) return ''
  const cut = beatIndex(words, phrase, X)
  const head = words.slice(0, cut).join(' ').replace(/,$/, '')
  const rest = words.slice(cut).join(' ')
  if (!/[.!?…]$/.test(head)) return `${head}. ${closed(rest)}`
  // 앞 덩어리가 이미 끊겨 있으면(‘비 오는 날?’) 뒤쪽을 한 번 더 끊는다
  const inner = beatSplit(rest, '')
  return inner && `${head} ${inner}`
}

// 늘여 쓸 때 덧붙이는 홀소리 ← 그 소리로 끝나는 모음들. 이중모음은 끝소리만 남는다 (와 → 아, 요 → 오).
const STRETCH_VOWELS = invert({ 아: 'ㅏㅑㅘ', 애: 'ㅐㅒㅙ', 어: 'ㅓㅕㅝ', 에: 'ㅔㅖㅞㅚ', 오: 'ㅗㅛ', 우: 'ㅜㅠ', 으: 'ㅡ', 이: 'ㅣㅟㅢ' })

/** 늘여 쓰기: 받침이 없으면 홀소리를 두 번 더(‘좋아아아’), 있으면 물결(‘끝임~~’). */
function stretch(phrase) {
  const d = decompose(lastChar(phrase))
  return d && d.jong === 0 ? phrase + STRETCH_VOWELS.get(JUNG[d.jung]).repeat(2) : `${phrase}~~`
}

/** 붙여 쓰기: 짧은 문구만, 문장부호가 없을 때만. */
function joinWords(phrase) {
  if (/[^\p{L}\p{N} ]/u.test(phrase)) return ''
  const joined = phrase.replaceAll(' ', '')
  return joined !== phrase && charLength(joined) <= JOIN_MAX_CHARS ? joined : ''
}

/** 리듬 변형. when은 프로필에 그 버릇이 있는지, sealed는 뒤에 말끝 습관을 더 붙이면 안 되는지. */
const RHYTHMS = [
  { id: 'beat', label: '리듬 짧게 끊기', sealed: true, when: (p) => p.rhythm.short || p.rhythm.phrasing === 'choppy', apply: beatSplit },
  { id: 'stretch', label: '리듬 늘여 쓰기', sealed: false, when: (p) => p.tail.elongation || p.tail.punct.some((mark) => mark.includes('~')), apply: stretch },
  { id: 'join', label: '리듬 붙여 쓰기', sealed: false, when: (p) => p.rhythm.tempo === 'fast', apply: joinWords },
]

// ── 말끝 습관 ─────────────────────────────────────────────

/** 어디에 쓸 문구냐에 따라 붙일 수 있는 말끝 습관. 말로 할 때는 ㅋㅋ를 소리 낼 수 없으니 아무것도 붙이지 않는다. */
const TAIL_KINDS = { chat: ['punct', 'laugh'], sns: ['punct', 'laugh', 'emoji'], shorts: ['punct'], talk: [] }
const APPENDABLE_PUNCT = new Set(['~', '~~', '!', '!!', '…', '..', '...'])
const ENDS_WITH_MARK = /[.!?~…,]$/
const CRY_CATEGORY = '자조·푸념'

function tailPlan(tail, situation, category) {
  const laughs = [tail.kk, tail.hh].filter(Boolean).map((laugh) => ({ add: ` ${laugh}`, label: `웃음 ${laugh}` }))
  const cries = category === CRY_CATEGORY && tail.cry ? [{ add: ` ${tail.cry}`, label: `울음 ${tail.cry}` }] : []
  const habits = {
    punct: tail.punct.filter((mark) => APPENDABLE_PUNCT.has(mark)).map((mark) => ({ add: mark, label: `기호 ${mark}` })),
    laugh: [...laughs, ...cries],
    emoji: tail.emoji.map((emoji) => ({ add: ` ${emoji}`, label: `이모지 ${emoji}` })),
  }
  const kinds = TAIL_KINDS[situation].filter((kind) => habits[kind].length)
  const recipes = kinds.map((kind) => [kind])
  if (kinds.includes('punct') && kinds.includes('laugh')) recipes.push(['punct', 'laugh'])
  return { habits, recipes }
}

/** 후보를 하나 걸러 하나씩만 꾸며, 목록이 한결같아 보이지 않게 한다. */
function decorate(draft, index, run) {
  const { habits, recipes } = run.tails
  const plain = { text: draft.text, labels: [] }
  if (draft.sealed || !recipes.length || (index + run.parity) % 2) return plain
  const picked = run
    .choose(recipes)
    .filter((kind) => kind !== 'punct' || !ENDS_WITH_MARK.test(draft.text))
    .map((kind) => run.choose(habits[kind]))
  const decorated = draft.text + picked.map((habit) => habit.add).join('')
  return charLength(decorated) <= MAX_TEXT_CHARS ? { text: decorated, labels: picked.map((habit) => habit.label) } : plain
}

// ── 설명 문장 ─────────────────────────────────────────────

const quote = (word) => `‘${word}’`
const object = (word) => attach(quote(word), '을/를')
const endingName = (d) => object(`~${d.ending}`)

/**
 * 방식별 설명: [밈 이름 뒤에 붙는 조사 쌍, 뒷말].
 * 빈칸을 채운 후보는 조사 대신 ‘…을 넣고’가 온다. mine이 아니면 프로필에 없는 것이라 ‘~해 봤어요’로 말한다.
 */
const WHY = {
  ending: ['에/에', (d) => (d.mine ? `내 말끝 ${endingName(d)} 붙였어요.` : `흔히 쓰는 말끝 ${endingName(d)} 붙여 봤어요.`)],
  both: ['에/에', (d) => `내 추임새 ${attach(quote(d.filler), '과/와')} 말끝 ${endingName(d)} 입혔어요.`],
  filler: ['/', (d) => (d.mine ? `앞에 내 추임새 ${object(d.filler)} 얹었어요.` : `앞에 흔히 쓰는 추임새 ${object(d.filler)} 얹어 봤어요.`)],
  register: ['을/를', (d) => `내 말투(${d.register})에 맞췄어요.`],
  kept: ['을/를', () => '있는 그대로 살렸어요.'],
  beat: ['을/를', (d) => (d.mine ? '내 호흡대로 짧게 끊었어요.' : '짧게 끊어 봤어요.')],
  stretch: ['/', (d) => (d.mine ? '끝을 내 버릇대로 길게 늘였어요.' : '끝을 길게 늘여 봤어요.')],
  join: ['을/를', (d) => (d.mine ? '내 말 속도처럼 붙여 썼어요.' : '붙여 써 봤어요.')],
  twist: ['을/를', () => '살짝 비틀었어요.'],
}

const memeName = (src) => quote(src.label) + (src.isFrame ? ' 문형' : '')
// 밈 이름에 이미 들어 있는 낱말(‘피라미드에도 악플이 달린다’의 ‘피라미드’)은 넣었다고 다시 말하지 않는다
const namesWord = (src, X) => Boolean(X) && !src.label.includes(X)

function explain(src, X, kind, detail = {}) {
  const [pair, rest] = WHY[kind]
  const head = namesWord(src, X) ? `${memeName(src)}에 ${object(X)} 넣고` : attach(memeName(src), pair)
  return `${head} ${rest(detail)}`
}

/** 밈을 바꾸지 않고 내 높임 단계로만 옮겼을 때의 설명. 반말 꼴과 같으면 옮긴 것도 없다. */
function explainPlain(src, run) {
  const kind = formOf(src.hints, run.register) === src.hints.forms.banmal ? 'kept' : 'register'
  return explain(src, '', kind, { register: REGISTERS[run.register] })
}

function explainSlot(src, base, run) {
  if (!namesWord(src, base.X)) return explainPlain(src, run)
  return `${memeName(src)}에 ${object(base.X)} ${base.own ? '넣었어요.' : '넣어 봤어요.'}`
}

// ── 재료: 엔진 힌트와 빈칸 값 ─────────────────────────────

const POS = ['verb', 'adj', 'past', 'noun', 'fixed']

function readSlot(slot) {
  if (!isRecord(slot)) return null
  const required = slot.required !== false
  const template = text(slot.template)
  // 감쌀 틀이 없는 선택 빈칸은 없는 셈 친다
  if (!required && !template.includes('{form}')) return null
  return { required, template, defaults: strings(slot.defaults) }
}

/** 엔진 힌트를 믿고 쓸 수 있는 모양으로 읽는다. 쓸 수 없으면 null. */
function readHints(engine) {
  if (!isRecord(engine) || !isRecord(engine.forms) || !text(engine.forms.banmal)) return null
  return {
    pos: POS.includes(engine.pos) ? engine.pos : 'fixed',
    stem: text(engine.stem),
    stemN: text(engine.stemN),
    forms: Object.fromEntries(Object.entries(engine.forms).filter(([, form]) => text(form))),
    slot: readSlot(engine.slot),
    contexts: strings(engine.contexts),
    twists: strings(engine.twists),
  }
}

/** 차례(i)마다 어떤 빈칸 값으로 문구를 만들지 정한다. 선택 빈칸은 채운 것과 비운 것을 함께 낸다. */
function baseRotation(slot, own, samples) {
  const bare = { X: '', wrap: false, own: false }
  if (!slot) return () => [bare]
  if (slot.required) return (i) => [own ?? pick(samples, i)]
  if (own) return () => [own, bare]
  return samples.length ? (i) => [bare, pick(samples, i)] : () => [bare]
}

/** 엔진 힌트가 있는 트렌드에서 후보를 뽑을 재료. 빈칸을 채울 말이 없으면 null. */
function trendSource(trend, hints, run) {
  const { slot } = hints
  const wrap = Boolean(slot) && !slot.required // 선택 빈칸은 틀(slot.template)로 감싼다
  const own = slot && run.topic ? { X: run.topic, wrap, own: true } : null
  const samples = slot ? rotate(slot.defaults, run.turn).map((X) => ({ X, wrap, own: false })) : []
  if (slot?.required && !own && !samples.length) return null
  const twists = rotate(hints.twists, run.turn)
  return {
    hints,
    label: trend.keyword.trim(),
    isFrame: false,
    memeElement: text(trend.pattern).trim() || trend.keyword.trim(),
    keys: [textKey(trend.keyword)],
    endings: run.profile.endings,
    fillers: run.fillers,
    bases: baseRotation(slot, own, samples),
    // ‘내 단어 넣기’는 넣은 말이 내 것이거나 빈칸이 꼭 채워야 하는 것일 때만이다
    slotBases: own ? [own] : slot?.required ? samples : [],
    spareSlots: own && slot?.required ? samples : [],
    // 선택 빈칸에 예시 낱말을 넣은 꼴은 다른 방식(리듬)의 재료로만 쓴다
    spareBases: slot && !slot.required ? samples : [],
    // 넣고 싶은 말이 있으면 그 말이 들어가는 비틀기를 먼저 쓴다
    twists: own ? [...twists.filter(usesSlot), ...twists.filter((twist) => !usesSlot(twist))] : twists,
    twistX: (i) => (own ?? pick(samples, i))?.X ?? '',
  }
}

/** 가장 자주 쓰는 앞의 n개 안에서만 차례를 돌린다. */
const turnHead = (list, n, shift) => [...rotate(list.slice(0, n), shift), ...list.slice(n)]

/** 키워드형 트렌드를 다른 밈의 문형(틀)에 넣어 후보를 뽑을 재료. order는 몇 번째 문형인지. */
function frameSource(frame, hints, word, run, order) {
  const base = { X: word, wrap: !hints.slot.required, own: true }
  return {
    hints,
    label: frame.keyword.trim(),
    isFrame: true,
    memeElement: `${quote(frame.keyword.trim())} 문형 + ${quote(word)}`,
    keys: [textKey(word), textKey(frame.keyword)],
    // 문형마다 한두 개만 뽑으므로, 문형마다 다른 어미·추임새가 먼저 나오게 차례를 돌려 둔다
    endings: turnHead(run.profile.endings, ENDINGS_USED, order),
    fillers: turnHead(run.fillers, FILLERS_USED, order),
    bases: () => [base],
    slotBases: [base],
    spareSlots: [],
    spareBases: [],
    // 키워드가 들어가지 않는 비틀기는 이 트렌드와 상관없는 말이 된다
    twists: rotate(hints.twists.filter(usesSlot), run.turn),
    twistX: () => word,
  }
}

/** 틀로 쓸 예시 트렌드가 하나도 없을 때 쓰는 무난한 문형 세 가지 */
const BUILTIN_FRAMES = [
  {
    keyword: '~는 못 참지',
    engine: {
      pos: 'verb',
      stem: '{X|은/는} 못 참',
      forms: { banmal: '{X|은/는} 못 참지', haeyo: '{X|은/는} 못 참죠', hapsyo: '{X|은/는} 못 참습니다', eumseum: '{X|은/는} 못 참음', plain: '{X|은/는} 못 참는다' },
      slot: { required: true, defaults: [] },
      contexts: ['지나가다 봤는데', '바쁘긴 한데', '솔직히 말해서'],
      twists: ['{X|은/는} 진짜 못 참겠다'],
    },
  },
  {
    keyword: '~에 진심인 편',
    engine: {
      pos: 'noun',
      stem: '{X}에 진심인 편',
      forms: { banmal: '{X}에 진심인 편', haeyo: '{X}에 진심인 편이에요', hapsyo: '{X}에 진심인 편입니다', eumseum: '{X}에 진심인 편임', plain: '{X}에 진심인 편이다' },
      slot: { required: true, defaults: [] },
      contexts: ['다들 몰랐겠지만 나', '요즘 나를 한 줄로 말하면', '자기소개 한 줄:'],
      twists: ['{X}에만 진심인 편'],
    },
  },
  {
    keyword: '오늘도 ~',
    engine: {
      pos: 'noun',
      stem: '오늘도 {X}',
      forms: { banmal: '오늘도 {X}', haeyo: '오늘도 {X|이에요/예요}', hapsyo: '오늘도 {X}입니다', eumseum: '오늘도 {X}임', plain: '오늘도 {X}' },
      slot: { required: true, defaults: [] },
      contexts: ['퇴근하고 뭐 하냐고?', '고민할 것도 없이', '눈 뜨자마자 떠오른 건'],
      twists: ['내일도 {X}', '오늘도 내일도 {X}'],
    },
  },
]

function frameSources(trend, frames, run) {
  const word = cleanSlotWord(trend.keyword, SLOT_WORD_MAX_CHARS)
  if (!word) return []
  const read = (list) =>
    list
      .map((frame) => ({ frame, hints: readHints(frame?.engine) }))
      .filter(({ frame, hints }) => hints?.slot && text(frame.keyword))
      .map(({ frame, hints }, order) => frameSource(frame, hints, word, run, order))
  const given = read(Array.isArray(frames) ? frames : [])
  return rotate(given.length ? given : read(BUILTIN_FRAMES), run.turn)
}

// ── 초안 만들기 ───────────────────────────────────────────

const formOf = (hints, register) => hints.forms[register] || hints.forms.banmal
const wrap = (src, base, core) => (core && base.wrap ? fillTemplate(src.hints.slot.template, { X: base.X, form: core }) : core)
const phraseIn = (src, base, register) => wrap(src, base, fillTemplate(formOf(src.hints, register), { X: base.X }))
const basePhrase = (src, base, run) => phraseIn(src, base, run.register)

/** 추임새의 끝말이 문구에 이미 들어 있는지 (‘아 진짜’ + ‘진짜 …’, ‘사실’ + ‘…사실을 기억하자’) */
function clashes(phrase, filler) {
  const word = bareWord(filler.split(' ').at(-1))
  return phrase
    .split(' ')
    .map(bareWord)
    .some((other) => other === word || (word.length >= 2 && other.startsWith(word)))
}

/**
 * 추임새를 앞에 얹는다. ‘{X}? {form}’처럼 빈칸 말이 물음표·쉼표로 따로 서는 틀이면
 * 추임새를 뒤 문구 앞에 넣는다(‘약간 월요일? 오히려 좋아’ → ‘월요일? 약간 오히려 좋아’).
 */
function leadWith(src, base, filler, core, phrase) {
  const template = src.hints.slot?.template || ''
  if (base.wrap && core && /^\{X[^}]*\}[?!,.]/.test(template)) return fillTemplate(template, { X: base.X, form: `${filler} ${core}` })
  return `${filler} ${phrase}`
}

/** 초안. led는 추임새로 시작하는지, sealed는 말끝 습관을 더 붙이면 안 되는지. */
function draftOf(src, X, phrase, technique, elements, why, flags = {}) {
  return { src, X, text: phrase, technique, elements, why, led: false, sealed: false, ...flags }
}

/** 재료를 차례로 써 보며, 쓸 만한 초안이 나온 재료가 limit개가 될 때까지 모은다. */
function takeUntil(materials, limit, make) {
  const out = []
  let used = 0
  for (const material of materials) {
    if (used >= limit) break
    const made = make(material, used).filter(Boolean)
    used += made.length ? 1 : 0
    out.push(...made)
  }
  return out
}

const authoredPhrases = (src, base) => Object.values(src.hints.forms).map((form) => wrap(src, base, fillTemplate(form, { X: base.X })))

/** 어미를 입힌 초안. mine이 아니면 프로필에 없는 흔한 말끝을 붙여 보는 것이다. */
function endingDraft(src, base, ending, run, mine = true) {
  const core = conjugate(src.hints, base.X, ending)
  const phrase = wrap(src, base, core)
  // 원래 문구와 같아지면 입힌 것이 없다. 흔한 말끝은 밈의 다른 높임 꼴과 같아져도 새로울 것이 없다.
  const unchanged = mine ? [basePhrase(src, base, run)] : authoredPhrases(src, base)
  if (!run.fresh(phrase) || unchanged.includes(phrase)) return null
  // 높임 단계의 완성형을 빌렸는데 그 어미 글자로 끝나지 않으면, 어미가 아니라 말투를 맞췄다고 설명한다
  const register = phrase.endsWith(ending) ? null : REGISTER_ENDINGS.get(ending)
  if (register) return draftOf(src, base.X, phrase, 'ending', [], explain(src, base.X, 'register', { register: REGISTERS[register] }))
  return draftOf(src, base.X, phrase, 'ending', mine ? [`어미 ~${ending}`] : [], explain(src, base.X, 'ending', { ending, mine }), { ending, base, core })
}

/** 추임새와 어미를 함께 입힌 초안. 어미를 바꿨으므로 방식은 ‘어미 입히기’로 친다. */
function fillerOnEnding(first, run) {
  const filler = first?.src.fillers[0]
  if (!filler || clashes(first.text, filler)) return []
  const phrase = first.base ? leadWith(first.src, first.base, filler, first.core, first.text) : `${filler} ${first.text}`
  if (!run.fresh(phrase)) return []
  const why = explain(first.src, first.X, 'both', { ending: first.ending, filler })
  return [draftOf(first.src, first.X, phrase, 'ending', [...first.elements, `추임새 ${filler}`], why, { led: true, ending: first.ending })]
}

function endingDrafts(src, run) {
  const swapped = takeUntil(src.endings, ENDINGS_USED, (ending, i) => src.bases(i).map((base) => endingDraft(src, base, ending, run)))
  return [...swapped, ...fillerOnEnding(swapped.find((draft) => draft.ending), run)]
}

/** 추임새를 얹은 초안. mine이 아니면 프로필에 없는 흔한 추임새를 얹어 보는 것이다. */
function fillerDraft(src, base, filler, run, mine = true) {
  const phrase = basePhrase(src, base, run)
  if (!phrase || clashes(phrase, filler)) return null
  const led = leadWith(src, base, filler, fillTemplate(formOf(src.hints, run.register), { X: base.X }), phrase)
  if (!run.fresh(led)) return null
  return draftOf(src, base.X, led, 'filler', mine ? [`추임새 ${filler}`] : [], explain(src, base.X, 'filler', { filler, mine }), { led: true })
}

const fillerDrafts = (src, run) => takeUntil(src.fillers, FILLERS_USED, (filler, i) => [fillerDraft(src, src.bases(i)[0], filler, run)])

function slotDraft(src, base, run) {
  const phrase = basePhrase(src, base, run)
  return run.fresh(phrase) ? draftOf(src, base.X, phrase, 'slot', [], explainSlot(src, base, run)) : null
}

const slotDrafts = (src, run) => src.slotBases.map((base) => slotDraft(src, base, run)).filter(Boolean)

function rhythmDraft(src, base, rhythm, run, mine) {
  const phrase = basePhrase(src, base, run)
  const shaped = phrase && rhythm.apply(phrase, base.X)
  if (!run.fresh(shaped)) return null
  return draftOf(src, base.X, shaped, 'rhythm', mine ? [rhythm.label] : [], explain(src, base.X, rhythm.id, { mine }), { sealed: rhythm.sealed })
}

const rhythmDrafts = (src, run) => run.rhythms.map((rhythm) => rhythmDraft(src, src.bases(0)[0], rhythm, run, true)).filter(Boolean)

/** 어절 첫 글자를 모은 줄임말. 2~4어절 문구에서 2~4글자가 나올 때만 (‘야야’처럼 같은 글자뿐이면 버린다). */
function acronymOf(phrase) {
  const words = phrase.split(' ').filter(Boolean)
  if (words.length < 2 || words.length > 4) return ''
  const acronym = initialsOfWords(phrase)
  return /^[가-힣0-9A-Za-z]{2,4}$/.test(acronym) && new Set(acronym).size > 1 ? acronym : ''
}

function blendDrafts(src, run) {
  const [base] = src.bases(0)
  // 줄임말은 높임 단계와 상관없이 쓰는 말이라 원래(반말) 문구에서 만든다 — ‘갓생 삽니다’가 아니라 ‘갓생 산다’에서
  const phrase = phraseIn(src, base, 'banmal')
  const acronym = acronymOf(phrase)
  if (!run.fresh(acronym) || src.keys.includes(textKey(acronym))) return []
  return [draftOf(src, base.X, acronym, 'blend', [], `${object(phrase)} 줄였어요.`)]
}

// 비틀기 문형은 반말로만 적혀 있다. 해요체 화자에게는 ‘요’를 붙여 높임을 맞추되, 붙여도 자연스러운 끝말일 때만 한다.
// ‘못 참겠다’나 명사로 끝나는 말(‘이게 바로 책없쾌’)에는 붙일 수 없으니 그대로 둔다.
const TAKES_YO = ['아', '어', '여', '지', '네', '데', '고', '도', '해', '래', '부터', '까지']
const inRegister = (phrase, register) => (register === 'haeyo' && TAKES_YO.some((end) => phrase.endsWith(end)) ? `${phrase}요` : phrase)

function twistDraft(src, template, i, run) {
  const X = usesSlot(template) ? src.twistX(i) : ''
  const phrase = inRegister(fillTemplate(template, { X }), run.register)
  return run.fresh(phrase) ? draftOf(src, X, phrase, 'twist', [], explain(src, X, 'twist')) : null
}

const twistDrafts = (src, run) => takeUntil(src.twists, BOLD_LIMIT[run.spice], (template, i) => [twistDraft(src, template, i, run)])

const MAKERS = [endingDrafts, fillerDrafts, slotDrafts, rhythmDrafts, blendDrafts, twistDrafts]
const mainDrafts = (src, run) => MAKERS.flatMap((make) => make(src, run))

/**
 * 프로필에서 쓸 것이 모자라 후보가 부족할 때만 꺼내 쓰는 초안.
 * 내 말투라고 말할 수 없는 것들이라 설명도 ‘~해 봤어요’로 한다.
 * 아무것도 바꾸지 않은 원래 문구는 어떤 방식으로도 내지 않는다.
 */
function spareDrafts(src, run) {
  const [lead] = src.bases(0)
  const untried = COMMON_ENDINGS[run.register].filter((ending) => !run.profile.endings.includes(ending))
  const unused = RHYTHMS.filter((rhythm) => !run.rhythms.includes(rhythm))
  const fillers = COMMON_FILLERS[run.register].filter((filler) => !run.fillers.includes(filler))
  // 내 리듬 버릇이 원래 문구에는 맞지 않았으면(한 어절뿐인 ‘야르’) 예시 낱말을 넣은 꼴에 다시 써 본다
  const retried = run.rhythms.filter((rhythm) => !rhythmDraft(src, lead, rhythm, run, true))
  const shapes = [...retried.map((rhythm) => [rhythm, true]), ...unused.map((rhythm) => [rhythm, false])]
  return [
    ...untried.map((ending) => endingDraft(src, lead, ending, run, false)),
    ...src.spareSlots.map((base) => slotDraft(src, base, run)),
    ...unused.map((rhythm) => rhythmDraft(src, lead, rhythm, run, false)),
    ...src.spareBases.flatMap((base) => shapes.map(([rhythm, mine]) => rhythmDraft(src, base, rhythm, run, mine))),
    ...[lead, ...src.spareBases].flatMap((base) => fillers.map((filler) => fillerDraft(src, base, filler, run, false))),
  ].filter(Boolean)
}

// ── 모으기 ────────────────────────────────────────────────

/**
 * 정규화했을 때 같은 문구는 한 번만 받는다. 리듬·추임새는 밈(문형)마다 두 개까지,
 * 줄임말은 결과 전체에서 맛 단계가 허락하는 만큼만 받는다.
 */
function createPool(run) {
  const keys = new Set()
  const items = []
  const perSource = { rhythm: RHYTHMS_USED, filler: FILLERS_USED }
  const count = (technique, src) => items.filter((draft) => draft.technique === technique && (!src || draft.src === src)).length
  const full = ({ technique, src }) =>
    (technique in perSource && count(technique, src) >= perSource[technique]) || (technique === 'blend' && count(technique) >= BOLD_LIMIT[run.spice])
  const add = (draft) => {
    const key = textKey(draft.text)
    if (keys.has(key) || full(draft)) return false
    keys.add(key)
    items.push(draft)
    return true
  }
  return { items, add }
}

function collectFromTrend(src, run) {
  const pool = createPool(run)
  for (const draft of mainDrafts(src, run)) pool.add(draft)
  for (const draft of spareDrafts(src, run)) {
    if (pool.items.length >= run.count) break
    pool.add(draft)
  }
  return pool.items
}

/** 같은 방식이 잇달아 나오지 않게 방식별로 하나씩 돌아가며 늘어놓는다. */
function interleaveByTechnique(drafts, start) {
  const groups = rotate(Object.values(Object.groupBy(drafts, (draft) => draft.technique)), start)
  const longest = Math.max(0, ...groups.map((group) => group.length))
  return Array.from({ length: longest }, (_, i) => groups.map((group) => group[i]).filter(Boolean)).flat()
}

/** 여러 문형에 고르게 나눠 담는다: 문형마다 차례로 하나씩, 많아야 PER_FRAME개. */
function collectFromFrames(sources, run) {
  const pool = createPool(run)
  const queues = sources.map((src, k) => [...interleaveByTechnique(mainDrafts(src, run), k), ...spareDrafts(src, run)])
  const takeNext = (queue) => {
    while (queue.length) if (pool.add(queue.shift())) return
  }
  for (let round = 0; round < PER_FRAME; round++) queues.forEach(takeNext)
  return pool.items
}

/** 엔진 힌트가 있으면 그 밈에서, 없으면(키워드형 트렌드) 다른 밈의 문형을 빌려 초안을 모은다. */
function collect(trend, frames, run) {
  const hints = readHints(trend.engine)
  if (!hints) return collectFromFrames(frameSources(trend, frames, run), run)
  const source = trendSource(trend, hints, run)
  return source ? collectFromTrend(source, run) : []
}

// ── 마무리 ────────────────────────────────────────────────

/** 엔진 힌트에 맞는 상황 구절이 모자랄 때 쓰는 무난한 구절 */
const SPARE_CONTEXTS = ['방금 든 생각인데,', '오늘의 한마디:']
// 말이 한 번 끊기는 구절: 문장부호나 종결·연결 어미로 끝난다
const CLOSED_CONTEXT = /[,.:?!…데만니까래대다어아야요죠지네서]$/u
const overlaps = (a, b) => a.length >= 2 && b.length >= 2 && (a.startsWith(b) || b.startsWith(a))

/** 이 구절 뒤에 후보를 붙여도 자연스러운지 */
function fitsBefore(context, draft, phraseWords) {
  const words = context.split(' ').map(bareWord)
  const [first] = phraseWords
  const last = words.at(-1)
  // ‘…일단 일단 가보자고’, ‘오늘도 … 오늘도 …’, ‘…일단 첫눈, 일단 가보자고’처럼 같은 말이 겹치면 건너뛴다
  if (overlaps(words[0], first) || overlaps(last, first) || (last.length >= 2 && phraseWords.includes(last))) return false
  // 추임새로 시작하는 후보는 ‘…이제 아니 …’처럼 이어지면 어색하므로, 말이 끊기는 구절 뒤에만 둔다
  return !draft.led || CLOSED_CONTEXT.test(context)
}

/**
 * 쓰임새 예문 두 개: 밈의 서로 다른 상황 구절 뒤에 후보를 그대로 붙인다.
 * 잘 어울리는 구절을 먼저 쓰고, 모자라면 나머지 구절로 채운다. 밈의 구절이 둘이 안 될 때만 무난한 구절을 빌린다.
 */
function examplesOf(draft, phrase, index, run) {
  const phraseWords = phrase.split(' ').map(bareWord)
  const contexts = [...new Set(draft.src.hints.contexts.map((context) => fillTemplate(context, { X: draft.X })).filter(Boolean))]
  const turned = rotate(contexts, run.turn + index)
  const fitting = turned.filter((context) => fitsBefore(context, draft, phraseWords))
  return [...new Set([...fitting, ...turned, ...SPARE_CONTEXTS])].slice(0, 2).map((context) => `${context} ${phrase}`)
}

/** 어미를 바꾸지 않았어도 문구가 내 어미로 끝나면 쓰인 요소로 친다 (음슴체 화자의 ‘…끝임’). */
function wornEnding(draft, run) {
  if (draft.ending) return []
  const [worn] = run.profile.endings.filter((ending) => draft.text.endsWith(ending)).sort((a, b) => b.length - a.length)
  return worn ? [`어미 ~${worn}`] : []
}

const finish = (run) => (draft, index) => {
  const { text: phrase, labels } = decorate(draft, index, run)
  return {
    text: phrase,
    examples: examplesOf(draft, phrase, index, run),
    technique: draft.technique,
    styleElements: [...wornEnding(draft, run), ...draft.elements, ...labels],
    memeElement: draft.src.memeElement,
    why: draft.why,
  }
}

// ── 실행 준비 ─────────────────────────────────────────────

// 서술어 바로 앞에 와야 자연스러운 정도 부사 — 문장 맨 앞 추임새로는 쓰지 않는다
const NOT_LEADING = new Set(['너무', '완전', '좀', '막', '되게', '엄청', '많이', '꽤', '매우', '아주', '겁나', '더', '잘'])

const presentable = (phrase) => typeof phrase === 'string' && phrase !== '' && !/[{}]|\s{2,}/.test(phrase) && charLength(phrase) <= MAX_TEXT_CHARS

function hashSeed(seed) {
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193)
  return h >>> 0
}

function mulberry32(seed) {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), a | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 한 번의 생성에 두루 쓰이는 값: 다듬은 입력, 난수, 순환 시작점, 되풀이 방지 목록. */
function createRun({ profile, trend, options, feedback, count, rng }) {
  const p = sanitizeProfilePayload(profile)
  const o = sanitizeOptions(options)
  const shown = new Set(sanitizeFeedback(feedback).shown.map(textKey))
  // rng가 없으면 트렌드와 넣고 싶은 말로 씨앗을 만들어, 같은 입력에 같은 결과가 나오게 한다
  const source = typeof rng === 'function' ? rng : mulberry32(hashSeed(`${text(trend.id)}|${o.topic}`))
  const next = () => {
    const value = Number(source())
    return value >= 0 && value < 1 ? value : 0
  }
  return {
    profile: p,
    register: p.register,
    spice: o.spice,
    topic: o.topic,
    count: Number.isInteger(count) && count > 0 ? Math.min(count, MAX_COUNT) : DEFAULT_COUNT,
    fillers: p.fillers.filter((filler) => !NOT_LEADING.has(filler)),
    rhythms: RHYTHMS.filter((rhythm) => rhythm.when(p)).slice(0, RHYTHMS_USED),
    tails: tailPlan(p.tail, o.situation, trend.category),
    // 이미 보여 준 문구가 늘수록 순환 시작점이 밀려, 다시 만들 때 다른 낱말·구절이 먼저 나온다
    turn: Math.floor(next() * ROTATION_SPAN) + shown.size,
    parity: next() < 0.5 ? 0 : 1,
    choose: (list) => list[Math.floor(next() * list.length)],
    fresh: (phrase) => presentable(phrase) && !shown.has(textKey(phrase)),
  }
}

/**
 * 규칙만으로 유행어 후보를 만든다. 같은 입력과 같은 rng에는 늘 같은 결과를 낸다.
 * @param {{ profile: object, trend: import('../../shared/types.js').Trend, options?: object, feedback?: object,
 *           frames?: import('../../shared/types.js').Trend[], count?: number, rng?: () => number }} input
 * @returns {{ text: string, examples: string[], technique: string, styleElements: string[], memeElement: string, why: string }[]}
 */
export function generateLocal(input) {
  const { profile, trend, options, feedback, frames = [], count = DEFAULT_COUNT, rng } = input ?? {}
  if (!isRecord(trend) || !text(trend.keyword).trim()) return []
  const run = createRun({ profile, trend, options, feedback, count, rng })
  return collect(trend, frames, run).map(finish(run))
}
