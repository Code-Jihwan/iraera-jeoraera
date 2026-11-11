// 말투 분석기: 어미·높임 단계·추임새·표현·웃음 습관·대표 문장·요약·요약본·항목 고치기
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeStyle, splitUtterances, summarizeProfile, profileToPayload, addItem, removeItem, isUsableProfile, removeVoiceData, mergeProfiles } from '../shared/style-analyzer.js'
import { LIMITS } from '../shared/constants.js'

const now = new Date('2026-11-11T00:00:00Z')
const analyze = (lines, extra = {}) => analyzeStyle({ textUtterances: lines, now, ...extra })
const forms = (items) => items.map((x) => x.form)
const endingOf = (line) => analyze([line]).endings.map((e) => e.form)

const BANMAL_KK = [
  '아 근데 오늘 진짜 웃긴 일 있었거든ㅋㅋㅋ',
  '버스 탔는데 기사님이 노래 부르시는 거야',
  '약간 당황했는데 잘 부르시잖아ㅋㅋ',
  '아니 근데 나만 박수 치고 싶었던 거 아니지',
  '진짜 대박이었어ㅋㅋㅋ',
  '점심은 그냥 떡볶이 먹었거든',
  '약간 매웠는데 맛있더라',
  '나 또 까먹을 뻔했잖아ㅋㅋㅋㅋ',
  '그 카페 분위기 완전 좋더라',
  '아 근데 사람 너무 많았거든',
  '그래서 그냥 포장해 왔지',
  '다음에 또 가면 되잖아ㅋㅋ',
]

test('splitUtterances: 줄 단위로 나누고, 빈 줄·링크만 있는 줄은 버린다', () => {
  const out = splitUtterances('첫 줄\r\n\r\n  둘째 줄  \nhttps://example.com/a\n셋째 줄')
  assert.deepEqual(out, ['첫 줄', '둘째 줄', '셋째 줄'])
})

test('splitUtterances: 긴 줄은 문장부호 뒤에서 나누고 부호는 문장에 남긴다', () => {
  const long = '오늘은 정말 정신없이 바쁜 하루였어요. 아침부터 회의가 세 개나 연달아 있었거든요! 그래도 저녁은 맛있게 먹었어요?'
  assert.ok([...long].length > 60)
  assert.deepEqual(splitUtterances(long), ['오늘은 정말 정신없이 바쁜 하루였어요.', '아침부터 회의가 세 개나 연달아 있었거든요!', '그래도 저녁은 맛있게 먹었어요?'])
  const short = '짧은 줄이에요. 그대로 둬요!'
  assert.deepEqual(splitUtterances(short), [short], '60자 이하는 나누지 않는다')
})

test('splitUtterances: 글자 수·개수 한도를 지킨다', () => {
  const lines = Array.from({ length: 50 }, (_, i) => `${i}번째 줄이에요`).join('\n')
  assert.equal(splitUtterances(lines, { maxChars: 1000, maxUtterances: 10 }).length, 10)
  const chars = splitUtterances(lines, { maxChars: 30, maxUtterances: 100 }).join('').length
  assert.ok(chars <= 30, `글자 수 ${chars}`)
  assert.deepEqual(splitUtterances(null), [])
  assert.deepEqual(splitUtterances(12345), ['12345'])
})

test('어미: 반말·해요체·합쇼체 끝말을 알맞은 형태로 찾는다', () => {
  const cases = {
    '어제 진짜 웃겼거든': '거든',
    '그거 내가 말했잖아': '잖아',
    '맛있던데': '던데',
    '거기 생각보다 좋더라': '더라',
    '그렇구나': '구나',
    '가는데': '는데',
    '좋은데': '는데',
    '예쁜데': '는데',
    '먹었지': '지',
    '좋긴 해': '긴 해',
    '할 거야': '거야',
    '이따 연락할게': 'ㄹ게',
    '같이 갈래': 'ㄹ래',
    '뭐 먹을까': 'ㄹ까',
    '진짜냐': '냐',
    '빨리 가자': '자',
    '그 영화 봤어': '어',
    '오늘 너무 좋아': '아',
    '진짜 미안해': '어',
    '귀여워': '어',
    '몰라': '아',
    '좋아요': '아요',
    '저도 했어요': '어요',
    '그렇죠': '죠',
    '날씨 좋네요': '네요',
    '맛있더라고요': '더라고요',
    '감사합니다': '습니다',
    '먼저 갑니다': '습니다',
  }
  for (const [line, form] of Object.entries(cases)) assert.deepEqual(endingOf(line), [form], line)
})

