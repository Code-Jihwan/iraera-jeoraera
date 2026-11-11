// 카카오톡 대화 내보내기 파일을 브라우저 안에서 읽어 말한 사람별 메시지로 나눈다.
// 말투 분석에는 사용자 본인의 메시지만 쓰고, 원문은 기기 밖으로 나가지 않는다.
// 내보내기 모양은 기기·언어·시기마다 달라서 파일 이름이 아니라 줄 모양으로 형식을 가려낸다.

import { LIMITS } from './constants.js'

/** 이보다 긴 입력은 최근 부분만 읽는다 (UTF-16 단위) */
const MAX_INPUT_CHARS = 16_000_000
/** 이보다 길면 이름으로 보지 않는다. 본문 속 괄호·쌍점을 이름 경계로 잘못 읽는 일을 줄인다. */
const MAX_NAME_CHARS = 100
/** 알림 문구로 볼 수 있는 최대 길이, 그리고 '사진' 같은 대체 문구나 링크뿐인 본문으로 볼 수 있는 최대 길이 */
const MAX_NOTICE_CHARS = 500
const MAX_PLACEHOLDER_CHARS = 2000
/**
 * 요일 날짜 줄로 볼 수 있는 최대 길이. 진짜 줄은 70자 안팎이다.
 * 아주 긴 줄표 줄에 정규식을 돌리면 V8의 되추적 스택이 넘쳐 예외가 나므로 길이부터 본다.
 */
const MAX_DATE_LINE_CHARS = 120
/** 형식을 가릴 때 살펴보는 줄 수와, 머리글이 없는 글에서 필요한 최소 일치 줄 수 */
const DETECT_SAMPLE_LINES = 500
const DETECT_MIN_HITS = 3
/** 잘린 이름을 되살릴 때 필요한 최소 메시지 수 (두세 번 같은 말로 시작한 것은 우연일 수 있다) */
const NAME_RESTORE_MIN_MESSAGES = 5

const MERIDIEM = '(?:오전|오후|AM|PM)'
const CLOCK = '\\d{1,2}:\\d{2}'
const KO_DAY = '\\d{4}년 \\d{1,2}월 \\d{1,2}일'
const EN_MONTH = '(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)'
const EN_CLOCK = `${CLOCK}(?: ?(?:AM|PM))?`

/** 요일이 붙은 날짜 줄. PC 파일은 양옆에 줄표가 붙는데, 대화창에서 복사한 글처럼 줄표가 없어도 받아 준다. */
const WEEKDAY_DATES = [
  new RegExp(`^(?:-{5,} )?${KO_DAY} [월화수목금토일]요일(?: -{5,})?$`),
  new RegExp(`^(?:-{5,} )?(?:Sun|Mon|Tues|Wednes|Thurs|Fri|Satur)day, ${EN_MONTH} \\d{1,2}, \\d{4}(?: -{5,})?$`),
]

/** 파일 머리글의 둘째 줄. 여러 조각을 이어 붙인 글에서는 중간에도 나온다. */
const SAVED_DATE = /^(?:저장한 날짜|Date Saved) : /

/** PC: [이름] [오후 3:20] 본문 — 이름에 괄호가 있어도 시각 괄호 바로 앞까지만 이름으로 읽는다 */
const PC_HEAD = new RegExp(`^\\[(.{0,${MAX_NAME_CHARS}}?)\\] \\[(?:${MERIDIEM} )?${EN_CLOCK}\\](?: (.*))?$`, 's')

const CSV_HEADER = /^Date,User,Message\s*$/
const CSV_DATE = '\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}'
const CSV_DATE_CHARS = 19
const CSV_ROW = new RegExp(`^${CSV_DATE},`)
/** 날짜와 쉼표 뒤에 따옴표가 하나만 오는 줄은 값 속의 줄일 수 없으니(값 안의 따옴표는 ""로 적힌다) 새 행이 확실하다. */
const CSV_FRESH_ROW = new RegExp(`^${CSV_DATE},"(?!")`)
/**
 * 머리글이 없는 글에서 맥 내보내기 행으로 세는 꼴: 이름과 본문을 따옴표로 감싼 '날짜,"이름","'.
 * 따옴표 없는 '날짜,이름,내용'은 흔한 로그 모양이라 카카오톡으로 보지 않는다.
 */
