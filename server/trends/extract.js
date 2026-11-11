// 규칙 기반 키워드 추출 — LLM 없이도 도는 기본 경로.
// 영상 제목·태그에서 되풀이되는 말을 찾는다. 점수에는 차트 순서와 영상 수만 쓴다(조회수 같은 API 통계는 받지도 쓰지도 않는다).
import { charLength, splitTail } from '../../shared/hangul.js'
import { byScore, foldText, normalizeKeyword } from './trend-store.js'

const SOURCE_LABEL = 'YouTube 인기 차트'
const WATCH_URL = /^https:\/\/www\.youtube\.com\/watch\?v=[A-Za-z0-9_-]{5,20}$/
const VIDEOS_MAX = 500
const TITLE_MAX = 300
const TAG_MAX = 60
const TAGS_MAX = 40
const KEYWORD_MIN = 2
const KEYWORD_MAX = 20
const DRAFTS_MAX = 200
// 순위를 모르는 영상은 차트 맨 끝으로 친다
const RANK_UNKNOWN = 999
// 제목에서 묶어 보는 어절 수
const RUN_SIZES = [2, 3]
// 해시태그를 줄줄이 단 제목 하나가 후보 목록을 채우지 못하게, 제목마다 앞쪽 몇 개만 본다
const HASHTAGS_PER_TITLE = 5

const words = (text) => text.split(/\s+/).filter(Boolean)

// 영상 제목에 붙는 형식·홍보 문구. 후보 앞뒤에 붙어 있으면 떼어 내고, 혼자서는 후보가 되지 못한다.
const FORMAT_WORDS = new Set(words(`
  official video audio music mv teaser trailer highlight highlights full ver version live ep episode
  shorts short eng sub subs subtitle subtitles lyrics lyric visualizer performance dance practice cover
  reaction feat prod special clip stage cam fancam behind making preview part vlog asmr playlist remix
  inst instrumental zip hd uhd fhd fyp viral trending youtube kpop
  예고 예고편 티저 트레일러 하이라이트 풀버전 풀영상 직캠 세로캠 풀캠 라이브 자막 뮤직비디오 뮤비
  선공개 미공개 비하인드 메이킹 리액션 커버 모음 다시보기 몰아보기 클립 생방송 실시간 스트리밍
  쇼케이스 응원법 본편 쇼츠 숏츠 브이로그 먹방 챌린지 리뷰 후기 해외반응 유튜브 에피소드
  플레이리스트 플리
`))

// 뜻이 없는 기능어와, 너무 흔해서 그것만으로는 트렌드라 할 수 없는 말.
// 혼자서는 후보가 되지 못하고 어절 묶음의 양 끝도 되지 못하지만, 따옴표·태그로 묶인 말 안에서는 그대로 둔다
// ("오늘 뭐 먹지"에서 '오늘'을, "별의 노래"에서 '노래'를 떼면 다른 말이 된다).
const COMMON_WORDS = new Set(words(`
  그리고 그런데 하지만 그래서 그러나 그럼 근데 진짜 정말 너무 완전 아주 매우 드디어 결국 역시 이제
  지금 오늘 내일 어제 요즘 이번 다음 지난 우리 내가 제가 나는 저는 이거 그거 저거 이런 그런 저런
  어떤 모든 다시 바로 그냥 계속 아직 벌써 이미 같이 함께 하는 있는 없는 되는 같은 위한 대한 통해
  때문에 이 그 저 및 등 수 것 더 또
  the and for with from this that you your
  공식 영상 방송 무대 안무 가사 단독 최초 공개 최신 인기 급상승 추천 구독 좋아요 알림 근황 반응
  채널 시리즈 특집 스페셜 인터뷰 노래 음악 레전드 요약 컴백 발매 음원 뉴스 속보 예능 드라마 영화
  애니 게임 일상
`))

// 해시태그·태그에서 낱말 끝에 붙여 쓰는 형식 문구(#얼죽아챌린지 → 얼죽아). 앞말이 두 글자 이상일 때만 뗀다.
const GLUED_SUFFIX = /(?<=.{2})(?:챌린지|먹방|브이로그|직캠|리뷰|모음)$/u

