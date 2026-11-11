import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { LIMITS } from '../shared/constants.js'
import { extractOwnUtterances, isSystemMessage, parseChatExport } from '../shared/kakao-parser.js'

const BOM = '\u{FEFF}'
const crlf = (lines) => lines.join('\r\n')
const lf = (lines) => lines.join('\n')
const msg = (speaker, text) => ({ speaker, text })
const UNKNOWN = { format: 'unknown', speakers: [], total: 0, messages: [] }

/** 결과의 기본 약속: 합계가 맞고, 화자는 많이 말한 순서다 */
function assertConsistent(parsed) {
  assert.equal(parsed.total, parsed.messages.length)
  assert.equal(parsed.speakers.reduce((sum, s) => sum + s.count, 0), parsed.total)
  for (let i = 1; i < parsed.speakers.length; i++) assert.ok(parsed.speakers[i - 1].count >= parsed.speakers[i].count)
  for (const m of parsed.messages) assert.ok(m.speaker.trim() && m.text.trim(), '빈 이름·빈 본문은 없어야 한다')
}

describe('parseChatExport — 형식별', () => {
  test('PC(한국어): [이름] [오전 1:01] 본문', () => {
    const parsed = parseChatExport(
      crlf([
        '김하나 님과 카카오톡 대화',
        '저장한 날짜 : 2020-11-03 10:44:52',
        '',
        '--------------- 2020년 6월 28일 일요일 ---------------',
        '[김하나] [오전 1:01] 사진',
        '[이두리] [오후 12:03] 내일 몇 시에 봐?',
        '[김하나] [오후 10:10] 아 근데 진짜 졸리다ㅋㅋㅋ',
        '  들여쓴 둘째 줄',
        '',
        '넷째 줄이야',
        '이두리님이 나갔습니다.',
        '김하나님이 이두리님을 초대하였습니다.',
        '--------------- 2020년 6월 29일 월요일 ---------------',
        '[이두리] [오전 9:00] 좋은 아침~',
        '[김하나] [오전 9:01] ㅇㅇ 굿모닝',
      ]),
    )
    assert.equal(parsed.format, 'pc')
    assert.deepEqual(parsed.speakers, [
      { name: '김하나', count: 3 },
      { name: '이두리', count: 2 },
    ])
    assert.deepEqual(parsed.messages, [
      msg('김하나', '사진'),
      msg('이두리', '내일 몇 시에 봐?'),
      msg('김하나', '아 근데 진짜 졸리다ㅋㅋㅋ\n  들여쓴 둘째 줄\n\n넷째 줄이야'),
      msg('이두리', '좋은 아침~'),
      msg('김하나', 'ㅇㅇ 굿모닝'),
    ])
    assertConsistent(parsed)
  })

  test('PC(영어 로케일): 영문 날짜 구분선, AM/PM, 24시간 표기, 이름 칸이 빈 알림 줄', () => {
    const parsed = parseChatExport(
      crlf([
        '--------------- Saturday, July 22, 2023 ---------------',
        '[김하나] [5:27 PM] Hello!',
        '[이두리] [11:05 AM] see you tomorrow',
        '[] [20:35] 시스템 알림',
        '[김하나] [23:34] 첫째 날',
        '둘째 줄',
        '--------------- Sunday, July 23, 2023 ---------------',
      ]),
    )
    assert.equal(parsed.format, 'pc')
    assert.deepEqual(parsed.messages, [msg('김하나', 'Hello!'), msg('이두리', 'see you tomorrow'), msg('김하나', '첫째 날\n둘째 줄')])
    assertConsistent(parsed)
  })

  test('안드로이드(한국어): BOM, 섞인 줄바꿈, 날짜 줄, 회원님, 알림 줄', () => {
    const header = `${BOM}김하나 님과 카카오톡 대화\r\n저장한 날짜 : 2020년 11월 3일 오전 11:29\n\r\n\r\n`
    const parsed = parseChatExport(
      header +
        crlf([
          '2016년 2월 5일 오전 1:33',
          '2016년 2월 5일 오전 1:33, 회원님 : 공부하기',
          '2016년 2월 10일 오후 2:33, 김하나 : 사진',
          '',
          '2021년 12월 29일 오후 8:36',
          '2021년 12월 29일 오후 8:36, 김하나 : 첫 줄',
          '이어지는 줄',
          '2021년 12월 29일 오후 8:35,  : 시스템 알림',
          '2025년 12월 15일 오후 1:14, 이두리님이 들어왔습니다.',
          '2025년 12월 15일 오후 1:15, 이두리 : 안녕하세요!',
          '2025년 12월 15일 오후 1:16, 회원님 : ',
          '첫 줄을 비우고 쓴 말',
        ]),
    )
    assert.equal(parsed.format, 'android')
    assert.deepEqual(parsed.speakers, [
      { name: '회원님', count: 2 },
      { name: '김하나', count: 2 },
      { name: '이두리', count: 1 },
    ])
    assert.deepEqual(parsed.messages, [
      msg('회원님', '공부하기'),
      msg('김하나', '사진'),
      msg('김하나', '첫 줄\n이어지는 줄'),
      msg('이두리', '안녕하세요!'),
      msg('회원님', '첫 줄을 비우고 쓴 말'),
    ])
    assertConsistent(parsed)
  })

  test('안드로이드(영어 로케일): February 10, 2016, 2:33 AM, you : …', () => {
    const header = `${BOM}KakaoTalk Chats with 김하나\r\nDate Saved : November 3, 2020, 1:08 PM\n\n\r\n`
    const parsed = parseChatExport(
      header +
        crlf([
          'February 10, 2016, 2:33 AM',
          'February 10, 2016, 2:33 AM, you : 공부하기',
          'February 10, 2016, 2:33 AM, you : Photo',
          'March 20, 2016, 11:59 PM, 이두리 : first line',
          'second line',
          'October 12, 2020, 6:49 AM, 김하나 : really? why i dont know about that',
        ]),
    )
    assert.equal(parsed.format, 'android')
    assert.deepEqual(parsed.speakers, [
      { name: 'you', count: 2 },
      { name: '이두리', count: 1 },
      { name: '김하나', count: 1 },
    ])
    assert.deepEqual(parsed.messages, [
      msg('you', '공부하기'),
      msg('you', 'Photo'),
      msg('이두리', 'first line\nsecond line'),
      msg('김하나', 'really? why i dont know about that'),
    ])
    assertConsistent(parsed)
  })

  test('아이폰(한국어): 파일 이름이 첫 줄, 요일 날짜 줄, 쌍점·쉼표 알림 줄', () => {
    const parsed = parseChatExport(
      BOM +
        crlf([
          'Talk_2025.11.14 19:02-1.txt',
          '저장한 날짜 : 2025. 11. 16. 오후 2:46',
          '',
          '2024년 3월 14일 목요일',
          '2024. 3. 14. 오후 7:12, 김하나 : 내일 화이트데이인데 뭐 할 거야?',
          '2024. 3. 14. 오후 7:13, 이두리 : 강남역 쪽에 새로 생긴 데 있는데',
          '잠깐만 이름 찾아볼게',
          '2024. 3. 14. 오후 11:46: 박셋님이 들어왔습니다.',
          '2024. 3. 14. 오후 11:47, 김하나님이 최넷님을 초대했습니다.',
          '2024년 3월 15일 금요일',
          '2024. 3. 15. 오전 9:05, 김하나 : 전 솔직히 둘 다 좋아해요',
        ]),
    )
    assert.equal(parsed.format, 'ios')
    assert.deepEqual(parsed.speakers, [
      { name: '김하나', count: 2 },
      { name: '이두리', count: 1 },
    ])
    assert.deepEqual(parsed.messages, [
      msg('김하나', '내일 화이트데이인데 뭐 할 거야?'),
      msg('이두리', '강남역 쪽에 새로 생긴 데 있는데\n잠깐만 이름 찾아볼게'),
      msg('김하나', '전 솔직히 둘 다 좋아해요'),
    ])
    assertConsistent(parsed)
  })

  test('아이폰(영어 로케일): Dec 31, 2014 at 19:12, 이름 : …', () => {
    const parsed = parseChatExport(
      lf([
        'Talk_2026.4.25 10:20-1.txt',
        'Date Saved : Apr 25, 2026 at 10:38',
        '',
        '',
        'Wednesday, December 31, 2014',
        'Dec 31, 2014 at 19:12, 김하나 : hello',
        'continued line',
        'Dec 31, 2014 at 19:12: 김하나 invited 이두리 .',
        'Tuesday, February 17, 2015',
        'Feb 17, 2015 at 21:00, 이두리 : Photo',
        'Feb 17, 2015 at 21:01: 이두리 left this chatroom.',
        'Mar 24, 2023 at 09:00, 김하나 : Day 1 : https://example.com/one',
      ]),
    )
    assert.equal(parsed.format, 'ios')
    assert.deepEqual(parsed.messages, [
      msg('김하나', 'hello\ncontinued line'),
      msg('이두리', 'Photo'),
      msg('김하나', 'Day 1 : https://example.com/one'),
    ])
    assertConsistent(parsed)
  })

  test('아이폰(시각만 적힌 변형): 요일 날짜 줄 아래 "오후 8:36, 이름 : 본문"', () => {
    const parsed = parseChatExport(
      lf([
        '김하나 님과 카카오톡 대화',
        '저장한 날짜 : 2021년 12월 18일 오후 7:17',
        '',
        '',
        '2021년 12월 29일 수요일',
        '오후 8:36, 김하나 : ㅎㅇ',
        '이어지는 줄',
        '오전 12:05, 이두리 : 반가워',
        '오후 8:38, 이두리님이 나갔습니다.',
      ]),
    )
    assert.equal(parsed.format, 'ios')
    assert.deepEqual(parsed.messages, [msg('김하나', 'ㅎㅇ\n이어지는 줄'), msg('이두리', '반가워')])
    assertConsistent(parsed)
  })

  test('옛 모바일(시각이 앞): 시각만 적힌 변형으로 잘못 읽지 않는다', () => {
    const parsed = parseChatExport(
      BOM +
        lf([
          '김하나 님과 카카오톡 대화',
          '저장한 날짜 : 오전 12:09, 2012년 4월 4일',
          '',
          '오후 10:50, 2011년 11월 6일',
          '오후 10:50, 2011년 11월 6일, 김하나 : 안녕하세요',
          '오후 10:51, 2011년 11월 6일, 이두리 : 반갑습니다(방긋)',
          '오후 1:00, 2011년 11월 7일, 김하나 : abc123.jpg',
          '오후 1:01, 2011년 11월 7일, 김하나님이 박셋님을 초대했습니다.',
        ]),
    )
    assert.equal(parsed.format, 'android')
    assert.deepEqual(parsed.speakers, [
      { name: '김하나', count: 2 },
      { name: '이두리', count: 1 },
    ])
    assert.deepEqual(parsed.messages, [msg('김하나', '안녕하세요'), msg('이두리', '반갑습니다(방긋)'), msg('김하나', 'abc123.jpg')])
    assertConsistent(parsed)
  })

  test('맥(CSV): 따옴표 안의 줄바꿈·쉼표·"" 이스케이프, 알림 행', () => {
    const parsed = parseChatExport(
      BOM +
        crlf([
          'Date,User,Message',
          '2021-12-29 20:36:00,"김하나","ㅎㅇ"',
          '2021-12-29 20:37:10,"이두리","첫 줄',
          '""인용"" 포함, 쉼표도 있음"',
          '2021-12-29 20:38:00,"김하나","김하나 invited 박셋 and."',
          '2021-12-29 20:39:00,"박셋","박셋님이 나갔습니다."',
          ',"","메시지가 삭제되었습니다."',
          '2021-12-29 20:40:00,"김하나","사진"',
          '',
        ]),
    )
    assert.equal(parsed.format, 'mac-csv')
    assert.deepEqual(parsed.speakers, [
      { name: '김하나', count: 2 },
      { name: '이두리', count: 1 },
    ])
    assert.deepEqual(parsed.messages, [msg('김하나', 'ㅎㅇ'), msg('이두리', '첫 줄\n"인용" 포함, 쉼표도 있음'), msg('김하나', '사진')])
    assertConsistent(parsed)
  })

  test('카카오톡 파일이 아닌 글은 unknown', () => {
    const diary = lf([
      '3월 14일 목요일 일기',
      '오늘은 날씨가 좋아서 한강에 다녀왔다.',
      '[메모] 장 볼 것: 우유, 계란',
      '2024년 3월 14일 목요일',
      '오후 3:00, 회의 : 2층 회의실',
      '김하나: 내일 봐!',
      'Date,User,Message 같은 낱말이 들어 있어도 머리글은 아니다',
    ])
    assert.deepEqual(parseChatExport(diary), UNKNOWN)
    assert.deepEqual(parseChatExport(''), UNKNOWN)
    assert.deepEqual(parseChatExport('   \n\n  '), UNKNOWN)
  })
})