const CSV_QUOTED_ROW = new RegExp(`^${CSV_DATE},"(?:[^"]|""){0,${MAX_NAME_CHARS * 2}}","`)

const URL_TOKEN = /^(?:https?:\/\/|www\.)\S+$/i

/** 메시지가 아닌 줄(날짜 줄·알림 줄)이라는 표시 */
const SKIP = Symbol('skip')

/**
 * 보낸 사람 없이 찍히는 입·퇴장·초대·방장 알림의 끝부분.
 * 일상 대화는 마침표 없이 쓰는 일이 많아, 마침표까지 같을 때만 알림으로 본다.
 * '손님이 들어왔습니다.'처럼 사람이 칠 만한 합쇼체 문장과도 끝이 같으므로, 보낸 사람이 없는 줄,
 * 이름 칸에 끼어든 알림, 맥 CSV의 한 행 전체에만 쓴다. 이름이 붙은 메시지의 본문에는 쓰지 않는다.
 */
const ACTOR_NOTICE_ENDINGS = [
  '님이 들어왔습니다.',
  '님이 나갔습니다.',
  '님을 내보냈습니다.',
  '님을 초대했습니다.',
  '님을 초대하였습니다.',
  '님이 방장이 되었습니다.',
  '님이 부방장이 되었습니다.',
  '부방장에서 해제되었습니다.',
  '채팅방을 개설했습니다.',
  '방장으로 지정되었습니다.',
  ' joined this chatroom.',
  ' left this chatroom.',
  ' has been removed from this chatroom.',
]

const ACTOR_NOTICE_PATTERNS = [/^.{1,60} invited .{1,300}\.$/]

/** 문장 전체가 정해진 알림. 사람이 그대로 칠 일이 거의 없어 어느 자리에 있든 뺀다. */
const FIXED_NOTICE_PATTERNS = [
  /^메시지가 삭제되었습니다\.?$/,
  /^(?:채팅방 )?관리자가 메시지를 가렸습니다\.?$/,
  /^관리자만 말하기 기능이 (?:활성화|해제)되었습니다\.?$/,
  /^The message has been deleted\.$/,
]
// 오픈채팅 입장 알림에 따라붙는 안내문. 내보내기 파일에도 적히는지는 확인하지 못했지만 사람이 칠 문장은 아니다.
const FIXED_NOTICE_ENDING = '카카오톡 이용에 제한이 있을 수 있습니다.'

/**
 * 사진·파일·통화처럼 글이 아닌 내용을 대신해 적히는 본문. 본문 전체가 이 꼴일 때만 뺀다
 * ('사진 찍었어'는 진짜 말이다). '사진' 한 마디를 직접 친 경우까지 빠지는 것은 감수한다.
 */
const PLACEHOLDER_PATTERNS = [
  // 사진·동영상·이모티콘 등 첨부
  /^(?:사진|동영상|이모티콘|음성메시지|음성 메시지|파일|지도|연락처|일정|투표|보이스룸|라이브톡|Photo)$/,
  /^(?:사진|동영상) ?\d+ ?[장개]$/,
  /^<.{1,40}읽지 않음>$/,
  /^\(이모티콘(?:_[^)]{0,80})?\)$/,
  /^(?:파일|샵검색|지도|위치|연락처|일정) ?: ?\S/,
  /^샵검색 #/,
  // 본문에 파일 이름만 남은 첨부
  /^[a-z0-9]{64}\.[a-z0-9]{3,4}$/i,
  /^\S+\.(?:jpe?g|png|gif|webp|heic|bmp|mp4|mov|avi|3gp|m4a|mp3|wav|pdf|docx?|xlsx?|pptx?|hwpx?|zip)$/i,
  // 지운 메시지
  /^\(?삭제된 메시지입니다\.?\)?$/,
  // 아래는 실제 내보내기 파일에서 확인하지 못한 문구다.
  // 통화·송금 알림이 말투에 섞이지 않게 하되, 진짜 말을 잃지 않도록 꼭 이 꼴일 때만 뺀다.
  /^(?:보이스톡|페이스톡) (?:해요|부재중|취소|응답 없음|\d{1,2}:\d{2}(?::\d{2})?)$/,
  /^[\d,]+원을 (?:보냈어요|받았어요)\.?$/,
  /^.{0,40}(?:송금봉투가 도착했어요|송금봉투를 받았어요|정산 내용을 확인해주세요|자동환불 (?:예정|완료))[.!]?$/,
  /^카카오톡 프로필$/,
  /^톡게시판 '(?:공지|투표|일정)': /,
  /^(?:Video|Emoticons?|Voice Message|File|This message was deleted\.)$/,
]