// 숫자·날짜·회차·화질: 2026, 11월, 12화, 4k
const NUMBER_PATTERN = /^제?\d+(?:k|p|fps|hz|년|월|일|시|분|초|화|회|부|편|기|탄|차|위|주차|주년|세|살|명|개|만|억|천)?$/
// ep12, 시즌2
const EPISODE_PATTERN = /^(?:ep|e|s|pt|part|vol|ver|season|시즌)\d+$/

// 낱말 모양만으로 형식 문구임을 알 수 있는 것들 (소문자로 바꾼 뒤 견준다)
const FORMAT_PATTERNS = [
  /^[a-z]{1,2}$/, // 두 글자 이하 영문: m/v의 m과 v, vs
  /^[ㄱ-ㅣ]+$/, // 자모만: ㅋㅋ, ㅠㅠ
  NUMBER_PATTERN,
  EPISODE_PATTERN,
]

// 이모지에 딸려 오는 보이지 않는 글자(변형 선택자 U+FE0F 등, 키캡·둘러싸기 부호 U+20E3 등).
// 그림 글자를 걷어 낸 뒤에도 남아 낱말처럼 보이므로 먼저 지운다. 키캡 숫자(1️⃣)는 숫자만 남는다.
const EMOJI_REMNANTS = /[︀-️⃐-⃿\u{E0100}-\u{E01EF}]/gu

// 띄어 쓰지 않고 붙인 형식 문구(#OfficialMV, #공식MV, #4K직캠, #11월11일)를 낱말로 나눠 볼 때 쓰는 한도
const GLUED_MIN = 3
const GLUED_MAX = 40
const CLASS_CACHE_MAX = 20_000

const HASHTAG = /#([\p{L}\p{N}_]{1,40})/gu

// 따옴표로 묶은 말. 곧은따옴표와 ’는 don't 같은 낱말 속 아포스트로피와 헷갈리지 않게 앞뒤가 글자가 아닐 때만 인정한다.
const QUOTES = [
  /“([^“”]{2,40})”/gu,
  /「([^「」]{2,40})」/gu,
  /『([^『』]{2,40})』/gu,
  /‘([^‘’]{2,40})’(?![\p{L}\p{N}])/gu,
  /(?<![\p{L}\p{N}])"([^"]{2,40})"(?![\p{L}\p{N}])/gu,
  /(?<![\p{L}\p{N}])'([^']{2,40})'(?![\p{L}\p{N}])/gu,
]