describe('parseChatExport — 여러 줄 메시지', () => {
  const PC_DAY = '--------------- 2024년 5월 1일 수요일 ---------------'

  test('PC: 메시지 속 알림처럼 생긴 줄 하나 때문에 뒤따르는 줄을 잃지 않는다', () => {
    const parsed = parseChatExport(
      lf([PC_DAY, '[김하나] [오후 3:00] 누가 그러는데', '철수님이 나갔습니다.', '진짜래ㅋㅋ', '[이두리] [오후 3:01] 헐', '[김하나] [오후 3:02] ㄹㅇ']),
    )
    assert.deepEqual(parsed.messages, [msg('김하나', '누가 그러는데\n진짜래ㅋㅋ'), msg('이두리', '헐'), msg('김하나', 'ㄹㅇ')])
  })

  test('본문 속 날짜는 요일까지 갖춘 줄만 날짜 줄로 본다', () => {
    const pc = parseChatExport(
      lf([PC_DAY, '[김하나] [오후 3:00] 모임 공지', '2028년 4월 27일 강남역에서 봄', '2028년 4월 27일 목요일', '늦지 마', '[이두리] [오후 3:01] ㅇㅋ', '[이두리] [오후 3:02] 갈게']),
    )
    assert.deepEqual(pc.messages[0], msg('김하나', '모임 공지\n2028년 4월 27일 강남역에서 봄\n늦지 마'))

    const android = parseChatExport(
      lf([
        '2024년 5월 1일 오후 3:00',
        '2024년 5월 1일 오후 3:00, 김하나 : 약속 정리',
        '2024년 5월 3일 오후 7시에 보자',
        '2024년 5월 3일 오후 7:00에 강남역',
        '2024년 5월 1일 오후 3:01, 이두리 : 넵',
      ]),
    )
    assert.deepEqual(android.messages, [msg('김하나', '약속 정리\n2024년 5월 3일 오후 7시에 보자\n2024년 5월 3일 오후 7:00에 강남역'), msg('이두리', '넵')])
  })

  test('안드로이드: 본문 속에 날짜·시각만 적힌 줄이 있어도 뒤따르는 줄을 잃지 않는다', () => {
    const parsed = parseChatExport(
      crlf([
        '2024년 5월 1일 오후 3:00',
        '2024년 5월 1일 오후 3:00, 김하나 : 모임 안내',
        '2024년 5월 3일 오후 7:00',
        '강남역 2번 출구',
        '',
        '2024년 5월 1일 오후 3:01',
        '2024년 5월 1일 오후 3:01, 이두리 : 넵',
      ]),
    )
    assert.deepEqual(parsed.messages, [msg('김하나', '모임 안내\n강남역 2번 출구'), msg('이두리', '넵')])
  })

  test('첫 줄이 빈 메시지는 다음 줄부터가 본문이고, 끝내 본문이 없으면 메시지로 세지 않는다', () => {
    const parsed = parseChatExport(
      lf([
        '2024년 3월 14일 목요일',
        '2024. 3. 14. 오후 7:12, 김하나 :',
        '줄 끝 공백이 지워진 파일',
        '2024. 3. 14. 오후 7:13, 이두리 : ',
        '2024. 3. 14. 오후 7:14, 김하나 : 끝',
      ]),
    )
    assert.deepEqual(parsed.messages, [msg('김하나', '줄 끝 공백이 지워진 파일'), msg('김하나', '끝')])
    assert.deepEqual(parsed.speakers, [{ name: '김하나', count: 2 }])
  })

  test('맥 CSV: 본문 안의 줄바꿈은 \\n 하나로 맞추고, 본문 속 행처럼 생긴 줄도 본문이다', () => {
    const parsed = parseChatExport(
      crlf([
        'Date,User,Message',
        '2021-12-29 20:36:00,"김하나","로그 붙여 줄게',
        '2021-12-29 20:30:00,""이두리"",""이건 본문 속 줄""',
        '',
        '끝"',
        '2021-12-29 20:37:00,"이두리","ㅇㅋ"',
      ]),
    )
    assert.deepEqual(parsed.messages, [msg('김하나', '로그 붙여 줄게\n2021-12-29 20:30:00,"이두리","이건 본문 속 줄"\n\n끝'), msg('이두리', 'ㅇㅋ')])
  })
})