test('어미: 애교 받침(ㅇ·ㅁ)은 cute로 찾고 높임 단계는 원래 어미를 따른다', () => {
  const cases = { 가용: '용', 했어욤: '욤', 좋당: '당', 맞넹: '넹', 그렇징: '징', 했엉: '엉', 좋앙: '앙', 나얌: '얌', 고마웡: '엉' }
  for (const [line, form] of Object.entries(cases)) {
    const p = analyze([line])
    assert.deepEqual(forms(p.endings), [form], line)
    assert.equal(p.endings[0].kind, 'cute', line)
  }
  const haeyo = analyze(['저 지금 가용', '밥 먹었어용', '좋아용'])
  assert.equal(haeyo.register.dominant, 'haeyo')
  assert.equal(haeyo.register.cute, 1)
  assert.equal(analyze(['좋당', '맞넹', '그렇징']).register.dominant, 'banmal')
})

test('어미: 음슴체를 찾되, ㅁ으로 끝나는 명사는 세지 않는다', () => {
  assert.deepEqual(endingOf('오늘 진짜 맛있었음'), ['음'])
  assert.deepEqual(endingOf('이거 완전 레전드임'), ['임'])
  assert.deepEqual(endingOf('회의 세 개 연달아 함'), ['함'])
  assert.deepEqual(endingOf('나 먼저 집에 감'), ['ㅁ'])
  assert.deepEqual(endingOf('생각보다 일찍 끝남'), ['ㅁ'])
  for (const noun of ['사람', '마음', '처음', '다음', '이름', '지금', '조금', '요즘', '가끔', '그림', '바람', '밤', '봄', '점심', '아침', '이 게임', '오늘 모임', '음']) {
    assert.deepEqual(endingOf(noun), [], noun)
  }
  const p = analyze(['출근길 사람 많았음', '점심은 김밥 먹음', '퇴근하고 바로 옴', '내일 일찍 잘 예정임'])
  assert.equal(p.register.dominant, 'eumseum')
})

test('어미: 어미처럼 끝나는 명사·감탄사·숫자·영어는 어미가 아니다', () => {
  for (const line of ['우리 강아지', '바다', '돼지', '동네', '연어', '내용', '식당', '여자', '공군', '필요', '노래', '음', '어', '네', 'ㅋㅋㅋ', 'ok', '3시', '점심은 떡볶이']) {
    assert.deepEqual(endingOf(line), [], line)
  }
})

test('높임 단계: 비율과 대표 단계', () => {
  const p = analyze(['좋아', '했어', '그렇지', '맞아요'])
  assert.equal(p.register.dominant, 'banmal')
  assert.equal(p.register.shares.banmal, 0.75)
  assert.equal(p.register.shares.haeyo, 0.25)
  const none = analyze(['떡볶이', '점심'])
  assert.equal(none.register.dominant, 'banmal')
  assert.deepEqual(none.register.shares, { banmal: 0, haeyo: 0, hapsyo: 0, eumseum: 0 })
})

test('추임새: 첫머리의 두 어절 추임새를 먼저 찾고, 일부는 어디에 있든 센다', () => {
  const p = analyze(['아 근데 오늘 비 온대', '아니 근데 그게 말이 돼?', '오늘 약간 피곤해', '그냥 약간 그래', '음… 모르겠어'])
  const f = Object.fromEntries(p.fillers.map((x) => [x.form, x.count]))
  assert.equal(f['아 근데'], 1)
  assert.equal(f['아니 근데'], 1)
  assert.equal(f['약간'], 2)
  assert.equal(f['그냥'], 1)
  assert.equal(f['음'], 1)
  assert.ok(!('아' in f), '‘아 근데’의 ‘아’를 따로 세지 않는다')
})

test('추임새: 지시어 ‘그’, 의문사 ‘뭐’는 쉼표·말줄임이 붙을 때만 추임새로 센다', () => {
  assert.deepEqual(forms(analyze(['그 영화 봤어?', '뭐 먹을래?']).fillers), [])
  const p = analyze(['그… 있잖아 그거', '뭐, 그냥 그래'])
  assert.ok(forms(p.fillers).includes('그'))
  assert.ok(forms(p.fillers).includes('뭐'))
})