// 제목을 끊는 자리: 괄호, 세로줄(한글 모음 ㅣ를 세로줄처럼 쓰기도 한다), 가운뎃점, 따옴표, 해시, 쉼표·물음표 따위,
// 띄어 쓴 줄표, 말줄임표와 문장 끝 마침표. 어절 묶음은 이 경계를 넘지 않는다.
const SEGMENT_BREAK = /[\[\](){}<>【】「」『』〈〉《》|│┃¦ㅣ\/:;,!?~…·•ㆍ"'“”‘’#]+|\s[-–—]+\s|\.{2,}|\.(?=\s|$)/u

const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

/** @param {number|Date} now */
export function toIsoTime(now) {
  const date = new Date(now)
  if ((typeof now !== 'number' && !(now instanceof Date)) || Number.isNaN(date.getTime())) throw new TypeError('now는 밀리초 숫자나 Date여야 합니다.')
  return date.toISOString()
}

/** 개수 제한을 읽는다. 쓸 수 없는 값이면 기본값. */
export function toLimit(max, fallback) {
  return Number.isFinite(max) && max >= 1 ? Math.min(Math.floor(max), DRAFTS_MAX) : fallback
}

const isUsableVideo = (video) => typeof video?.title === 'string' && typeof video.url === 'string' && WATCH_URL.test(video.url)

/**
 * 추출기가 믿고 쓸 수 있는 영상만, 필요한 값만 남긴다. 제목과 태그는 표기를 맞춰 둔다(전각 기호 → 반각).
 * @returns {{ title: string, tags: string[], categoryId: string, rank: number, url: string }[]}
 */
export function usableVideos(videos, limit = VIDEOS_MAX) {
  if (!Array.isArray(videos)) return []
  return videos
    .filter(isUsableVideo)
    .slice(0, limit)
    .map((video) => ({
      title: foldText(video.title.slice(0, TITLE_MAX)),
      tags: (Array.isArray(video.tags) ? video.tags : [])
        .filter((tag) => typeof tag === 'string')
        .slice(0, TAGS_MAX)
        .map((tag) => foldText(tag.slice(0, TAG_MAX))),
      categoryId: typeof video.categoryId === 'string' ? video.categoryId : '',
      rank: Number.isFinite(video.rank) && video.rank >= 1 ? video.rank : RANK_UNKNOWN,
      url: video.url,
    }))
}

const bestRanked = (videos) => videos.reduce((best, video) => (video.rank < best.rank ? video : best))

/**
 * 추출기 공통: 근거 영상들로 초안을 만든다.
 * 점수 = 근거 영상 수 + 1 / (가장 높은 차트 순위 + 1). 여러 영상에 나온 말이 먼저, 같으면 차트 위쪽 영상에 나온 말이 먼저다.
 * @param {{ keyword: string, supporters: { rank: number, url: string }[], sourceVideo?: { url: string }, collectedAt: string, details?: object }} input
 */
export function createDraft({ keyword, supporters, sourceVideo = bestRanked(supporters), collectedAt, details = {} }) {
  const score = supporters.length + 1 / (bestRanked(supporters).rank + 1)
  return {
    key: normalizeKeyword(keyword),
    keyword,
    kind: 'keyword',
    pattern: null,
    meaning: '',
    origin: '',
    caution: '',
    category: '일상',
    ...details,
    source: { type: 'youtube', label: SOURCE_LABEL, url: sourceVideo.url, title: null },
    stats: { videoCount: supporters.length },
    collectedAt,
    score: Math.round(score * 10_000) / 10_000,
    meaningVerified: false,
  }
}

const PIECE_MAX = Math.max(...[...FORMAT_WORDS, ...COMMON_WORDS].map((word) => word.length), 12)

// 낱말로 나눠 볼 때의 조각: 형식 낱말·숫자 꼴은 형식 조각, 두 글자 이상 흔한 말은 흔한 조각.
// 한 글자 기능어('이', '수' …)와 두 글자 이하 영문은 조각으로 치지 않는다(아무 말이나 잘게 나뉘어 버린다).
const isFormatPiece = (piece) => (piece.length >= 2 && FORMAT_WORDS.has(piece)) || NUMBER_PATTERN.test(piece) || EPISODE_PATTERN.test(piece)
const isCommonPiece = (piece) => piece.length >= 2 && COMMON_WORDS.has(piece)

/**
 * 붙여 쓴 낱말이 형식 문구·흔한 말 조각으로만 빈틈없이 나뉘는지 본다.
 * @returns {'format'|'common'|null} 형식 조각이 하나라도 있으면 'format', 흔한 말뿐이면 'common'
 */
function gluedKind(word) {
  const size = word.length
  if (size < GLUED_MIN || size > GLUED_MAX) return null
  const reach = new Array(size + 1).fill(false)
  const withFormat = new Array(size + 1).fill(false)
  reach[0] = true
  for (let start = 0; start < size; start++) {
    if (!reach[start]) continue
    for (let end = start + 1; end <= Math.min(size, start + PIECE_MAX); end++) {
      // 통째로 맞는 경우는 classify가 따로 본다: 여기서는 둘 이상으로 나뉘어야 한다
      if (start === 0 && end === size) continue
      const piece = word.slice(start, end)
      const format = isFormatPiece(piece)
      if (!format && !isCommonPiece(piece)) continue
      reach[end] = true
      if (format || withFormat[start]) withFormat[end] = true
    }
  }
  return withFormat[size] ? 'format' : reach[size] ? 'common' : null
}

const classCache = new Map()

/** 낱말 하나를 가른다. 같은 낱말이 아주 많이 되풀이되므로 결과를 기억해 둔다. */
function classify(token) {
  const word = token.toLowerCase()
  let kind = classCache.get(word)
  if (kind !== undefined) return kind
  if (FORMAT_WORDS.has(word) || FORMAT_PATTERNS.some((pattern) => pattern.test(word))) kind = 'format'
  else if (COMMON_WORDS.has(word)) kind = 'common'
  else kind = gluedKind(word)
  if (classCache.size >= CLASS_CACHE_MAX) classCache.clear()
  classCache.set(word, kind)
  return kind
}

/** 형식·홍보 문구(붙여 쓴 것 포함)인지 */
const isFormat = (token) => classify(token) === 'format'

/** 혼자서는 후보가 못 되는 말(형식 문구이거나 흔한 말)인지 */
const isFiller = (token) => classify(token) !== null

/** 글자와 숫자만 남겨 낱말로 쪼갠다. 낱말 끝에 붙은 ㅋㅋ·ㅠㅠ도 뗀다. */
function tokenize(text) {
  return text
    .replace(EMOJI_REMNANTS, '')
    .replace(/[^\p{L}\p{M}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((token) => splitTail(token).core || token)
}

/**
 * 후보 문구를 다듬는다: 기호를 걷어 내고, 앞뒤에 붙은 형식 문구를 떼고, 길이(2~20자)를 확인한다.
 * @returns {{ key: string, keyword: string }|null} 쓸 수 없는 문구면 null
 */
function cleanPhrase(raw) {
  const tokens = tokenize(raw)
  let start = 0
  let end = tokens.length
  const trim = () => {
    while (start < end && isFormat(tokens[start])) start++
    while (end > start && isFormat(tokens[end - 1])) end--
  }
  trim()
  // 끝 낱말에 붙은 형식 문구를 뗀 뒤 다시 다듬는다: #4K직캠 → 4K, #직캠모음 → 직캠도 형식 문구라 남지 않는다
  if (end > start) {
    tokens[end - 1] = tokens[end - 1].replace(GLUED_SUFFIX, '')
    trim()
  }
  const kept = tokens.slice(start, end)
  if (kept.every(isFiller)) return null
  const keyword = kept.join(' ')
  const length = charLength(keyword)
  if (length < KEYWORD_MIN || length > KEYWORD_MAX) return null
  return { key: normalizeKeyword(keyword), keyword }
}

const captures = (text, pattern) => Array.from(text.matchAll(pattern), (match) => match[1])

/** 제목에서 이어진 두세 어절 묶음. 양 끝은 뜻 있는 말이어야 하고, 형식 문구가 낀 묶음은 만들지 않는다. */
function wordRunsOf(title) {
  const runs = []
  for (const segment of title.split(SEGMENT_BREAK)) {
    const tokens = tokenize(segment)
    for (const size of RUN_SIZES) {
      for (let start = 0; start + size <= tokens.length; start++) {
        const run = tokens.slice(start, start + size)
        if (!isFiller(run[0]) && !isFiller(run.at(-1)) && !run.some(isFormat)) runs.push(run.join(' '))
      }
    }
  }
  return runs
}

// 후보를 찾는 네 가지 길. minVideos는 그 길에서 몇 개 영상에 나와야 후보로 인정하는지다.
// 해시태그·따옴표·태그는 올린 사람이 직접 표시한 말(marked)이다. 해시태그와 따옴표는 한 번만 나와도 받고, 태그는 두 영상 이상에서 겹칠 때 받는다.
// 어절 묶음은 제목에서 기계적으로 묶은 것이라, 두 영상 이상에서 되풀이될 때만 받는다.
const SOURCES = [
  { name: 'hashtag', minVideos: 1, marked: true, pick: (video) => captures(video.title, HASHTAG).slice(0, HASHTAGS_PER_TITLE) },
  { name: 'quote', minVideos: 1, marked: true, pick: (video) => QUOTES.flatMap((pattern) => captures(video.title, pattern)) },
  { name: 'tag', minVideos: 2, marked: true, pick: (video) => video.tags },
  { name: 'run', minVideos: 2, marked: false, pick: (video) => wordRunsOf(video.title) },
]

function recordSighting(entries, phrase, videoIndex, source) {
  let entry = entries.get(phrase.key)
  if (!entry) {
    entry = { key: phrase.key, forms: new Map(), videos: new Set(), bySource: new Map(), marked: false, qualified: false }
    entries.set(phrase.key, entry)
  }
  entry.forms.set(phrase.keyword, (entry.forms.get(phrase.keyword) ?? 0) + 1)
  entry.videos.add(videoIndex)
  const seenIn = entry.bySource.get(source.name) ?? new Set()
  entry.bySource.set(source.name, seenIn.add(videoIndex))
  if (source.marked) entry.marked = true
  if (seenIn.size >= source.minVideos) entry.qualified = true
}

/** 같은 열쇠(띄어쓰기·대소문자 무시)끼리 모으고, 어느 길에서든 기준을 채운 후보만 남긴다. */
function collectCandidates(videos) {
  const entries = new Map()
  videos.forEach((video, index) => {
    for (const source of SOURCES) {
      for (const raw of source.pick(video)) {
        const phrase = cleanPhrase(raw)
        if (phrase) recordSighting(entries, phrase, index, source)
      }
    }
  })
  return [...entries.values()].filter((entry) => entry.qualified)
}

/** 열쇠에서 잘라 낼 수 있는 더 짧은 토막을 긴 것부터 차례로 낸다. */
function* partsOf(key, minSize) {
  for (let size = key.length - 1; size >= minSize; size--) {
    for (let start = 0; start + size <= key.length; start++) yield key.slice(start, start + size)
  }
}

/**
 * 기계적으로 묶은 어절 묶음 가운데, 더 긴 후보의 토막일 뿐인 것을 버린다.
 * ('비 오는 날'이 두 영상에 나오면 '비 오는'과 '오는 날'도 같은 두 영상에 나오지만 따로 볼 말이 아니다.)
 */
function dropFragments(entries) {
  const byKey = new Map(entries.map((entry) => [entry.key, entry]))
  const fragments = new Set()
  for (const whole of entries) {
    for (const part of partsOf(whole.key, KEYWORD_MIN)) {
      const entry = byKey.get(part)
      if (entry && !entry.marked && entry.videos.isSubsetOf(whole.videos)) fragments.add(entry)
    }
  }
  return entries.filter((entry) => !fragments.has(entry))
}

/** 이 열쇠 안에 통째로 들어 있으면서 길이가 절반을 넘는, 이미 남겨 둔 가장 긴 열쇠를 찾는다. */
function findHost(key, kept) {
  for (const part of partsOf(key, Math.floor(key.length / 2) + 1)) {
    const host = kept.get(part)
    if (host) return host
  }
  return null
}

/**
 * 거의 같은 말을 합친다: '두바이 초콜릿 케이크'가 '두바이 초콜릿'을 품고 있으면 짧은 쪽 표기로 모으고 근거 영상을 더한다.
 * 절반 넘게 겹칠 때만 합치므로 '두바이'가 '두바이 초콜릿'을 삼키지는 않는다.
 */
function mergeNearDuplicates(entries) {
  const kept = new Map()
  const shortestFirst = [...entries].sort((a, b) => a.key.length - b.key.length || compareText(a.key, b.key))
  for (const entry of shortestFirst) {
    const host = findHost(entry.key, kept)
    if (!host) kept.set(entry.key, entry)
    else for (const index of entry.videos) host.videos.add(index)
  }
  return [...kept.values()]
}

/** 가장 자주 나온 표기를 고른다. 같으면 띄어 쓴(더 긴) 표기를 쓴다. */
function displayForm(forms) {
  const [[form]] = [...forms].sort(([a, countA], [b, countB]) => countB - countA || b.length - a.length || compareText(a, b))
  return form
}

/**
 * @param {object[]} videos youtube.js의 VideoMeta 목록
 * @param {{ now?: number|Date, max?: number }} [options]
 * @returns {object[]} TrendDraft 목록 (점수 높은 순)
 */
export function extractKeywordTrends(videos, options) {
  const { now = Date.now(), max = 30 } = options ?? {}
  const collectedAt = toIsoTime(now)
  const usable = usableVideos(videos)
  return mergeNearDuplicates(dropFragments(collectCandidates(usable)))
    .map((entry) => createDraft({ keyword: displayForm(entry.forms), supporters: Array.from(entry.videos, (index) => usable[index]), collectedAt }))
    .sort(byScore)
    .slice(0, toLimit(max, 30))
}
