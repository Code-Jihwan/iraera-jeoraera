import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { extractOwnUtterances, isSystemMessage, parseChatExport } from '../shared/kakao-parser.js'

const lf = (lines) => lines.join('\n')
const ANDROID_HEAD = ['김하나 님과 카카오톡 대화', '저장한 날짜 : 2024년 5월 3일 오후 9:00', '']

describe('공격: 다른 사람의 말이 사용자 말로 섞이지 않는다', () => {
  test('안드로이드: 처음 말한 사람의 첫 메시지가 알림 문구로 끝나도, 그 메시지의 이어지는 줄이 앞사람에게 붙지 않는다', () => {
    const parsed = parseChatExport(
      lf([
        ...ANDROID_HEAD,
        '2024년 5월 3일 오후 7:00, 김하나 : 오늘 가게 어땠어?',
        '2024년 5월 3일 오후 7:01, 이두리 : 우리 가게에 손님이 들어왔습니다.',
        '근데 그 사람 진짜 웃겼어',
        '2024년 5월 3일 오후 7:02, 김하나 : 헐 뭔데',
      ]),
    )
    const own = extractOwnUtterances(parsed, '김하나')
    assert.ok(!own.includes('근데 그 사람 진짜 웃겼어'), `이두리의 말이 김하나의 말로 들어갔다: ${JSON.stringify(own)}`)
    for (const m of parsed.messages.filter((m) => m.speaker === '김하나')) {
      assert.ok(!m.text.includes('웃겼어'), `김하나의 메시지에 남의 줄이 붙었다: ${JSON.stringify(m)}`)
    }
  })

  test('안드로이드(영어): "I invited …" 로 시작한 남의 메시지의 둘째 줄이 you의 말이 되지 않는다', () => {
    const parsed = parseChatExport(
      lf([
        'KakaoTalk Chats with Tom',
        'Date Saved : November 3, 2020, 1:08 PM',
        '',
        'February 10, 2016, 2:33 AM, you : hi',
        'February 10, 2016, 2:34 AM, Tom : I invited Jane to dinner.',
        'She said yes',
        'February 10, 2016, 2:35 AM, you : nice',
      ]),
    )
    assert.deepEqual(extractOwnUtterances(parsed, 'you'), ['hi', 'nice'])
  })
})

describe('공격: 사용자가 직접 친 합쇼체 문장은 알림이 아니다', () => {
  test('안드로이드: 이름이 붙은 메시지의 "…님이 들어왔습니다." 같은 평범한 문장을 버리지 않는다', () => {
    const parsed = parseChatExport(
      lf([
        ...ANDROID_HEAD,
        '2024년 5월 3일 오후 7:00, 김하나 : 안녕',
        '2024년 5월 3일 오후 7:01, 김하나 : 방금 가게에 손님이 들어왔습니다.',
        '2024년 5월 3일 오후 7:02, 김하나 : 행사에 선생님을 초대했습니다.',
        '2024년 5월 3일 오후 7:03, 김하나 : 사장님이 나갔습니다.',
        '이제 퇴근이다',
      ]),
    )
    assert.deepEqual(extractOwnUtterances(parsed, '김하나'), [
      '안녕',
      '방금 가게에 손님이 들어왔습니다.',
      '행사에 선생님을 초대했습니다.',
      '사장님이 나갔습니다.',
      '이제 퇴근이다',
    ])
  })

  test('PC: [이름] [시각]이 붙은 본인 메시지의 한 줄짜리 합쇼체 문장도 남긴다', () => {
    const parsed = parseChatExport(
      lf(['[김하나] [오후 1:00] 안녕', '[이두리] [오후 1:01] 응', '[김하나] [오후 1:02] 방금 손님이 들어왔습니다.']),
    )
    assert.deepEqual(extractOwnUtterances(parsed, '김하나'), ['안녕', '방금 손님이 들어왔습니다.'])
  })

  test('맥 CSV: User 칸의 사람과 상관없는 "…님이 들어왔습니다." 문장은 그 사람의 말이다', () => {
    const parsed = parseChatExport(
      lf([
        'Date,User,Message',
        '2021-12-29 20:36:00,"김하나","ㅎㅇ"',
        '2021-12-29 20:37:00,"김하나","방금 손님이 들어왔습니다."',
        '2021-12-29 20:38:00,"이두리","오 진짜?"',
        '2021-12-29 20:39:00,"이두리","이두리님이 나갔습니다."',
      ]),
    )
    assert.deepEqual(extractOwnUtterances(parsed, '김하나'), ['ㅎㅇ', '방금 손님이 들어왔습니다.'])
    assert.equal(parsed.messages.filter((m) => m.speaker === '이두리').length, 1)
  })
})

describe('공격: 큰 입력에서도 죽지 않는다', () => {
  // 상한(16M자) 안쪽, 10MB 남짓한 입력. 예외 없이 결과를 돌려줘야 한다.
  const DASHES = 6_000_000

  test('줄표만 6백만 개인 한 줄 → 예외 없이 unknown', () => {
    let parsed
    assert.doesNotThrow(() => {
      parsed = parseChatExport('-'.repeat(DASHES))
    })
    assert.equal(parsed.format, 'unknown')
  })

  test('PC 대화 속 긴 줄표 줄(구분선 붙여 넣기)도 예외 없이 읽는다', () => {
    const text = lf([
      '[김하나] [오후 1:00] 안녕',
      '[이두리] [오후 1:01] 응',
      '[김하나] [오후 1:02] 구분선 그어 줄게',
      '-'.repeat(DASHES),
      '[이두리] [오후 1:03] ㅋㅋ',
    ])
    let parsed
    assert.doesNotThrow(() => {
      parsed = parseChatExport(text)
    })
    assert.equal(parsed.format, 'pc')
    assert.equal(parsed.total, 4)
  })

  test('isSystemMessage는 아주 긴 줄표에도 false', () => {
    assert.equal(isSystemMessage('-'.repeat(DASHES)), false)
  })
})

describe('공격: 카카오톡이 아닌 글은 unknown', () => {
  test('머리글 없는 일반 CSV 로그(날짜,이름,내용)는 맥 내보내기로 읽지 않는다', () => {
    const parsed = parseChatExport(
      lf(['2024-01-01 12:00:00,server,started', '2024-01-01 12:00:01,worker,ready', '2024-01-01 12:00:02,server,ok']),
    )
    assert.deepEqual(parsed, { format: 'unknown', speakers: [], total: 0, messages: [] })
  })
})