test('표현: 두 번 이상 나온 내용어와 두 어절 표현, 숫자·초성·추임새는 뺀다', () => {
  const lines = ['오늘 떡볶이 먹었어', '떡볶이 또 먹고 싶다', '완전 꿀잼이었어', '이 영상 완전 꿀잼', 'ㄹㅇ 꿀잼', '3시에 보자', '3시 괜찮아?', '진짜 진짜 좋아']
  const p = analyze(lines)
  const ex = forms(p.expressions)
  assert.ok(ex.includes('떡볶이'), ex.join(','))
  assert.ok(ex.some((x) => x.includes('꿀잼')), ex.join(','))
  for (const bad of ['3시', 'ㄹㅇ', '진짜', '오늘']) assert.ok(!ex.includes(bad), `${bad} 제외`)
})

test('표현: 두 어절 표현이 낱말 쓰임 대부분을 차지하면 낱말 대신 표현을 남긴다', () => {
  const p = analyze(['진짜 웃겨', '진짜 웃겨 죽겠다', '아 진짜 웃겨'])
  const ex = forms(p.expressions)
  assert.ok(ex.includes('진짜 웃겨'), ex.join(','))
  assert.ok(!ex.includes('웃겨'), ex.join(','))
})

test('표현: 개인정보로 보이는 낱말은 표현에 넣지 않는다', () => {
  const p = analyze(['메일은 me@example.com', '메일은 me@example.com', '@myhandle 팔로우', '@myhandle 팔로우'])
  for (const x of forms(p.expressions)) assert.ok(!/@/.test(x), x)
})

test('웃음·기호 습관', () => {
  const p = analyze(['ㅋㅋㅋ 대박', '진짜ㅋㅋㅋ', '아 웃겨ㅋㅋㅋㅋㅋㅋㅋㅋ', '좋아~', '가자~~', '헐!!', '뭐야!!', 'ㄹㅇ 맞아', 'ㄷㄷㄷ', '고마워 😊', '좋다 😊', '슬퍼ㅠㅠ', '^^ 안녕'])
  assert.equal(p.laugh.kk.count, 3)
  assert.equal(p.laugh.kk.typical, 'ㅋㅋㅋ')
  assert.ok(p.laugh.kk.per100 > 20)
  assert.equal(p.laugh.cry.typical, 'ㅠㅠ')
  assert.equal(p.laugh.hh, null)
  assert.deepEqual(p.laugh.emoji[0], { form: '😊', count: 2 })
  assert.ok(forms(p.laugh.choseong).includes('ㄹㅇ'))
  assert.ok(forms(p.laugh.choseong).includes('ㄷㄷ'), '늘인 ㄷㄷㄷ도 ㄷㄷ로 센다')
  assert.ok(forms(p.laugh.emoticons).includes('^^'))
  assert.ok(p.laugh.punct.typical.includes('!!'))
  assert.ok(p.laugh.punct.typical.includes('~'))
  assert.ok(p.laugh.elongation > 0)
})

test('늘여 쓰기: ㅠㅠ·ㅡㅡ는 늘여 쓰기로 세지 않는다', () => {
  assert.equal(analyze(['슬퍼ㅠㅠ', '뭐야 ㅡㅡ']).laugh.elongation, 0)
  assert.equal(analyze(['좋아아아', '가자~~']).laugh.elongation, 1)
})

test('리듬·출처: 글 길이 통계와 음성 정보', () => {
  const rhythm = { seconds: 40, speakingSec: 30, pauseRatio: 0.25, phraseCount: 12, avgPhraseSec: 2.5, syllPerSec: 7.1, tempo: 'fast', phrasing: 'even' }
  const p = analyzeStyle({ textUtterances: ['짧게', '이건 조금 더 긴 문장이에요'], voiceUtterances: ['음 그니까 오늘 진짜 재밌었거든'], voiceRhythm: rhythm, voiceMeta: { seconds: 40, onDevice: true }, now })
  assert.deepEqual(p.sources.text, { chars: 17, utterances: 2 })
  assert.equal(p.sources.voice.seconds, 40)
  assert.equal(p.sources.voice.onDevice, true)
  assert.equal(p.rhythm.voice.tempo, 'fast')
  assert.equal(p.rhythm.text.shortShare, 0.5)
  assert.equal(p.endings.find((e) => e.form === '거든').source, 'voice')
  assert.ok(p.summary.tags.includes('말 빠른 편'))
})