const CSV_FAMILY = { format: 'mac-csv', head: csvHead, parse: parseCsv }

/** 모바일 txt 계열: '<날짜·시각>, 이름 : 본문' */
const mobile = (format, stamp, extra = {}) => ({ format, head: stampedHead(stamp), parse: parseText, colonNames: true, ...extra })

/**
 * 형식 계열. 한 줄은 위에서부터 처음 맞는 계열의 것으로 세므로 모양이 더 구체적인 계열을 앞에 둔다
 * (옛 모바일 줄은 '시각만' 계열에도 맞는다).
 * 오전/오후가 없는 24시간 표기는 실제 파일로 확인하지 못했지만 받아 준다.
 * - head(line, probe): 메시지 첫 줄이면 { speaker, body }, 날짜·알림 줄이면 SKIP, 머리말이 없는 줄이면 null
 * - bareNotices: 알림이 머리말 없이 한 줄로 찍히는 형식
 * - colonNames: 이름과 본문을 ' : '로만 구분해서 이름이 잘릴 수 있는 형식
 * - afterWeekday: 요일 날짜 줄이 먼저 나온 글에서만 인정하는 형식
 */
const FAMILIES = [
  CSV_FAMILY,
  { format: 'pc', head: bracketHead, parse: parseText, bareNotices: true },
  // 안드로이드: 2021년 12월 29일 오후 8:36, 이름 : 본문
  mobile('android', `${KO_DAY} (?:${MERIDIEM} )?${CLOCK}`),
  // 아이폰: 2024. 3. 14. 오후 7:12, 이름 : 본문
  mobile('ios', `\\d{4}\\. ?\\d{1,2}\\. ?\\d{1,2}\\. (?:${MERIDIEM} )?${CLOCK}(?: (?:AM|PM))?`),
  // 안드로이드(영문): February 10, 2016, 2:33 AM, you : Photo
  mobile('android', `${EN_MONTH} \\d{1,2}, \\d{4},? ${EN_CLOCK}`),
  // 아이폰(영문): Dec 31, 2014 at 19:12, 이름 : hello
  mobile('ios', `${EN_MONTH} \\d{1,2}, \\d{4},? at ${EN_CLOCK}`),
  // 2011~2012년 무렵 모바일: 오후 10:50, 2011년 11월 6일, 이름 : 본문 — 기기를 가릴 단서가 없어 android로 묶는다
  mobile('android', `(?:오전|오후) ${CLOCK}, ${KO_DAY}`),
  // 아이폰(시각만): 오후 8:36, 이름 : 본문 — 다른 파서의 테스트에서만 본 모양이고, 머리말이 짧아 보통 글과 헷갈린다
  mobile('ios', `(?:오전|오후) ${CLOCK}`, { afterWeekday: true }),
]

/**
 * 내보내기 파일의 글을 말한 사람별 메시지로 나눈다.
 * 아는 형식이 아니면 format이 'unknown'이고 나머지는 비어 있다.
 * @param {string} rawText
 * @returns {{ format: 'android'|'ios'|'pc'|'mac-csv'|'unknown', speakers: {name:string, count:number}[], total: number, messages: {speaker:string, text:string}[] }}
 */
export function parseChatExport(rawText) {
  const lines = toLines(rawText)
  const family = detectFamily(lines)
  if (!family) return { format: 'unknown', speakers: [], total: 0, messages: [] }
  const messages = family.parse(lines, family)
  return { format: family.format, speakers: countSpeakers(messages), total: messages.length, messages }
}