describe('parseChatExport — 이름', () => {
  test('PC: 이름 속 대괄호·기호·이모지, 본문 속 시각 괄호', () => {
    const parsed = parseChatExport(
      lf([
        '--------------- 2024년 5월 1일 수요일 ---------------',
        '[[운영] 김하나] [오후 3:20] 공지: [오후 4:00] 시작',
        '[이두리] [오후 3:20] [공지] [오후 4:00] 시작이래',
        '[하나 : ) ♥] [오후 3:21] ㅎㅇ',
        '[😎두리, 2세] [오후 3:22] ㅋㅋㅋ',
        '[김\u{00A0}하나] [오후 3:23] 공백이 특이한 이름',
      ]),
    )
    assert.deepEqual(parsed.messages, [
      msg('[운영] 김하나', '공지: [오후 4:00] 시작'),
      msg('이두리', '[공지] [오후 4:00] 시작이래'),
      msg('하나 : ) ♥', 'ㅎㅇ'),
      msg('😎두리, 2세', 'ㅋㅋㅋ'),
      msg('김\u{00A0}하나', '공백이 특이한 이름'),
    ])
  })

  test('모바일: 쉼표·쌍점·이모지가 든 이름은 첫 " : " 앞까지', () => {
    const parsed = parseChatExport(
      lf([
        '2024년 3월 14일 목요일',
        '2024. 3. 14. 오후 7:12, 김, 하나 : 쉼표 이름',
        '2024. 3. 14. 오후 7:13, 하나:D : 쌍점 이름',
        '2024. 3. 14. 오후 7:14, 😎두리 (2세) : 본문 : 안에도 쌍점',
        '2024. 3. 14. 오후 7:15, 김\u{00A0}하나 : 공백이 특이한 이름',
      ]),
    )
    assert.deepEqual(parsed.messages, [
      msg('김, 하나', '쉼표 이름'),
      msg('하나:D', '쌍점 이름'),
      msg('😎두리 (2세)', '본문 : 안에도 쌍점'),
      msg('김\u{00A0}하나', '공백이 특이한 이름'),
    ])
  })

  test('모바일: 이름에 " : "가 들어 있어 잘린 이름을 되살린다', () => {
    const at = (minute, rest) => `2024년 5월 1일 오후 3:${String(minute).padStart(2, '0')}, ${rest}`
    const parsed = parseChatExport(
      lf([
        at(0, '닉네임 : 서울 : 안녕하세요'),
        at(1, '이두리 : 질문 : 이거 뭐예요?'),
        at(2, '닉네임 : 서울 : 반가워요ㅎㅎ'),
        at(3, '이두리 : 질문 : 하나 더요'),
        at(4, '닉네임 : 서울 : 첫 줄'),
        '둘째 줄 : 그대로',
        at(5, '이두리 : 질문 : 또 있어요'),
        at(6, '닉네임 : 서울 : 사진'),
        at(7, '이두리 : 질문 : 마지막이에요'),
        at(8, '닉네임 : 서울 : 네네'),
        at(9, '이두리 : 감사합니다'),
        at(10, '박셋 : 메모 : 하나'),
        at(11, '박셋 : 메모 : 둘'),
        at(12, '박셋 : 메모 : 셋'),
        at(13, '박셋 : 메모 : 넷'),
      ]),
    )
    assert.deepEqual(parsed.speakers, [
      { name: '닉네임 : 서울', count: 5 },
      { name: '이두리', count: 5 },
      { name: '박셋', count: 4 },
    ])
    assert.deepEqual(
      parsed.messages.filter((m) => m.speaker === '닉네임 : 서울').map((m) => m.text),
      ['안녕하세요', '반가워요ㅎㅎ', '첫 줄\n둘째 줄 : 그대로', '사진', '네네'],
    )
    // 한 번이라도 다르게 시작했거나(이두리) 메시지가 적으면(박셋) 건드리지 않는다
    assert.deepEqual(parsed.messages[1], msg('이두리', '질문 : 이거 뭐예요?'))
    assert.deepEqual(parsed.messages.at(-1), msg('박셋', '메모 : 넷'))
    // 되살린 이름으로 고르면 본문에 이름 조각이 남지 않는다
    assert.deepEqual(extractOwnUtterances(parsed, '닉네임 : 서울'), ['안녕하세요', '반가워요ㅎㅎ', '첫 줄', '둘째 줄 : 그대로', '네네'])
  })

  test('PC는 이름이 괄호로 닫혀 있으므로 본문이 늘 같은 말로 시작해도 이름을 바꾸지 않는다', () => {
    const parsed = parseChatExport(lf(Array.from({ length: 6 }, (_, i) => `[방장봇] [오후 3:0${i}] 공지 : ${i}번`)))
    assert.deepEqual(parsed.speakers, [{ name: '방장봇', count: 6 }])
    assert.equal(parsed.messages[0].text, '공지 : 0번')
  })

  test('앞뒤 공백·자모 풀림만 다른 이름은 한 사람으로 세고, 처음 나온 꼴로 돌려준다', () => {
    const nfd = '김하나'.normalize('NFD')
    const parsed = parseChatExport(
      lf(['Date,User,Message', `2021-12-29 20:36:00,"${nfd}","하나"`, '2021-12-29 20:37:00,"이두리","둘"', '2021-12-29 20:38:00,"김하나","셋"', '2021-12-29 20:39:00,"김하나 ","넷"']),
    )
    assert.deepEqual(parsed.speakers, [
      { name: nfd, count: 3 },
      { name: '이두리', count: 1 },
    ])
    assert.deepEqual(parsed.messages.map((m) => m.speaker), [nfd, '이두리', '김하나', '김하나 '])
    assert.deepEqual(extractOwnUtterances(parsed, parsed.speakers[0].name), ['하나', '셋', '넷'])
    assertConsistent(parsed)
  })

  test('이름으로 보기엔 너무 긴 값은 이름으로 치지 않는다', () => {
    const long = '가'.repeat(150)
    const pc = parseChatExport(lf(['[김하나] [오후 3:00] 첫 줄', `[${long}] [오후 3:01] 이어지는 줄`, '[이두리] [오후 3:02] ㅇㅇ', '[이두리] [오후 3:03] ㅇㅋ']))
    assert.deepEqual(pc.speakers.map((s) => s.name), ['이두리', '김하나'])
    assert.equal(pc.messages[0].text, `첫 줄\n[${long}] [오후 3:01] 이어지는 줄`)

    const android = parseChatExport(
      lf(['2024년 5월 1일 오후 3:00, 김하나 : 하나', `2024년 5월 1일 오후 3:01, ${long} : 둘`, '2024년 5월 1일 오후 3:02, 김하나 : 셋', '2024년 5월 1일 오후 3:03, 이두리 : 넷']),
    )
    assert.deepEqual(android.speakers.map((s) => s.name), ['김하나', '이두리'])
    assert.deepEqual(android.messages.map((m) => m.text), ['하나', '셋', '넷'])

    const csv = parseChatExport(lf(['Date,User,Message', '2021-12-29 20:36:00,"김하나","하나"', `2021-12-29 20:37:00,"${long}","둘"`, '2021-12-29 20:38:00,"   ","셋"']))
    assert.deepEqual(csv.messages, [msg('김하나', '하나')])
  })

  test('말한 횟수가 같으면 먼저 나온 사람이 앞이다', () => {
    const parsed = parseChatExport(lf(['[다] [오후 3:00] 1', '[가] [오후 3:01] 2', '[나] [오후 3:02] 3', '[가] [오후 3:03] 4', '[나] [오후 3:04] 5', '[나] [오후 3:05] 6']))
    assert.deepEqual(parsed.speakers, [
      { name: '나', count: 3 },
      { name: '가', count: 2 },
      { name: '다', count: 1 },
    ])
  })
})