test('출처 표시: 글과 말에 모두 나온 항목은 both', () => {
  const p = analyzeStyle({ textUtterances: ['어제 진짜 웃겼거든'], voiceUtterances: ['그거 진짜 좋았거든'], now })
  assert.equal(p.endings.find((e) => e.form === '거든').source, 'both')
})

test('대표 문장: 개인정보·긴 숫자가 있는 문장은 고르지 않고, 겹치는 문장은 하나만', () => {
  const lines = [...BANMAL_KK, '내 번호 010-1234-5678로 연락해', '계좌는 1234567890이야', '진짜 대박이었어ㅋㅋㅋ', '아']
  const p = analyze(lines)
  assert.ok(p.samples.length > 0 && p.samples.length <= LIMITS.profile.samples)
  for (const s of p.samples) {
    assert.ok(!/010|1234567890/.test(s), s)
    assert.ok([...s].length >= 6 && [...s].length <= LIMITS.profile.sampleMaxChars, s)
  }
  assert.equal(p.samples.filter((s) => s === '진짜 대박이었어ㅋㅋㅋ').length, 1)
})

test('최소 근거: 발화가 30개 이상이면 한 번만 나온 어미는 뺀다', () => {
  const lines = [...Array.from({ length: 30 }, (_, i) => `오늘 ${i}번 웃겼거든`), '같이 갈래']
  const p = analyze(lines)
  assert.ok(forms(p.endings).includes('거든'))
  assert.ok(!forms(p.endings).includes('ㄹ래'))
})

test('요약: 높임 단계·추임새·어미로 한 문장, 조사도 받침에 맞춘다', () => {
  const p = analyze(BANMAL_KK)
  assert.match(p.summary.line, /^반말 위주에, ‘.+’(으로|로) 말을 꺼내고 ‘~.+’(으로|로) 끝맺는 편이에요\.$/)
  assert.ok(p.summary.tags.includes('반말 위주'))
  assert.ok(p.summary.tags.includes('ㅋㅋ 자주'))
  assert.ok(p.summary.tags.length <= 6)
  const s = summarizeProfile({ register: { dominant: 'banmal', shares: { banmal: 1, haeyo: 0, hapsyo: 0, eumseum: 0 } }, fillers: [{ form: '약간' }], endings: [{ form: '거든' }] })
  assert.equal(s.line, '반말 위주에, ‘약간’으로 말을 꺼내고 ‘~거든’으로 끝맺는 편이에요.')
  const s2 = summarizeProfile({ register: { dominant: 'haeyo', shares: { haeyo: 1 } }, fillers: [{ form: '아 근데' }], endings: [{ form: '네요' }] })
  assert.equal(s2.line, '해요체 위주에, ‘아 근데’로 말을 꺼내고 ‘~네요’로 끝맺는 편이에요.')
  assert.ok(summarizeProfile(null).line.length > 0)
  assert.deepEqual(summarizeProfile({}).tags, [])
})

test('요약본: 한도와 형식을 지키고, 직접 넣은 항목을 앞에 둔다', () => {
  const many = Array.from({ length: 40 }, (_, i) => `표현${i % 9}번 진짜 좋았거든ㅋㅋ ${'가나다라마바사'.slice(0, (i % 7) + 1)}${i % 3 ? '요' : ''}`)
  let p = analyze(many)
  p = addItem(p, 'endings', '더라', now)
  const payload = profileToPayload(p)
  assert.ok(payload.endings.length <= 6 && payload.fillers.length <= 6 && payload.expressions.length <= 8 && payload.samples.length <= 12)
  assert.equal(payload.endings[0], '더라')
  assert.equal(payload.tail.kk, 'ㅋㅋ')
  assert.equal(payload.hasText, true)
  assert.equal(payload.hasVoice, false)
  for (const s of payload.samples) assert.ok([...s].length <= 80)
  const empty = profileToPayload(undefined)
  assert.equal(empty.register, 'banmal')
  assert.deepEqual(empty.endings, [])
  assert.equal(empty.rhythm.tempo, 'unknown')
})