/**
 * 한 사람의 메시지만 골라 한 줄씩의 발화로 돌려준다.
 * '사진' 같은 대체 문구, 지운·가린 메시지 알림, 링크뿐인 줄은 여러 줄 메시지 속에 있어도 뺀다.
 * 직접 친 줄이었더라도 말투 단서가 없으니, 빼야 프로필이 덜 흐려진다.
 * 입·퇴장 알림 꼴의 문장('손님이 들어왔습니다.')은 남긴다. 그런 알림은 parseChatExport가 이미 걸러 냈고,
 * 이름이 붙은 메시지 속에 있다면 사람이 친 합쇼체 문장이다.
 * 개수가 넘치면 최근 것을 남긴다(지금의 말투에 더 가깝다). 순서는 시간순 그대로다.
 * @param {{ messages?: {speaker:string, text:string}[] }} parsed parseChatExport의 결과
 * @param {string} speakerName 사용자가 고른 자기 이름 (앞뒤 공백과 자모 풀림은 무시하고 견준다)
 * @param {{ maxUtterances?: number }} [options] 기본 상한은 LIMITS.text.maxUtterances
 * @returns {string[]}
 */
export function extractOwnUtterances(parsed, speakerName, options) {
  const messages = Array.isArray(parsed?.messages) ? parsed.messages : []
  const own = nameKey(speakerName)
  const cap = utteranceCap(options?.maxUtterances)
  if (!own) return []
  const recent = []
  for (let i = messages.length - 1; i >= 0 && recent.length < cap; i--) {
    const { speaker, text } = messages[i] ?? {}
    if (typeof text !== 'string' || nameKey(speaker) !== own) continue
    const lines = utteranceLines(text)
    for (let j = lines.length - 1; j >= 0 && recent.length < cap; j--) recent.push(lines[j])
  }
  return recent.reverse()
}

/**
 * 사람이 쓴 말이 아닌 본문인지: 시스템 알림, 글이 아닌 내용을 대신하는 문구(사진·파일·통화·송금 등), 링크뿐인 메시지.
 * @param {string} text
 * @returns {boolean}
 */
export function isSystemMessage(text) {
  return isNonSpeech(text, true)
}

/**
 * 말투 단서가 없는 본문인지. withActorNotices가 false면 입·퇴장·초대 알림 꼴은 따지지 않는다
 * (이름이 붙은 메시지 속의 '…님이 들어왔습니다.'는 사람이 친 합쇼체 문장일 수 있다).
 */
function isNonSpeech(text, withActorNotices) {
  if (typeof text !== 'string') return false
  const body = text.trim()
  if (!body || body.length > MAX_PLACEHOLDER_CHARS) return false
  if (isLinkOnly(body)) return true
  if (/[\r\n]/.test(body)) return false // 여러 줄은 사람이 쓴 글이다
  return (withActorNotices ? isNotice(body) : isFixedNotice(body)) || PLACEHOLDER_PATTERNS.some((re) => re.test(body))
}

function toLines(rawText) {
  if (typeof rawText !== 'string') return ['']
  // 대화는 시간순이라 끝쪽이 최근이다
  const text = rawText.length > MAX_INPUT_CHARS ? rawText.slice(-MAX_INPUT_CHARS) : rawText
  // 조각 파일을 이어 붙인 글에는 BOM이 중간에도 남는다
  return text.replace(/\u{FEFF}/gu, '').split(/\r\n?|\n/)
}

/**
 * 시각에 줄 바꿈 없는 공백(U+00A0·U+202F)이 섞여 있어도 맞도록 보통 공백으로 바꾼 줄.
 * 길이가 같아서 여기서 찾은 위치를 원문에 그대로 쓸 수 있다(이름은 원문에서 잘라 낸다).
 */
function toProbe(line) {
  return line.replace(/[\u{00A0}\u{202F}]/gu, ' ')
}

function detectFamily(lines) {
  if (CSV_HEADER.test(lines[0])) return CSV_FAMILY
  const hits = new Map(FAMILIES.map((family) => [family, 0]))
  let sampled = 0
  let sawWeekday = false
  for (const line of lines) {
    if (!line.trim()) continue
    if (++sampled > DETECT_SAMPLE_LINES) break
    const probe = toProbe(line)
    const family = FAMILIES.find((f) => (sawWeekday || !f.afterWeekday) && f.head(line, probe) !== null)
    if (family) hits.set(family, hits.get(family) + 1)
    else if (isWeekdayDate(probe.trim())) sawWeekday = true
  }
  const best = FAMILIES.reduce((a, b) => (hits.get(b) > hits.get(a) ? b : a))
  // 카카오톡 머리글이 있으면 메시지가 한두 개뿐인 파일도 받아 준다
  const needed = lines.slice(0, 5).some((line) => SAVED_DATE.test(line)) ? 1 : DETECT_MIN_HITS
  return hits.get(best) >= needed ? best : null
}