describe('parseChatExport — 시스템 줄', () => {
  test('알림 문구에 " : "가 있어 메시지처럼 보여도 처음 보는 이름이면 알림이다', () => {
    const parsed = parseChatExport(
      lf([
        '2024년 5월 1일 오후 3:00',
        '2024년 5월 1일 오후 3:00, 김하나 : 초대할게',
        '2024년 5월 1일 오후 3:01, 김하나님이 두리 : 서울님을 초대했습니다.',
        '2024년 5월 1일 오후 3:02, 김하나 : 두리님이 나갔습니다.',
        '2024년 5월 1일 오후 3:03, 김하나 : ㅠㅠ',
      ]),
    )
    assert.deepEqual(parsed.speakers, [{ name: '김하나', count: 3 }])
    assert.deepEqual(parsed.messages.map((m) => m.text), ['초대할게', '두리님이 나갔습니다.', 'ㅠㅠ'])
  })

  test('PC: 오픈채팅 입장 알림과 거기 따라붙는 안내문은 앞 메시지에 붙지 않는다', () => {
    const guide = '운영정책을 위반한 메시지로 신고 접수 시 카카오톡 이용에 제한이 있을 수 있습니다.'
    const parsed = parseChatExport(
      lf(['[김하나] [오후 3:00] 안녕하세요', `박셋님이 들어왔습니다.${guide}`, '최넷님이 들어왔습니다.', guide, '[이두리] [오후 3:01] 반가워요', '[김하나] [오후 3:02] 네네']),
    )
    assert.deepEqual(parsed.messages, [msg('김하나', '안녕하세요'), msg('이두리', '반가워요'), msg('김하나', '네네')])
  })

  test('알림 줄만 있는 파일은 형식은 알아보되 메시지가 없다', () => {
    const parsed = parseChatExport(
      lf(['단체방 3 님과 카카오톡 대화', '저장한 날짜 : 2024년 5월 1일 오후 9:00', '', '2024년 5월 1일 오후 3:00, 이두리님이 들어왔습니다.', '2024년 5월 1일 오후 3:01, 이두리님이 나갔습니다.']),
    )
    assert.deepEqual(parsed, { format: 'android', speakers: [], total: 0, messages: [] })
  })

  test('아이폰(영어): 12시간 표기와 PM 앞의 좁은 공백(U+202F)', () => {
    const parsed = parseChatExport(
      lf([
        'Monday, March 24, 2025',
        'Mar 24, 2025 at 7:12\u{202F}PM, 김하나 : first',
        'Mar 24, 2025 at 7:13 PM, 이두리 : second',
        'Mar 24, 2025 at 7:14\u{202F}PM: 박셋 joined this chatroom.',
        'Mar 24, 2025 at 7:15\u{00A0}PM, 김하나 : third',
      ]),
    )
    assert.equal(parsed.format, 'ios')
    assert.deepEqual(parsed.messages, [msg('김하나', 'first'), msg('이두리', 'second'), msg('김하나', 'third')])
  })

  test('오전/오후가 없는 24시간 표기도 읽는다', () => {
    const android = parseChatExport(lf(['2024년 5월 1일 15:00', '2024년 5월 1일 15:00, 김하나 : 하나', '2024년 5월 1일 15:01, 이두리 : 둘', '2024년 5월 1일 15:02, 김하나 : 셋']))
    assert.equal(android.format, 'android')
    assert.equal(android.total, 3)

    const ios = parseChatExport(lf(['2024년 3월 14일 목요일', '2024. 3. 14. 19:12, 김하나 : 하나', '2024.3.14. 19:13, 이두리 : 둘', '2024. 3. 14. 19:14, 김하나 : 셋']))
    assert.equal(ios.format, 'ios')
    assert.equal(ios.total, 3)
  })

  test('맥 CSV: 영어 알림 행과 날짜·이름이 빈 행은 메시지가 아니다', () => {
    const parsed = parseChatExport(
      lf([
        'Date,User,Message',
        '2021-12-29 20:36:00,"김하나","hello"',
        '2021-12-29 20:37:00,"이두리","이두리 joined this chatroom."',
        '2021-12-29 20:38:00,"박셋","박셋 left this chatroom."',
        '2021-12-29 20:39:00,"최넷","최넷 has been removed from this chatroom."',
        ',"","The message has been deleted."',
        '2021-12-29 20:40:00,"","이름 칸이 빈 알림"',
        '2021-12-29 20:41:00,"이두리","hi"',
      ]),
    )
    assert.deepEqual(parsed.messages, [msg('김하나', 'hello'), msg('이두리', 'hi')])
  })

  test('맥 CSV: 여러 줄로 쓴 말은 끝이 알림 문구와 같아도 사람이 한 말이다', () => {
    const parsed = parseChatExport(lf(['Date,User,Message', '2021-12-29 20:36:00,"김하나","누가 그러는데', '철수님이 나갔습니다."', '2021-12-29 20:37:00,"이두리","헐"']))
    assert.deepEqual(parsed.messages, [msg('김하나', '누가 그러는데\n철수님이 나갔습니다.'), msg('이두리', '헐')])
  })

  test('옛 모바일: 본문에 요일 날짜 줄이 섞여 있어도 시각만 적힌 변형으로 읽지 않는다', () => {
    const parsed = parseChatExport(
      lf([
        '오후 10:50, 2011년 11월 6일',
        '오후 10:50, 2011년 11월 6일, 김하나 : 다음 모임',
        '2011년 11월 13일 일요일',
        '오후 10:51, 2011년 11월 6일, 이두리 : 좋아요',
        '오후 10:52, 2011년 11월 6일, 김하나 : 그때 봐요',
        '오후 10:53, 2011년 11월 6일, 이두리 : 넵',
      ]),
    )
    assert.equal(parsed.format, 'android')
    assert.deepEqual(parsed.speakers, [
      { name: '김하나', count: 2 },
      { name: '이두리', count: 2 },
    ])
  })
})