test('항목 고치기: 원본을 바꾸지 않고, 겹치거나 빈 값은 무시한다', () => {
  const p = analyze(BANMAL_KK)
  const before = JSON.stringify(p)
  const added = addItem(p, 'fillers', '  아니 진짜  ', new Date('2026-11-12T00:00:00Z'))
  assert.notEqual(added, p)
  assert.equal(JSON.stringify(p), before, '원본 그대로')
  assert.deepEqual(added.fillers.at(-1), { form: '아니 진짜', count: 0, share: 0, source: 'user' })
  assert.equal(added.updatedAt, '2026-11-12T00:00:00.000Z')
  assert.equal(addItem(added, 'fillers', '아니 진짜'), added, '겹치면 그대로')
  assert.equal(addItem(added, 'fillers', '   '), added, '빈 값은 그대로')
  assert.equal(addItem(added, 'nope', 'x'), added, '모르는 종류는 그대로')
  assert.equal(addItem(added, 'endings', '~거든요').endings.at(-1).form, '거든요', '앞의 ~는 뗀다')
  assert.equal([...addItem(p, 'expressions', '가'.repeat(50)).expressions.at(-1).form].length, LIMITS.profile.itemMaxChars)
  const removed = removeItem(added, 'fillers', '아니 진짜')
  assert.equal(removed.fillers.length, p.fillers.length)
  assert.equal(removeItem(removed, 'fillers', '없는 말'), removed)
  const firstSample = p.samples[0]
  assert.ok(!removeItem(p, 'samples', firstSample).samples.includes(firstSample))
})

test('항목 고치기: 대표 문장에 넣는 연락처는 가리고, 종류별 상한을 넘지 않는다', () => {
  let p = analyze(BANMAL_KK)
  p = addItem(p, 'samples', '내 번호는 010-9876-5432야')
  assert.equal(p.samples.at(-1), '내 번호는 ○○○야')
  let q = analyze(BANMAL_KK)
  for (let i = 0; i < 40; i++) q = addItem(q, 'expressions', `표현${i}`)
  assert.ok(q.expressions.length <= LIMITS.profile.expressions + LIMITS.profile.customItems)
})

test('isUsableProfile', () => {
  assert.equal(isUsableProfile(analyze(BANMAL_KK)), true)
  assert.equal(isUsableProfile(analyze([])), false)
  assert.equal(isUsableProfile(null), false)
  assert.equal(isUsableProfile({ version: 2, endings: [{ form: '거든' }] }), false)
  assert.equal(isUsableProfile({ version: 1, samples: ['안녕하세요 반가워요'] }), true)
})

test('엉터리 입력에도 죽지 않는다', () => {
  for (const input of [undefined, null, {}, { textUtterances: 'x' }, { textUtterances: [null, 1, {}, [], '   '] }, { voiceRhythm: 'x', voiceMeta: 5 }, { now: 'not-a-date' }]) {
    const p = analyzeStyle(input ?? undefined)
    assert.equal(p.version, 1)
    assert.ok(Array.isArray(p.endings))
    assert.ok(typeof p.summary.line === 'string')
  }
})

test('큰 입력도 빠르게 처리하고 한도를 지킨다', () => {
  const big = Array.from({ length: 6000 }, (_, i) => `오늘 ${i}번째로 진짜 웃긴 일 있었거든ㅋㅋㅋ 아 근데 약간 피곤하네`)
  const t0 = performance.now()
  const p = analyze(big)
  const ms = performance.now() - t0
  assert.ok(ms < 2000, `${ms}ms`)
  assert.ok(p.sources.text.utterances <= LIMITS.text.maxUtterances)
  assert.ok(p.endings.length <= LIMITS.profile.endings && p.fillers.length <= LIMITS.profile.fillers && p.expressions.length <= LIMITS.profile.expressions)
})

test('같은 입력이면 같은 결과', () => {
  assert.deepEqual(analyze(BANMAL_KK), analyze(BANMAL_KK))
})

test('대표 문장 출처: 글·말 출처를 순서대로 남기고, 넣고 지울 때도 맞춘다', () => {
  const p = analyzeStyle({ textUtterances: ['어제 진짜 웃겼거든ㅋㅋ', '오늘은 떡볶이 먹었어'], voiceUtterances: ['음 그니까 버스에서 노래를 부르시더라고'], voiceMeta: { seconds: 30 }, now })
  assert.equal(p.sampleSources.length, p.samples.length)
  assert.ok(p.sampleSources.includes('voice'))
  assert.ok(p.sampleSources.includes('text'))
  const added = addItem(p, 'samples', '직접 넣은 문장이에요')
  assert.equal(added.sampleSources.at(-1), 'user')
  assert.equal(added.sampleSources.length, added.samples.length)
  const removed = removeItem(added, 'samples', added.samples[0])
  assert.equal(removed.sampleSources.length, removed.samples.length)
  assert.deepEqual(removed.sampleSources, added.sampleSources.slice(1))
  assert.deepEqual(profileToPayload(p).samples, p.samples, '요약본에는 문장만 간다')
})