function isWeekdayDate(text) {
  return text.length <= MAX_DATE_LINE_CHARS && WEEKDAY_DATES.some((re) => re.test(text))
}

/** 형식 가리기에만 쓴다. 머리글이 있으면 detectFamily가 먼저 맥 CSV로 정하고, 읽기는 parseCsv가 한다. */
function csvHead(line) {
  return CSV_QUOTED_ROW.test(line) ? SKIP : null
}

function bracketHead(line, probe) {
  const m = PC_HEAD.exec(probe)
  if (!m) return null
  const speaker = line.slice(1, 1 + m[1].length)
  if (!isName(speaker)) return SKIP // 이름 칸이 빈 알림 줄
  return { speaker, body: line.slice(line.length - (m[2]?.length ?? 0)) }
}

/** '<날짜·시각>' 머리말로 시작하는 줄을 읽는 함수를 만든다. */
function stampedHead(stampSource) {
  const stamp = new RegExp(`^${stampSource}`)
  return (line, probe) => {
    const m = stamp.exec(probe)
    if (!m) return null
    const rest = probe.slice(m[0].length)
    // 시각만 있는 줄은 날짜 줄, 시각 뒤에 쌍점이 바로 오는 줄은 아이폰의 알림 줄이다
    if (!rest.trim() || rest.startsWith(': ')) return SKIP
    if (!rest.startsWith(', ')) return null
    return splitSpeaker(line.slice(m[0].length + 2))
  }
}

/** '이름 : 본문'을 첫 ' : '에서 나눈다. 나눌 수 없으면 보낸 사람이 없는 알림 줄이다. */
function splitSpeaker(full) {
  // 줄 끝 공백이 지워진 파일에서는 빈 본문이 '이름 :'으로 끝난다
  const sep = `${full} `.indexOf(' : ')
  const speaker = full.slice(0, Math.max(sep, 0))
  return isName(speaker) ? { speaker, body: full.slice(sep + 3), full } : SKIP
}

/** 이름으로 볼 수 있는 값인지: 비어 있지 않고 지나치게 길지 않다 */
function isName(text) {
  return text.length <= MAX_NAME_CHARS && text.trim() !== ''
}

/**
 * txt 계열 공통: 머리말이 있는 줄에서 메시지가 시작되고, 머리말 없는 줄은 앞 메시지에 이어진다.
 * 날짜·알림 줄은 그 줄만 건너뛰고 앞 메시지는 닫지 않는다. 진짜 알림 뒤에는 어차피 새 메시지 줄이 오고,
 * 여러 줄 메시지 속에 알림처럼 생긴 줄이 있었던 경우에는 뒤따르는 줄을 잃지 않는다.
 * 다만 '이름 : 본문' 꼴로 끼어든 알림은 앞 메시지를 닫는다. 그 줄이 사실 남의 메시지였다면
 * 이어지는 줄이 앞사람의 말로 들어가 버리기 때문이다.
 */
function parseText(lines, family) {
  const drafts = []
  const known = new Set()
  let open = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const probe = toProbe(line)
    const head = family.head(line, probe)
    if (head === null) {
      if (open && !isBareSystemLine(probe.trim(), lines[i + 1], family)) open.parts.push(line)
    } else if (head === SKIP) {
      continue
    } else if (isDisguisedNotice(head, known) && !continuesBelow(lines, i, family)) {
      open = null
    } else {
      known.add(head.speaker)
      open = { speaker: head.speaker, parts: [head.body] }
      drafts.push(open)
    }
  }
  const messages = toMessages(drafts)
  return family.colonNames ? restoreSplitNames(messages) : messages
}

/**
 * 알림 문구에 ' : '가 들어 있어 '이름 : 본문'처럼 읽힌 줄인지 (이름에 ' : '가 든 사람의 입장 알림 등).
 * 이미 말한 적 있는 이름이면 진짜 메시지로 본다.
 */
function isDisguisedNotice(head, known) {
  return head.full !== undefined && !known.has(head.speaker) && isNotice(head.full)
}