describe('isSystemMessage', () => {
  const SYSTEM = [
    // 첨부를 대신하는 문구
    ...['사진', '동영상', '이모티콘', '음성메시지', '음성 메시지', '파일', '지도', '연락처', '일정', '투표', '보이스룸', '라이브톡', 'Photo'],
    ...['사진 3장', '동영상 2개', '<사진 읽지 않음>', '(이모티콘)', '(이모티콘_Muzi and Friends)', '  사진  '],
    ...['파일: 회의록_최종.pdf', '샵검색: #오늘 날씨', '샵검색 #맛집', '지도: 강남역 2번 출구', '위치: 서울 강남구', '연락처: 김하나', '일정: 5월 3일 회식'],
    ...['abc123.jpg', `${'a1b2c3d4'.repeat(8)}.mp4`, `${'z9y8x7w6'.repeat(8)}.dat`],
    // 지웠거나 가린 메시지
    ...['삭제된 메시지입니다.', '삭제된 메시지입니다', '(삭제된 메시지입니다.)', '메시지가 삭제되었습니다.', 'The message has been deleted.'],
    ...['관리자가 메시지를 가렸습니다.', '채팅방 관리자가 메시지를 가렸습니다.', '관리자만 말하기 기능이 활성화되었습니다.', '관리자만 말하기 기능이 해제되었습니다.'],
    // 입·퇴장, 초대, 방장
    ...['이두리님이 들어왔습니다.', '이두리님이 나갔습니다.', '김하나님이 이두리님을 초대했습니다.', '김하나님이 이두리님과 박셋님을 초대하였습니다.', '이두리님을 내보냈습니다.'],
    ...['이두리님이 방장이 되었습니다.', '이두리님이 부방장이 되었습니다.', '이두리님이 부방장에서 해제되었습니다.', '김하나님이 채팅방을 개설했습니다.', '이두리님이 방장으로 지정되었습니다.'],
    ...['이두리 joined this chatroom.', '이두리 left this chatroom.', '이두리 has been removed from this chatroom.', '김하나 invited 이두리 .', '김하나 invited 이두리 and.'],
    '박셋님이 들어왔습니다.운영정책을 위반한 메시지로 신고 접수 시 카카오톡 이용에 제한이 있을 수 있습니다.',
    // 통화·송금·프로필·게시판, 영어 로케일의 대체 문구
    ...['보이스톡 해요', '페이스톡 해요', '보이스톡 0:35', '보이스톡 1:02:33', '보이스톡 부재중', '페이스톡 취소', '보이스톡 응답 없음'],
    ...['10,000원을 보냈어요.', '5,000원을 받았어요.', '송금봉투가 도착했어요', '송금봉투를 받았어요.', '정산 내용을 확인해주세요.', '자동환불 완료'],
    ...['카카오톡 프로필', "톡게시판 '공지': 이번 주 모임 안내", 'Video', 'Emoticons', 'Voice Message', 'File', 'This message was deleted.'],
    // 링크만 있는 메시지
    ...['https://youtu.be/dQw4w9WgXcQ', 'www.example.com/path?a=1', 'https://a.example.com/1 https://b.example.com/2', 'https://a.example.com/1\nhttps://b.example.com/2'],
  ]
  const HUMAN = [
    ...['사진 찍었어', '사진 보내줘ㅋㅋ', '파일 보냈어', '동영상 봤어?', '이모티콘 귀엽다', '지도 봐도 모르겠음', '투표 좀 해줘', '일정 어떻게 돼?'],
    ...['삭제된 메시지 뭐였어?', '만원을 보냈어요.', '엄마한테 50,000원을 보냈어요.', '보이스톡 할래?', '이거 봐 https://youtu.be/abc', 'report.pdf 봤어?'],
    ...['팀장님이 나갔습니다', '아까 철수님이 들어왔습니다만', '님이 나갔습니다.', 'ㅋㅋㅋㅋ', 'ㅇㅇ', '(한숨)', 'photo', '오늘 3시에 봄'],
    ...['첫 줄\n사진', '사진\n이거 어때', '', '   '],
  ]

  for (const text of SYSTEM) {
    test(`사람이 쓴 말이 아님: ${JSON.stringify(text.slice(0, 40))}`, () => assert.equal(isSystemMessage(text), true))
  }
  for (const text of HUMAN) {
    test(`사람이 한 말: ${JSON.stringify(text)}`, () => assert.equal(isSystemMessage(text), false))
  }

  test('문자열이 아니거나 너무 긴 값은 false', () => {
    for (const value of [null, undefined, 42, {}, [], true]) assert.equal(isSystemMessage(value), false)
    assert.equal(isSystemMessage(`https://example.com/${'a'.repeat(5000)}`), false)
    assert.equal(isSystemMessage(`파일: ${'가'.repeat(3000)}.pdf`), false)
  })
})

describe('extractOwnUtterances', () => {
  const parsed = parseChatExport(
    lf([
      '김하나 님과 카카오톡 대화',
      '저장한 날짜 : 2024-05-01 21:00:00',
      '',
      '--------------- 2024년 5월 1일 수요일 ---------------',
      '[김하나] [오후 3:00] 아 진짜 배고프다ㅋㅋㅋ',
      '[이두리] [오후 3:00] 나도',
      '[김하나] [오후 3:01] 사진',
      '[김하나] [오후 3:01]   이거 봐봐  ',
      'https://youtu.be/dQw4w9WgXcQ',
      '',
      '약간 웃기지 않음?',
      '[김하나] [오후 3:02] https://map.example.com/a https://map.example.com/b',
      '[이두리] [오후 3:02] ㅋㅋㅋㅋㅋ 미쳤다',
      '[김하나] [오후 3:03] 보이스톡 해요',
      '[김하나] [오후 3:04] 10,000원을 보냈어요.',
      '[김하나] [오후 3:05] 삭제된 메시지입니다.',
      '[김하나] [오후 3:06] 파일: 맛집리스트.xlsx',
      '[김하나] [오후 3:07] 그니까 떡볶이 먹자~',
    ]),
  )

  test('고른 사람의 말만, 대체 문구와 링크를 빼고 한 줄씩', () => {
    assert.deepEqual(extractOwnUtterances(parsed, '김하나'), ['아 진짜 배고프다ㅋㅋㅋ', '이거 봐봐', '약간 웃기지 않음?', '그니까 떡볶이 먹자~'])
    assert.deepEqual(extractOwnUtterances(parsed, '이두리'), ['나도', 'ㅋㅋㅋㅋㅋ 미쳤다'])
    assert.deepEqual(extractOwnUtterances(parsed, '박셋'), [])
  })

  test('여러 줄 메시지 속의 대체 문구·알림·링크 줄도 뺀다', () => {
    const pc = parseChatExport(
      lf([
        '--------------- 2024년 5월 1일 수요일 ---------------',
        '[김하나] [오후 3:00] 이모티콘',
        '이거 완전 나잖아ㅋㅋ',
        '[김하나] [오후 3:01] 모임 공지',
        '일정: 5월 3일 오후 7시',
        '위치: 강남역 2번 출구',
        'https://map.example.com/a',
        '늦지 마~',
        '[이두리] [오후 3:02] 넵',
      ]),
    )
    assert.deepEqual(extractOwnUtterances(pc, '김하나'), ['이거 완전 나잖아ㅋㅋ', '모임 공지', '늦지 마~'])

    // 모바일은 알림에 날짜 머리말이 붙지만, 그 뒤에 따라붙은 안내문 줄은 앞 메시지에 이어진다
    const android = parseChatExport(
      lf([
        '2024년 5월 1일 오후 3:00',
        '2024년 5월 1일 오후 3:00, 김하나 : 안녕하세요',
        '2024년 5월 1일 오후 3:01, 박셋님이 들어왔습니다.',
        '운영정책을 위반한 메시지로 신고 접수 시 카카오톡 이용에 제한이 있을 수 있습니다.',
        '2024년 5월 1일 오후 3:02, 김하나 : 반가워요',
      ]),
    )
    assert.deepEqual(extractOwnUtterances(android, '김하나'), ['안녕하세요', '반가워요'])
  })

  test('개수가 넘치면 최근 말을 시간순으로 남긴다', () => {
    assert.deepEqual(extractOwnUtterances(parsed, '김하나', { maxUtterances: 3 }), ['이거 봐봐', '약간 웃기지 않음?', '그니까 떡볶이 먹자~'])
    assert.deepEqual(extractOwnUtterances(parsed, '김하나', { maxUtterances: 2 }), ['약간 웃기지 않음?', '그니까 떡볶이 먹자~'])
    assert.deepEqual(extractOwnUtterances(parsed, '김하나', { maxUtterances: 0 }), [])
  })

  test('기본 상한은 LIMITS.text.maxUtterances', () => {
    const extra = 100
    const lines = Array.from({ length: LIMITS.text.maxUtterances + extra }, (_, i) => `[김하나] [오후 3:00] 말 ${i + 1}`)
    const own = extractOwnUtterances(parseChatExport(lf(lines)), '김하나')
    assert.equal(own.length, LIMITS.text.maxUtterances)
    assert.equal(own[0], `말 ${extra + 1}`)
    assert.equal(own.at(-1), `말 ${LIMITS.text.maxUtterances + extra}`)
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, '5', null]) {
      assert.equal(extractOwnUtterances(parseChatExport(lf(lines)), '김하나', { maxUtterances: bad }).length, LIMITS.text.maxUtterances)
    }
  })

  test('안드로이드의 "회원님"처럼 파일에 적힌 이름 그대로 고른다', () => {
    const android = parseChatExport(
      lf(['2024년 5월 1일 오후 3:00', '2024년 5월 1일 오후 3:00, 회원님 : 오늘 뭐 해?', '2024년 5월 1일 오후 3:01, 이두리 : 집', '2024년 5월 1일 오후 3:02, 회원님 : 나와ㅋㅋ']),
    )
    assert.deepEqual(extractOwnUtterances(android, android.speakers[0].name), ['오늘 뭐 해?', '나와ㅋㅋ'])
  })

  test('이름은 앞뒤 공백과 자모 풀림(NFD)을 무시하고 견준다', () => {
    const handmade = { messages: [msg('김하나'.normalize('NFD'), '안녕'), msg(' 김하나 ', '하이'), msg('김하나2', '다른 사람')] }
    assert.deepEqual(extractOwnUtterances(handmade, ' 김하나'), ['안녕', '하이'])
    assert.deepEqual(extractOwnUtterances(handmade, '김하나'.normalize('NFD')), ['안녕', '하이'])
  })

  test('엉뚱한 입력에도 죽지 않는다', () => {
    for (const bad of [null, undefined, 42, 'text', {}, { messages: null }, { messages: 'x' }, { messages: {} }]) {
      assert.deepEqual(extractOwnUtterances(bad, '김하나'), [])
    }
    for (const bad of [null, undefined, '', '   ', 42, {}, ['김하나']]) assert.deepEqual(extractOwnUtterances(parsed, bad), [])
    const dirty = { messages: [null, 7, 'x', {}, { speaker: '김하나' }, { speaker: '김하나', text: 5 }, { speaker: null, text: '이름 없음' }, msg('김하나', '멀쩡한 말')] }
    assert.deepEqual(extractOwnUtterances(dirty, '김하나'), ['멀쩡한 말'])
    const untidy = { messages: [msg('김하나', '첫 줄\r\n둘째 줄\r셋째 줄\n\n  넷째 줄  ')] }
    assert.deepEqual(extractOwnUtterances(untidy, '김하나'), ['첫 줄', '둘째 줄', '셋째 줄', '넷째 줄'])
    assert.deepEqual(extractOwnUtterances(parsed, '이두리', null), ['나도', 'ㅋㅋㅋㅋㅋ 미쳤다'])
    assert.deepEqual(extractOwnUtterances(parsed, '이두리', 'x'), ['나도', 'ㅋㅋㅋㅋㅋ 미쳤다'])
  })
})