test('음성 데이터 걷어 내기: 받아쓴 문장·말에서만 나온 항목·말 리듬을 지우고, 둘 다 나온 항목은 말 횟수만 덜어 낸다', () => {
  const rhythm = { seconds: 40, speakingSec: 30, pauseRatio: 0.2, phraseCount: 10, avgPhraseSec: 3, syllPerSec: 7, tempo: 'fast', phrasing: 'even' }
  const p = analyzeStyle({
    textUtterances: ['어제 진짜 웃겼거든', '그거 내가 말했잖아', '오늘은 떡볶이 먹었어'],
    voiceUtterances: ['그 영화 진짜 재밌었거든', '우리 엄마가 병원에서 그러시더라'],
    voiceRhythm: rhythm,
    voiceMeta: { seconds: 40 },
    now,
  })
  assert.equal(p.endings.find((e) => e.form === '거든').source, 'both')
  const q = removeVoiceData(p, now)
  assert.notEqual(q, p)
  assert.equal(q.sources.voice, null)
  assert.equal(q.rhythm.voice, null)
  assert.ok(!q.samples.some((s) => s.includes('병원') || s.includes('영화')), q.samples.join(' / '))
  assert.equal(q.sampleSources.length, q.samples.length)
  assert.ok(!q.sampleSources.includes('voice'))
  const geodeun = q.endings.find((e) => e.form === '거든')
  assert.equal(geodeun.source, 'text')
  assert.equal(geodeun.count, 1)
  assert.ok(!q.endings.some((e) => e.form === '더라'), '말에서만 나온 어미는 지운다')
  assert.ok(!q.summary.tags.includes('말 빠른 편'))
  assert.equal(removeVoiceData(q, now), q, '음성이 없으면 그대로')
})

test('음성 데이터 걷어 내기: 출처 표시가 없는 예전 프로필은 대표 문장을 지운다', () => {
  const p = analyzeStyle({ textUtterances: ['어제 진짜 웃겼거든'], voiceUtterances: ['우리 엄마가 병원에서 그러시더라'], voiceMeta: { seconds: 20 }, now })
  const legacy = { ...p }
  delete legacy.sampleSources
  const q = removeVoiceData(legacy, now)
  assert.deepEqual(q.samples, [])
})

test('프로필 더하기: 목소리 분석을 지금 프로필에 더한다', () => {
  const base = analyzeStyle({ textUtterances: ['어제 진짜 웃겼거든ㅋㅋ', '그거 내가 말했잖아', '오늘은 떡볶이 먹었어', '약간 피곤하더라'], now })
  const withUser = addItem(base, 'fillers', '아니 진짜', now)
  const voice = analyzeStyle({ voiceUtterances: ['아 근데 그 영화 진짜 재밌었거든', '약간 졸리더라'], voiceRhythm: { seconds: 30, speakingSec: 20, pauseRatio: 0.3, phraseCount: 8, avgPhraseSec: 2.5, syllPerSec: 4.8, tempo: 'slow', phrasing: 'even' }, voiceMeta: { seconds: 30 }, now })
  const m = mergeProfiles(withUser, voice, now)
  assert.ok(m.sources.text && m.sources.voice)
  assert.equal(m.rhythm.voice.tempo, 'slow')
  assert.deepEqual(m.laugh, base.laugh, '웃음 습관은 글 쪽을 쓴다')
  const geodeun = m.endings.find((e) => e.form === '거든')
  assert.equal(geodeun.source, 'both')
  assert.equal(geodeun.count, 2)
  assert.ok(m.fillers.some((f) => f.form === '아니 진짜' && f.source === 'user'), '직접 넣은 항목은 남긴다')
  assert.equal(m.samples.length, m.sampleSources.length)
  assert.ok(m.sampleSources.includes('voice') && m.sampleSources.includes('text'))
  assert.ok(m.summary.tags.includes('말 느긋한 편'))
  assert.equal(mergeProfiles(null, voice, now), voice)
  // 더한 뒤 음성 동의를 거두면 원래 글 프로필 쪽으로 돌아간다
  const back = removeVoiceData(m, now)
  assert.equal(back.endings.find((e) => e.form === '거든').count, 1)
  assert.ok(!back.sampleSources.includes('voice'))
})