/**
 * i번 줄 다음에(빈 줄은 건너뛰고) 머리말 없는 본문 줄이 오는지.
 * 알림은 한 줄로 끝나므로, 이어지는 줄이 있으면 알림처럼 끝나는 말로 시작한 여러 줄 메시지다.
 * 빈 줄 구간마다 한 번씩만 훑으므로 전체 시간은 줄 수에 비례한다.
 */
function continuesBelow(lines, i, family) {
  let j = i + 1
  while (j < lines.length && !lines[j].trim()) j++
  if (j >= lines.length) return false
  const probe = toProbe(lines[j])
  if (family.head(lines[j], probe) !== null) return false
  const text = probe.trim()
  return !isStructuralLine(text, lines[j + 1]) && !isNotice(text)
}

/** 머리말은 없지만 본문도 아닌 줄: 요일 날짜 줄, 이어 붙인 조각의 머리글(제목 + 저장한 날짜), PC의 알림 줄 */
function isBareSystemLine(text, nextLine, family) {
  if (isStructuralLine(text, nextLine)) return true
  return family.bareNotices ? isNotice(text) : false
}

/** 요일 날짜 줄, 또는 이어 붙인 조각의 머리글(제목 줄 + 저장한 날짜 줄) */
function isStructuralLine(text, nextLine) {
  return isWeekdayDate(text) || SAVED_DATE.test(text) || SAVED_DATE.test(nextLine ?? '')
}

function toMessages(drafts) {
  const messages = []
  for (const { speaker, parts } of drafts) {
    const text = parts.join('\n').trim()
    if (text) messages.push({ speaker, text })
  }
  return messages
}

/**
 * 모바일 txt는 이름과 본문을 ' : '로만 구분해서, 이름에 ' : '가 들어 있으면 뒷부분이 본문으로 넘어간다.
 * 한 사람의 메시지가 하나도 빠짐없이 같은 'X : '로 시작하면 그 X를 이름의 나머지로 보고 되돌린다.
 */
function restoreSplitNames(messages) {
  const bySpeaker = new Map()
  for (const { speaker, text } of messages) {
    const seen = bySpeaker.get(speaker)
    if (!seen) bySpeaker.set(speaker, { lead: leadOf(text), count: 1 })
    else {
      seen.count++
      if (seen.lead !== null && !text.startsWith(seen.lead)) seen.lead = null
    }
  }
  return messages.map((message) => {
    const { lead, count } = bySpeaker.get(message.speaker)
    if (lead === null || count < NAME_RESTORE_MIN_MESSAGES) return message
    return { speaker: `${message.speaker} : ${lead.slice(0, -3)}`, text: message.text.slice(lead.length).trimStart() }
  })
}

/** 본문 첫 줄 맨 앞의 'X : ' (없으면 null) */
function leadOf(text) {
  const firstLine = text.slice(0, MAX_NAME_CHARS + 3).split('\n', 1)[0]
  const sep = firstLine.indexOf(' : ')
  return sep > 0 ? firstLine.slice(0, sep + 3) : null
}

function parseCsv(lines) {
  const messages = []
  for (const record of groupCsvRecords(lines)) {
    const row = splitCsvRecord(record.join('\n').trimEnd())
    if (row && isName(row.speaker) && row.text && !isCsvNotice(row)) messages.push(row)
  }
  return messages
}

/**
 * 입·퇴장 알림 행은 User 칸에 당사자 이름이 적혀 있어도 사람이 한 말이 아니다.
 * 알림처럼 끝나는 문장이라도 User 칸의 사람이 문장 속에 나오지 않으면 그 사람이 친 말로 본다
 * ('방금 손님이 들어왔습니다.'). 알림 행의 User 칸에 누가 적히는지는 다 확인하지 못해 이렇게 가린다.
 */
function isCsvNotice({ speaker, text }) {
  if (isFixedNotice(text)) return true
  if (!isActorNotice(text)) return false
  return text.includes(`${speaker}님`) || text.startsWith(`${speaker} `) || text.includes(` ${speaker} `) || text.includes(` ${speaker}.`)
}

/**
 * 줄들을 CSV 행으로 묶는다. 따옴표 안의 줄바꿈은 같은 행이다.
 * 따옴표 짝이 어긋난 파일이라도 확실한 새 행에서 다시 맞춰, 남의 행이 한 메시지에 딸려 들어가지 않게 한다.
 */