describe('parseChatExport — 견고함', () => {
  test('문자열이 아닌 입력은 unknown', () => {
    for (const bad of [null, undefined, 42, true, {}, [], () => '', Symbol('x')]) assert.deepEqual(parseChatExport(bad), UNKNOWN)
  })

  test('BOM은 파일 맨 앞이든 이어 붙인 자리든 걷어 낸다', () => {
    const pc = parseChatExport(BOM + lf(['[김하나] [오후 3:00] 하나', `${BOM}[이두리] [오후 3:01] 둘`, '[김하나] [오후 3:02] 셋']))
    assert.deepEqual(pc.messages, [msg('김하나', '하나'), msg('이두리', '둘'), msg('김하나', '셋')])

    const csv = parseChatExport(`${BOM}Date,User,Message\r\n2021-12-29 20:36:00,"김하나","하나"\r\n`)
    assert.deepEqual(csv, { format: 'mac-csv', speakers: [{ name: '김하나', count: 1 }], total: 1, messages: [msg('김하나', '하나')] })
  })

  test('줄바꿈이 \\r 하나뿐인 글도 줄 단위로 읽는다', () => {
    const parsed = parseChatExport(['[김하나] [오후 3:00] 하나', '[이두리] [오후 3:01] 둘', '[김하나] [오후 3:02] 셋'].join('\r'))
    assert.equal(parsed.format, 'pc')
    assert.deepEqual(parsed.messages.map((m) => m.text), ['하나', '둘', '셋'])
  })

  test('머리글이 없으면 메시지 줄이 세 개는 되어야 하고, 머리글이 있으면 하나여도 된다', () => {
    const two = lf(['[김하나] [오후 3:00] 하나', '[이두리] [오후 3:01] 둘'])
    assert.deepEqual(parseChatExport(two), UNKNOWN)
    assert.equal(parseChatExport(`${two}\n[김하나] [오후 3:02] 셋`).format, 'pc')
    assert.equal(parseChatExport(lf(['김하나 님과 카카오톡 대화', '저장한 날짜 : 2024-05-01 21:00:00', '', two])).format, 'pc')

    const single = parseChatExport(lf(['김하나 님과 카카오톡 대화', '저장한 날짜 : 2024년 5월 1일 오후 9:00', '', '', '2024년 5월 1일 오후 3:00, 회원님 : 나와의 채팅 메모']))
    assert.equal(single.format, 'android')
    assert.deepEqual(single.messages, [msg('회원님', '나와의 채팅 메모')])
  })

  test('시각만 적힌 줄은 요일 날짜 줄이 앞에 있을 때만 메시지 줄로 본다', () => {
    const timeOnly = lf(['오후 3:00, 김하나 : 하나', '오후 3:01, 이두리 : 둘', '오후 3:02, 김하나 : 셋'])
    assert.deepEqual(parseChatExport(timeOnly), UNKNOWN)
    assert.equal(parseChatExport(`2024년 5월 1일 수요일\n${timeOnly}`).format, 'ios')
  })

  test('여러 조각을 이어 붙인 글: 중간의 머리글과 BOM이 메시지에 섞이지 않는다', () => {
    const part1 = BOM + lf(['Talk_2025.11.14 19:02-1.txt', '저장한 날짜 : 2025. 11. 16. 오후 2:46', '', '2025년 11월 14일 금요일', '2025. 11. 14. 오후 7:00, 김하나 : 첫 조각의 마지막 말'])
    const part2 = BOM + lf(['Talk_2025.11.14 19:02-2.txt', '저장한 날짜 : 2025. 11. 17. 오후 3:00', '', '2025. 11. 14. 오후 7:01, 이두리 : 둘째 조각의 첫 말', '2025년 11월 15일 토요일', '2025. 11. 15. 오전 9:00, 김하나 : 좋은 아침'])
    const parsed = parseChatExport(`${part1}\n${part2}`)
    assert.equal(parsed.format, 'ios')
    assert.deepEqual(parsed.messages, [msg('김하나', '첫 조각의 마지막 말'), msg('이두리', '둘째 조각의 첫 말'), msg('김하나', '좋은 아침')])
  })

  test('모바일 파일 속에 PC 대화를 붙여 넣은 메시지가 있어도 모바일 형식이다', () => {
    const parsed = parseChatExport(
      lf([
        '2024년 5월 1일 오후 3:00',
        '2024년 5월 1일 오후 3:00, 김하나 : PC에서 복사한 거',
        '[이두리] [오후 1:00] 어제 한 말',
        '[이두리] [오후 1:01] 또 한 말',
        '2024년 5월 1일 오후 3:01, 이두리 : 그걸 왜 붙여ㅋㅋ',
        '2024년 5월 1일 오후 3:02, 김하나 : 그냥',
      ]),
    )
    assert.equal(parsed.format, 'android')
    assert.equal(parsed.messages[0].text, 'PC에서 복사한 거\n[이두리] [오후 1:00] 어제 한 말\n[이두리] [오후 1:01] 또 한 말')
    assert.equal(parsed.total, 3)
  })

  test('이름은 파일에 적힌 그대로 돌려주고, 정규식 기호나 객체 속성 이름이어도 문제없다', () => {
    const names = ['(.*)+$ ^\\d{2}|x', '__proto__', 'constructor', 'toString', '김하나 ', '<b>굵게</b>']
    const parsed = parseChatExport(lf(names.map((name, i) => `[${name}] [오후 3:0${i}] ${i}번 메시지`)))
    assert.deepEqual(parsed.speakers, names.map((name) => ({ name, count: 1 })))
    names.forEach((name, i) => assert.deepEqual(extractOwnUtterances(parsed, name), [`${i}번 메시지`]))
  })

  test('맥 CSV: 따옴표 짝이 어긋나도 다음 행부터 다시 맞추고, 따옴표 없는 이름·이름 속 따옴표도 읽는다', () => {
    const parsed = parseChatExport(
      lf([
        'Date,User,Message',
        '2021-12-29 20:41:00,"김하나","따옴표가 "어긋난" 줄"',
        '2021-12-29 20:42:00,"김하나","끝에 따옴표가 하나 남는 줄""',
        '2021-12-29 20:43:00,"이두리","다음 행은 살아야 한다"',
        '2021-12-29 20:44:00,이두리,따옴표 없는 행, 쉼표 포함',
        '2021-12-29 20:45:00,"하나 ""별명""","이름 속 따옴표"',
        '2021-12-29 20:46:00,"김하나","닫히지 않은 채 끝나는 마지막 행',
      ]),
    )
    assert.deepEqual(parsed.messages, [
      msg('김하나', '따옴표가 "어긋난" 줄'),
      msg('김하나', '끝에 따옴표가 하나 남는 줄"'),
      msg('이두리', '다음 행은 살아야 한다'),
      msg('이두리', '따옴표 없는 행, 쉼표 포함'),
      msg('하나 "별명"', '이름 속 따옴표'),
      msg('김하나', '닫히지 않은 채 끝나는 마지막 행'),
    ])
  })

  test('맥 CSV: 머리글 행이 없어도 행 모양으로 알아본다', () => {
    const rows = ['2021-12-29 20:36:00,"김하나","하나"', '2021-12-29 20:37:00,"이두리","둘"', '2021-12-29 20:38:00,"김하나","셋"']
    const parsed = parseChatExport(crlf(rows))
    assert.equal(parsed.format, 'mac-csv')
    assert.deepEqual(parsed.speakers, [
      { name: '김하나', count: 2 },
      { name: '이두리', count: 1 },
    ])
    assert.equal(parseChatExport('Date,User,Message\r\n').format, 'mac-csv')
  })
})