function groupCsvRecords(lines) {
  const records = []
  let open = null // 따옴표가 닫히지 않아 다음 줄로 이어지는 행
  for (const line of lines) {
    const fresh = CSV_ROW.test(line) && (open === null || CSV_FRESH_ROW.test(line))
    if (!fresh && open === null) continue // 머리글, 빈 줄, 날짜 칸이 빈 알림 행
    if (fresh) {
      open = []
      records.push(open)
    }
    open.push(line)
    if (hasOddQuotes(line) !== fresh) open = null
  }
  return records
}

function hasOddQuotes(line) {
  let odd = false
  for (let i = line.indexOf('"'); i !== -1; i = line.indexOf('"', i + 1)) odd = !odd
  return odd
}

/** '날짜,"이름","본문"' 한 행 → { speaker, text }. 이름 칸을 읽을 수 없으면 null */
function splitCsvRecord(record) {
  const fields = record.slice(CSV_DATE_CHARS + 1)
  const userEnd = fields.startsWith('"') ? closingQuote(fields) + 1 : fields.indexOf(',')
  if (userEnd <= 0 || fields[userEnd] !== ',') return null
  return { speaker: unquote(fields.slice(0, userEnd)), text: unquote(fields.slice(userEnd + 1)).trim() }
}

/** 따옴표로 시작하는 값에서 닫는 따옴표의 위치 (""는 따옴표 한 글자). 없으면 -1 */
function closingQuote(text) {
  let from = 1
  for (;;) {
    const at = text.indexOf('"', from)
    if (at === -1 || text[at + 1] !== '"') return at
    from = at + 2
  }
}

function unquote(field) {
  if (!field.startsWith('"')) return field
  const end = field.length > 1 && field.endsWith('"') ? -1 : undefined
  return field.slice(1, end).replaceAll('""', '"')
}

/**
 * 많이 말한 사람부터. 겉보기에 같은 이름(앞뒤 공백·자모 풀림만 다른 이름)은 extractOwnUtterances가
 * 한 사람으로 고르므로 여기서도 한 사람으로 세고, 처음 나온 꼴을 이름으로 쓴다.
 */
function countSpeakers(messages) {
  const byKey = new Map()
  for (const { speaker } of messages) {
    const key = nameKey(speaker)
    const entry = byKey.get(key)
    if (entry) entry.count++
    else byKey.set(key, { name: speaker, count: 1 })
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count)
}

/** 입·퇴장, 초대, 가림 같은 한 줄짜리 시스템 알림인지 (보낸 사람이 없는 줄에 쓴다) */
function isNotice(text) {
  return isFixedNotice(text) || isActorNotice(text)
}

/** 누가 들어오고 나가고 초대했다는 알림 꼴인지. 사람이 친 합쇼체 문장과 헷갈릴 수 있다. */
function isActorNotice(text) {
  if (text.length > MAX_NOTICE_CHARS || /[\r\n]/.test(text)) return false
  return ACTOR_NOTICE_ENDINGS.some((end) => text.length > end.length && text.endsWith(end)) || ACTOR_NOTICE_PATTERNS.some((re) => re.test(text))
}

/** 문장 전체가 정해진 알림인지 (지운 메시지, 가린 메시지, 오픈채팅 안내문) */
function isFixedNotice(text) {
  if (text.length > MAX_NOTICE_CHARS || /[\r\n]/.test(text)) return false
  return (text.length > FIXED_NOTICE_ENDING.length && text.endsWith(FIXED_NOTICE_ENDING)) || FIXED_NOTICE_PATTERNS.some((re) => re.test(text))
}

/** 공백으로 나눈 토막이 모두 링크인지 (정규식 하나로 묶으면 백트래킹이 폭증할 수 있어 토막마다 본다) */
function isLinkOnly(text) {
  return text.split(/\s+/).every((token) => URL_TOKEN.test(token))
}

/** 이름 비교용: 같은 이름이 자모가 풀린 꼴(NFD)로 섞여 와도 같게 보도록 NFC로 맞추고 앞뒤 공백을 뺀다 */
function nameKey(name) {
  return typeof name === 'string' ? name.normalize('NFC').trim() : ''
}

function utteranceCap(value) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : LIMITS.text.maxUtterances
}

function utteranceLines(text) {
  return text
    .split(/\r\n?|\n/)
    .map((line) => line.trim())
    .filter((line) => line && !isNonSpeech(line, false))
}