describe('왕복 검사 — 아는 대화를 형식대로 적었다가 다시 읽으면 그대로다', () => {
  /** 시드가 같으면 늘 같은 수열을 내는 난수 (Math.random에 기대지 않는다) */
  function mulberry32(seed) {
    let a = seed >>> 0
    return () => {
      a = (a + 0x6d2b79f5) >>> 0
      let t = a
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }
  const pick = (rng, list) => list[Math.floor(rng() * list.length)]
  const pad = (n) => String(n).padStart(2, '0')
  const koTime = (i) => `${i % 2 ? '오전' : '오후'} ${1 + (i % 12)}:${pad(i % 60)}`

  // 모바일 txt는 이름 속 ' : '를 가를 수 없으므로 그런 이름은 PC·CSV에서만 쓴다
  const NAMES = ['김하나', '이두리', '회원님', 'you', '[운영] 박셋', '김, 하나', '하나:D', '😎두리 (2세)', 'a]b', 'x [1]', '닉/20/서울', '따옴"표', '김\u{00A0}하나', '(알 수 없음)', '1234', '오후']
  const BRACKETED_NAMES = [...NAMES, '닉 : 서울', 'a] [b', '[오후 3:00]']
  const OPENERS = [
    ...['아 진짜 졸리다ㅋㅋㅋ', '오늘 점심 뭐 먹지', '사진', '약간 그런 느낌이긴 해', 'https://example.com/a?b=c', 'ㅇㅇ', '헐 대박!!', '근데 그거 알아?'],
    ...['"따옴표"로 시작', '쉼표, 가 있는 말', '[공지] 내일 모임', '(이모티콘)', '2028년 4월 27일에 보자', 'A : B 꼴의 말', '끝에 따옴표"', '""', ',', '오후 3시에 봐', '물결~~~', '🙂'],
  ]
  const FOLLOWERS = [
    ...OPENERS,
    ...['', '  들여쓴 줄', '줄 끝 공백   ', '--------------- 구분 ---------------', '저장한 날은 어제', 'Date,User,Message', ',"","메시지가 삭제되었습니다."'],
    ...['2024. 3. 14. 오후 7:12, 김하나 : 아이폰 줄', '[이두리] [오후 1:00] PC 줄', '2021년 12월 29일 오후 8:36, 김하나 : 안드로이드 줄', '오후 10:50, 2011년 11월 6일, 김하나 : 옛 줄'],
    ...['Dec 31, 2014 at 19:12, 김하나 : ios', 'February 10, 2016, 2:33 AM, you : android', '2021-12-29 20:36:00,"김하나","csv 줄"'],
  ]
  const NOTICES = ['이두리님이 들어왔습니다.', '김하나님이 이두리님을 초대했습니다.', '이두리님이 나갔습니다.']

  function makeChat(rng, names, looksLikeOwnHead) {
    const cast = Array.from({ length: 2 + Math.floor(rng() * 4) }, () => pick(rng, names))
    return Array.from({ length: 3 + Math.floor(rng() * 30) }, () => {
      const lines = [pick(rng, OPENERS)]
      const extra = rng() < 0.3 ? 1 + Math.floor(rng() * 4) : 0
      for (let j = 0; j < extra; j++) lines.push(pick(rng, FOLLOWERS))
      // 그 형식의 머리말처럼 생긴 줄은 형식 자체가 구분하지 못하므로 본문에 넣지 않는다
      return msg(pick(rng, cast), lines.filter((line) => !looksLikeOwnHead.test(line)).join('\n').trim())
    })
  }

  /** 줄 머리말(stamp)만 다른 모바일 txt 계열을 적는다 */
  const mobileWriter = (header, stampOf, noticeLine) => (messages, rng) => {
    const out = [...header]
    messages.forEach((m, i) => {
      const stamp = stampOf(i)
      if (rng() < 0.15) out.push(noticeLine(stamp, pick(rng, NOTICES)))
      out.push(`${stamp}, ${m.speaker} : ${m.text}`)
    })
    return out.join(rng() < 0.5 ? '\n' : '\r\n')
  }
  const commaNotice = (stamp, notice) => `${stamp}, ${notice}`

  const WRITERS = {
    'PC': {
      format: 'pc',
      names: BRACKETED_NAMES,
      ownHead: /^\[.*\] \[.*\d:\d\d.*\]|요일/,
      write(messages, rng) {
        const out = ['김하나 님과 카카오톡 대화', '저장한 날짜 : 2020-11-03 10:44:52', '', '--------------- 2020년 6월 28일 일요일 ---------------']
        messages.forEach((m, i) => {
          if (rng() < 0.1) out.push('--------------- 2020년 6월 29일 월요일 ---------------')
          if (rng() < 0.1) out.push(pick(rng, NOTICES))
          out.push(`[${m.speaker}] [${koTime(i)}] ${m.text}`)
        })
        return out.join('\r\n')
      },
    },
    '안드로이드(한국어)': {
      format: 'android',
      names: NAMES,
      ownHead: /^\d{4}년 \d{1,2}월 \d{1,2}일 (?:오전|오후) \d/,
      write: mobileWriter(['김하나 님과 카카오톡 대화', '저장한 날짜 : 2020년 11월 3일 오전 11:29', '', ''], (i) => `2021년 12월 ${1 + (i % 28)}일 ${koTime(i)}`, (stamp, notice) =>
        notice.includes('나갔') ? `\n${stamp}` : commaNotice(stamp, notice),
      ),
    },
    '안드로이드(영어)': {
      format: 'android',
      names: NAMES,
      ownHead: /^February/,
      write: mobileWriter(['KakaoTalk Chats with 김하나', 'Date Saved : November 3, 2020, 1:08 PM', '', ''], (i) => `February ${1 + (i % 28)}, 2016, ${1 + (i % 12)}:${pad(i % 60)} ${i % 2 ? 'AM' : 'PM'}`, (stamp) => `\n${stamp}`),
    },
    '아이폰(한국어)': {
      format: 'ios',
      names: NAMES,
      ownHead: /^\d{4}\. ?\d|요일/,
      write: mobileWriter(['Talk_2025.11.14 19:02-1.txt', '저장한 날짜 : 2025. 11. 16. 오후 2:46', '', '2024년 3월 14일 목요일'], (i) => `2024. 3. ${1 + (i % 28)}. ${koTime(i)}`, (stamp, notice) =>
        notice.includes('초대') ? commaNotice(stamp, notice) : notice.includes('나갔') ? '2024년 3월 15일 금요일' : `${stamp}: ${notice}`,
      ),
    },
    '아이폰(영어)': {
      format: 'ios',
      names: NAMES,
      ownHead: /^Dec /,
      write: mobileWriter(['Talk_2026.4.25 10:20-1.txt', 'Date Saved : Apr 25, 2026 at 10:38', '', '', 'Wednesday, December 31, 2014'], (i) => `Dec ${1 + (i % 28)}, 2014 at ${pad(i % 24)}:${pad(i % 60)}`, (stamp) => `${stamp}: 김하나 invited 이두리 .`),
    },
    '아이폰(시각만)': {
      format: 'ios',
      names: NAMES,
      ownHead: /^(?:오전|오후) \d{1,2}:\d{2}|요일/,
      write: mobileWriter(['김하나 님과 카카오톡 대화', '저장한 날짜 : 2021년 12월 18일 오후 7:17', '', '', '2021년 12월 29일 수요일'], koTime, commaNotice),
    },
    '옛 모바일': {
      format: 'android',
      names: NAMES,
      ownHead: /^(?:오전|오후) \d{1,2}:\d{2}, \d{4}년/,
      write: mobileWriter(['김하나 님과 카카오톡 대화', '저장한 날짜 : 오전 12:09, 2012년 4월 4일', ''], (i) => `${koTime(i)}, 2011년 11월 ${1 + (i % 28)}일`, (stamp, notice) =>
        notice.includes('나갔') ? stamp : commaNotice(stamp, notice),
      ),
    },
    '맥 CSV': {
      format: 'mac-csv',
      names: BRACKETED_NAMES,
      ownHead: /(?!)/,
      write(messages, rng) {
        const quote = (value) => `"${value.replaceAll('"', '""')}"`
        const out = ['Date,User,Message']
        messages.forEach((m, i) => {
          if (rng() < 0.1) out.push(',"","메시지가 삭제되었습니다."')
          if (rng() < 0.1) out.push(`2021-12-29 20:${pad(i % 60)}:00,"이두리","${pick(rng, NOTICES)}"`)
          out.push(`2021-12-29 20:${pad(i % 60)}:00,${quote(m.speaker)},${quote(m.text)}`)
        })
        return `${out.join('\r\n')}\r\n`
      },
    },
  }

  for (const [label, writer] of Object.entries(WRITERS)) {
    test(label, () => {
      for (let seed = 1; seed <= 200; seed++) {
        const rng = mulberry32(seed)
        const messages = makeChat(rng, writer.names, writer.ownHead)
        const parsed = parseChatExport(BOM + writer.write(messages, rng))
        // 어긋나면 어느 시드인지 보이도록 시드도 함께 견준다
        assert.deepEqual({ seed, format: parsed.format, messages: parsed.messages }, { seed, format: writer.format, messages })
        assertConsistent(parsed)
      }
    })
  }
})

describe('큰 입력과 악의적인 입력 — 입력 길이에 비례하는 시간 안에 끝난다', () => {
  const WATCHDOG = { timeout: 60_000 }

  test('10MB쯤 되는 내보내기 파일', WATCHDOG, () => {
    const bodies = ['아 진짜 졸리다ㅋㅋㅋ', '오늘 점심 뭐 먹지', '사진', '약간 그런 느낌이긴 해', 'https://example.com/a?b=c', '첫 줄\n둘째 줄 이어서 씀\n\n넷째 줄ㅎㅎ']
    const names = ['김하나', '이두리', '[운영] 박셋', '최 넷']
    const count = 150_000
    const lines = ['김하나 님과 카카오톡 대화', '저장한 날짜 : 2024년 5월 1일 오후 9:00', '', '']
    for (let i = 0; i < count; i++) {
      if (i % 40 === 0) lines.push('', `2024년 5월 1일 오후 8:${String(i % 60).padStart(2, '0')}`)
      lines.push(`2024년 5월 1일 오후 8:${String(i % 60).padStart(2, '0')}, ${names[i % names.length]} : ${bodies[i % bodies.length]}`)
    }
    const text = crlf(lines)
    assert.ok(new TextEncoder().encode(text).length > 10_000_000)

    const parsed = parseChatExport(text)
    assert.equal(parsed.format, 'android')
    assert.equal(parsed.total, count)
    assert.deepEqual(parsed.speakers, names.map((name) => ({ name, count: count / names.length })))
    assert.equal(parsed.messages[5].text, '첫 줄\n둘째 줄 이어서 씀\n\n넷째 줄ㅎㅎ')

    // 김하나의 본문은 0·4·2번 꼴이 되풀이된다: 말 한 줄, 링크(빠짐), '사진'(빠짐)
    const own = extractOwnUtterances(parsed, '김하나', { maxUtterances: count })
    assert.equal(own.length, count / names.length / 3)
    assert.ok(own.every((line) => line === '아 진짜 졸리다ㅋㅋㅋ'))
  })

  test('상한보다 긴 입력은 최근 부분만 읽는다', WATCHDOG, () => {
    const count = 4_500
    const laugh = 'ㅋ'.repeat(4_000)
    const lines = ['[옛사람] [오전 9:00] 아주 오래전에 한 말']
    for (let i = 1; i < count; i++) lines.push(`[${i % 2 ? '김하나' : '이두리'}] [오후 3:00] ${i}번째 ${laugh}`)
    const text = lf(lines)
    assert.ok(text.length > 16_000_000)

    const parsed = parseChatExport(text)
    assert.equal(parsed.format, 'pc')
    assert.ok(parsed.total > count / 2 && parsed.total < count)
    assert.deepEqual(parsed.speakers.map((s) => s.name).sort(), ['김하나', '이두리'])
    assert.ok(parsed.messages.at(-1).text.startsWith(`${count - 1}번째 `))
  })

  test('백트래킹이 폭증할 만한 줄들', WATCHDOG, () => {
    const big = 1_200_000
    const stamp = '2021년 12월 29일 오후 8:36, '
    const csvHead = 'Date,User,Message\n2021-12-29 20:36:00,"a","'
    // 한 번에 하나씩만 만들어 메모리를 아낀다
    const hostile = [
      () => '['.repeat(big),
      () => '[a] '.repeat(big / 4),
      () => `[a] [오후 1:00] ${'] [오후 1:00]'.repeat(big / 12)}`,
      () => Array.from({ length: big / 40 }, () => `[${'x'.repeat(38)}`).join('\n'),
      () => '-'.repeat(big),
      () => Array.from({ length: big / 40 }, () => `${'-'.repeat(36)} x`).join('\n'),
      () => stamp + '가 :'.repeat(big / 3),
      () => Array.from({ length: big / 40 }, () => `${stamp}${'가:'.repeat(6)}`).join('\n'),
      () => `[a] [오후 1:00] x${' '.repeat(big)}y\n[b] [오후 1:01] z\n[b] [오후 1:02] z`,
      () => `[a] [오후 1:00] x${'\n'.repeat(big)}[b] [오후 1:01] z\n[b] [오후 1:02] z`,
      () => csvHead + '"'.repeat(big + 1),
      () => `${csvHead}x\n${'"\n'.repeat(big / 2)}`,
      () => `${csvHead}x\n${'2021-12-29 20:36:00,""b"",\n'.repeat(big / 27)}`,
      () => `Date,User,Message\n${'2021-12-29 20:36:00,\n'.repeat(big / 21)}`,
      () => Array.from({ length: big / 30 }, (_, i) => `${stamp}닉 : 지역 : 본문 ${i}`).join('\n'),
      () => '\u{00A0}'.repeat(big),
      () => '\u{FEFF}'.repeat(big),
      () => '\r'.repeat(big),
      () => ' '.repeat(big),
    ]
    for (const make of hostile) {
      const parsed = parseChatExport(make())
      assert.equal(parsed.total, parsed.messages.length)
      const first = parsed.speakers[0]?.name ?? '없는 사람'
      assert.ok(Array.isArray(extractOwnUtterances(parsed, first, { maxUtterances: big })))
    }
  })

  test('백트래킹이 폭증할 만한 본문', WATCHDOG, () => {
    const hostile = [
      `${'http://'.repeat(280)} x`,
      `${'www.a '.repeat(330)}x`,
      '님이 '.repeat(160),
      `${' invited '.repeat(50)}.`,
      `${'a.'.repeat(900)}jp`,
      `<${'읽지 않음'.repeat(300)}`,
      '송금봉투가 도착했어요'.repeat(40),
      `파일 : ${' '.repeat(1900)}`,
    ]
    for (const text of hostile) {
      for (let i = 0; i < 2000; i++) assert.equal(isSystemMessage(text), false)
    }
  })
})
