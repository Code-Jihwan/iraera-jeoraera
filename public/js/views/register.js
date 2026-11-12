// 1단계 · 말투 등록: 고지와 동의 → 내가 쓴 글(붙여넣기·카카오톡 파일) → 목소리 녹음(선택) → 분석
// 붙여 넣은 원문·대화 파일·녹음 결과는 이 모듈의 변수에만 잠깐 두고, 분석이 끝나면 지운다.
import { h, icon } from '../dom.js'
import { getState, update, hasConsent, hasVoiceConsent, consentNeedsRenewal, engineUsesLlm } from '../store.js'
import { toast, confirmDialog } from '../ui.js'
import { CONSENT_VERSION, LIMITS } from '../../shared/constants.js'
import { charLength } from '../../shared/hangul.js'
import { analyzeStyle, splitUtterances, isUsableProfile, mergeProfiles } from '../../shared/style-analyzer.js'
import { parseChatExport, extractOwnUtterances } from '../../shared/kakao-parser.js'
import { VoiceSession, voiceSupport } from '../voice.js'
import { SAMPLE_PERSONAS } from '../samples.js'
import { AGE_HELP, AGE_LABEL, hostingNotice, inputCaution, isStaticHosting, textConsentTable, transferNotice, voiceConsentTable, voiceExtraNotice } from '../notices.js'

const MAX_FILE_BYTES = 10 * 1024 * 1024
const LEVEL_BARS = 24

// 말버릇이 드러나도록, 읽을 글 대신 편하게 답할 질문을 준다
const VOICE_PROMPTS = [
  '오늘 있었던 일 중에 제일 기억나는 걸 친구한테 말하듯 얘기해 주세요.',
  '요즘 푹 빠진 것(음식, 영상, 취미)을 친구한테 추천하듯 말해 주세요.',
  '최근에 웃겼던 일을 떠올려서 편하게 설명해 주세요.',
  '주말에 뭘 하고 싶은지 생각나는 대로 말해 주세요.',
  '제일 좋아하는 음식이 왜 좋은지 친구를 설득하듯 말해 주세요.',
]

const VOICE_ERRORS = {
  'not-allowed': '마이크 사용이 허용되지 않았어요. 주소창의 마이크 권한을 허용한 뒤 다시 눌러 주세요.',
  'no-mic': '마이크를 찾지 못했어요. 마이크가 연결되어 있는지 확인해 주세요.',
  insecure: '마이크는 https 또는 localhost 주소에서만 쓸 수 있어요.',
  unsupported: '이 브라우저에서는 녹음을 쓸 수 없어요. 글만으로도 프로필을 만들 수 있어요.',
  failed: '녹음을 시작하지 못했어요. 잠시 뒤 다시 시도해 주세요.',
}

function emptyKakao() {
  return { stage: 'idle', fileName: '', format: '', parsed: null, speaker: '', utterances: [], chars: 0 }
}

const draft = {
  editingConsent: false,
  consentForm: { age14: false, text: false, voice: false },
  tab: 'paste',
  text: '',
  sampleId: null,
  kakao: emptyKakao(),
  voice: null,
  manualTranscript: '',
  promptIndex: 0,
}

let session = null
const rec = { state: 'idle', seconds: 0, finals: [], interim: '', level: 0 }
const levelHistory = new Array(LEVEL_BARS).fill(0)

function resetDraftInputs() {
  draft.text = ''
  draft.sampleId = null
  draft.kakao = emptyKakao()
  draft.voice = null
  draft.manualTranscript = ''
}

/** 녹음 중이면 멈추고 모은 것을 버린다. */
function cancelRecording() {
  if (session) {
    session.cancel()
    session = null
  }
  rec.state = 'idle'
  rec.finals = []
  rec.interim = ''
}

/** 녹음과 녹음 결과만 버린다(음성 동의를 거둘 때). */
export function discardVoiceDraft() {
  cancelRecording()
  draft.voice = null
  draft.manualTranscript = ''
}

/** 등록 화면에 남은 입력·녹음·동의 체크를 모두 비운다(전부 지우기). */
export function resetRegisterDraft() {
  cancelRecording()
  resetDraftInputs()
  draft.editingConsent = false
  draft.consentForm = { age14: false, text: false, voice: false }
  draft.tab = 'paste'
}

/** 음성 동의가 있을 때만 녹음 결과를 쓴다. */
function usableVoice() {
  return hasVoiceConsent(getState()) ? draft.voice : null
}

const sumChars = (list) => list.reduce((n, u) => n + charLength(u), 0)

function textStats() {
  const pasted = splitUtterances(draft.text)
  const chars = sumChars(pasted) + draft.kakao.chars
  return { pasted, chars, utterances: pasted.length + draft.kakao.utterances.length }
}

function voiceUtterances() {
  const voice = usableVoice()
  if (!voice) return []
  if (voice.utterances.length) return voice.utterances
  return splitUtterances(draft.manualTranscript)
}

function formatClock(sec) {
  const s = Math.max(0, Math.floor(sec))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

const TEMPO_LABEL = { slow: '느긋한 편', normal: '보통', fast: '빠른 편', unknown: '측정 안 됨' }

// ── 녹음 중 화면 갱신: 다시 그려도 끊기지 않게 매번 id로 찾는다 ──────────────

function paintTimer() {
  const el = document.getElementById('rec-timer')
  if (el) el.textContent = `${formatClock(rec.seconds)} / ${formatClock(LIMITS.voice.maxSeconds)}`
}

function paintLevel() {
  const el = document.getElementById('rec-level')
  if (!el) return
  levelHistory.push(rec.level)
  levelHistory.shift()
  const bars = el.children
  for (let i = 0; i < bars.length; i++) {
    // RMS는 작은 값이라 눈에 보이게 키운다
    const pct = Math.max(8, Math.min(100, Math.round(Math.sqrt(levelHistory[i] || 0) * 260)))
    bars[i].style.setProperty('height', `${pct}%`)
  }
}

function paintTranscript() {
  const el = document.getElementById('rec-transcript')
  if (!el) return
  el.replaceChildren()
  if (rec.finals.length) el.append(rec.finals.join('\n'))
  if (rec.interim) el.append(h('span', { class: 'interim' }, (rec.finals.length ? '\n' : '') + rec.interim))
  el.scrollTop = el.scrollHeight
}

export function registerView(ctx) {
  const s = getState()
  const consented = hasConsent(s, ctx.status)
  const renewal = consentNeedsRenewal(s, ctx.status)
  const voiceConsented = consented && hasVoiceConsent(s)
  const engine = ctx.status?.engine
  const support = voiceSupport()
  const showConsentForm = !consented || draft.editingConsent

  ctx.onLeave((leaving) => {
    // 다른 화면으로 떠나면 녹음을 멈추고 결과를 버린다(같은 화면을 다시 그릴 때는 계속 녹음)
    if (leaving && session) cancelRecording()
  })

  // ── 동의 ──────────────────────────────────────────

  function saveConsent() {
    const f = draft.consentForm
    if (!f.age14 || !f.text) return
    const prev = getState().consent
    const nowIso = new Date().toISOString()
    // 서버 상태를 모르면 국외 이전 안내까지 보여 준 것으로 보고(보수적으로) 그 안내에 동의한 것으로 남긴다.
    // 정적 데모는 AI 엔진이 없어 국외 이전 안내가 해당되지 않는다.
    const transfer = isStaticHosting(ctx.status) ? 'local' : !ctx.status || engineUsesLlm(ctx.status.engine) ? 'llm' : 'local'
    const sameText = Boolean(prev && prev.text && prev.version === CONSENT_VERSION && prev.transfer === transfer)
    update({
      consent: {
        version: CONSENT_VERSION,
        age14: true,
        text: true,
        voice: Boolean(f.voice),
        transfer,
        // 글 동의 시각은 음성 동의를 바꿔도 그대로 둔다
        at: sameText ? prev.at : nowIso,
        voiceAt: f.voice ? (prev?.voice && prev.voiceAt ? prev.voiceAt : nowIso) : null,
      },
    })
    draft.editingConsent = false
    // 음성 동의를 하지 않거나 거두면, 녹음 중이던 것과 녹음 결과를 바로 버린다
    if (!f.voice) discardVoiceDraft()
    toast('동의를 저장했어요.', { type: 'ok' })
    ctx.rerender()
  }

  function consentCheck(key, { required, title, body }) {
    const id = `consent-${key}`
    // 긴 고지 내용은 라벨 밖에 두고 설명으로 연결한다(라벨은 짧게, 표는 따로 읽히게)
    return h(
      'div',
      { class: 'check' },
      h('input', {
        type: 'checkbox',
        id,
        checked: draft.consentForm[key],
        'aria-describedby': `${id}-desc`,
        onChange: (e) => {
          draft.consentForm[key] = e.target.checked
          const btn = document.getElementById('consent-save')
          if (btn) btn.disabled = !(draft.consentForm.age14 && draft.consentForm.text)
        },
      }),
      h(
        'div',
        { class: 'grow stack-s' },
        h('label', { for: id }, h('span', { class: required ? 'req' : 'opt' }, required ? '[필수] ' : '[선택] '), h('strong', null, title)),
        h('div', { id: `${id}-desc`, class: 'stack-s' }, body),
      ),
    )
  }

  function consentSection() {
    if (!showConsentForm) {
      return h(
        'section',
        { class: 'card stack', 'aria-labelledby': 'consent-title' },
        h('h2', { class: 'section-title', id: 'consent-title' }, h('span', { class: 'num' }, icon('check', { size: 16 })), '고지와 동의'),
        h(
          'div',
          { class: 'notice ok' },
          icon('check'),
          h('p', null, `동의 완료 · 글 말투 분석${voiceConsented ? ' · 음성 말투 분석' : ''} (${new Date(s.consent.at).toLocaleDateString('ko-KR')})`),
        ),
        h(
          'div',
          { class: 'row' },
          h(
            'button',
            {
              class: 'btn outline small',
              type: 'button',
              onClick: () => {
                draft.consentForm = { age14: true, text: true, voice: voiceConsented }
                draft.editingConsent = true
                ctx.rerender()
              },
            },
            '동의 내용 보기·바꾸기',
          ),
          h('a', { class: 'btn ghost small', href: '#/data' }, '동의 철회는 ‘내 데이터’에서'),
        ),
      )
    }
    return h(
      'section',
      { class: 'card stack', 'aria-labelledby': 'consent-title' },
      h('h2', { class: 'section-title', id: 'consent-title' }, h('span', { class: 'num' }, '0'), '고지와 동의'),
      renewal
        ? h('div', { class: 'notice caution', role: 'status' }, icon('info'), h('p', null, '안내 내용이 바뀌어 다시 동의가 필요해요. 바뀐 내용을 확인한 뒤 동의해 주세요. 저장된 프로필과 보관함은 그대로 있어요.'))
        : null,
      h('p', { class: 'muted' }, '무엇을, 왜, 언제까지 쓰는지 먼저 알려 드려요. 항목별로 따로 동의할 수 있어요.'),
      consentCheck('age14', { required: true, title: AGE_LABEL, body: h('span', { class: 'help' }, AGE_HELP) }),
      consentCheck('text', { required: true, title: '글 말투 분석에 동의합니다 (개인정보 수집·이용)', body: textConsentTable(engine, ctx.status) }),
      consentCheck('voice', {
        required: false,
        title: '음성 말투 분석에 동의합니다',
        body: [voiceConsentTable(), voiceExtraNotice()],
      }),
      // AI 엔진을 쓰는 서버에서는 국외 이전 안내를 접어 두지 않고 동의 화면에 그대로 보인다.
      // 정적 데모는 어디에서 처리하는지와 GitHub Pages 호스팅 안내를 펼쳐 둔다.
      isStaticHosting(ctx.status)
        ? h('div', { class: 'stack-s' }, h('p', { class: 'label' }, '어디에서 처리하나요?'), transferNotice(engine, ctx.status), hostingNotice())
        : !engine || engineUsesLlm(engine)
          ? h('div', { class: 'stack-s' }, h('p', { class: 'label' }, '프로필 요약이 어디로 전송되나요?'), transferNotice(engine))
          : h('details', { class: 'fold' }, h('summary', null, '프로필 요약이 어디로 전송되나요?'), h('div', { class: 'fold-body' }, transferNotice(engine))),
      h(
        'div',
        { class: 'row end' },
        consented
          ? h(
              'button',
              {
                class: 'btn outline',
                type: 'button',
                onClick: () => {
                  draft.editingConsent = false
                  ctx.rerender()
                },
              },
              '닫기',
            )
          : null,
        h(
          'button',
          { class: 'btn dark', type: 'button', id: 'consent-save', disabled: !(draft.consentForm.age14 && draft.consentForm.text), onClick: saveConsent },
          '동의하고 계속',
        ),
      ),
      h('p', { class: 'tiny muted' }, '필수 항목에 동의해야 다음 입력을 할 수 있어요. 선택 항목은 동의하지 않아도 됩니다.'),
    )
  }

  // ── 글 말투 ──────────────────────────────────────────

  function paintTextMeter() {
    const { chars } = textStats()
    const count = document.getElementById('text-count')
    const bar = document.getElementById('text-meter')
    if (count) {
      count.textContent =
        chars >= LIMITS.text.goodChars
          ? `${chars.toLocaleString('ko-KR')}자 · 충분해요`
          : chars >= LIMITS.text.minChars
            ? `${chars.toLocaleString('ko-KR')}자 · 분석할 수 있어요 (권장 ${LIMITS.text.goodChars.toLocaleString('ko-KR')}자 이상)`
            : `${chars.toLocaleString('ko-KR')}자 · 최소 ${LIMITS.text.minChars}자가 필요해요`
    }
    if (bar) {
      bar.dataset.state = chars >= LIMITS.text.goodChars ? 'good' : 'more'
      bar.firstElementChild.style.setProperty('width', `${Math.min(100, Math.round((chars / LIMITS.text.goodChars) * 100))}%`)
    }
    paintActionHint()
  }

  function pastePanel() {
    return h(
      'div',
      { class: 'stack', role: 'tabpanel', id: 'panel-paste', 'aria-labelledby': 'tab-paste' },
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'own-text' }, '내가 쓴 글'),
        h('textarea', {
          class: 'textarea',
          id: 'own-text',
          rows: 9,
          maxLength: LIMITS.text.maxChars,
          placeholder: '메신저에서 내가 보낸 말, SNS에 올린 글, 댓글을 붙여 넣어 주세요.\n한 줄에 한 마디씩 넣으면 더 정확해요.',
          value: draft.text,
          onInput: (e) => {
            draft.text = e.target.value
            draft.sampleId = null
            paintTextMeter()
          },
        }),
        h('p', { class: 'help' }, '내가 쓴 글만 넣어 주세요. 다른 사람이 쓴 글이 섞이면 말투가 흐려져요.'),
      ),
      h(
        'div',
        { class: 'stack-s' },
        h('p', { class: 'label' }, '넣을 글이 없다면 예시 말투로 체험해 보세요'),
        h(
          'div',
          { class: 'row' },
          SAMPLE_PERSONAS.map((p) =>
            h(
              'button',
              {
                class: 'chip',
                type: 'button',
                'aria-pressed': draft.sampleId === p.id ? 'true' : 'false',
                title: p.desc,
                onClick: () => {
                  draft.text = p.text
                  draft.sampleId = p.id
                  ctx.rerender()
                },
              },
              p.label,
            ),
          ),
        ),
        draft.sampleId ? h('p', { class: 'help' }, '지어낸 예시 글이에요. 이 글로 만든 프로필에는 ‘예시’ 표시가 붙어요.') : null,
      ),
    )
  }

  async function readChatFile(file) {
    if (!file) return
    if (file.size > MAX_FILE_BYTES) {
      toast('파일이 너무 커요. 10MB 이하 파일을 올려 주세요.', { type: 'error' })
      return
    }
    if (/\.zip$/i.test(file.name)) {
      toast('압축 파일은 풀어서 안의 .txt 파일을 올려 주세요.', { type: 'error' })
      return
    }
    let text = ''
    try {
      const buf = await file.arrayBuffer()
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(buf)
      } catch {
        // 오래된 PC 내보내기 파일은 EUC-KR(CP949)인 경우가 있다
        text = new TextDecoder('euc-kr').decode(buf)
      }
    } catch {
      toast('파일을 읽지 못했어요.', { type: 'error' })
      return
    }
    const parsed = parseChatExport(text)
    if (parsed.format === 'unknown' || !parsed.speakers.length) {
      draft.kakao = emptyKakao()
      toast('카카오톡 대화 내보내기 파일이 아닌 것 같아요. ‘직접 붙여넣기’를 이용해 주세요.', { type: 'error', ms: 5000 })
      ctx.rerender()
      return
    }
    draft.kakao = { ...emptyKakao(), stage: 'pick', fileName: file.name, format: parsed.format, parsed, speaker: '' }
    ctx.rerender()
  }

  function importOwnMessages() {
    const k = draft.kakao
    if (!k.parsed || !k.speaker) return
    const utterances = extractOwnUtterances(k.parsed, k.speaker)
    // 상대방 메시지가 든 원본은 여기서 바로 버린다
    draft.kakao = { ...emptyKakao(), stage: 'done', fileName: k.fileName, format: k.format, utterances, chars: sumChars(utterances) }
    if (!utterances.length) toast('가져올 내 메시지가 없어요. 다른 이름을 골라 보세요.', { type: 'error' })
    else toast(`내 메시지 ${utterances.length.toLocaleString('ko-KR')}개만 가져왔어요. 상대방 메시지는 바로 버렸어요.`, { type: 'ok', ms: 4500 })
    ctx.rerender()
  }

  function kakaoPanel() {
    const k = draft.kakao
    let body
    if (k.stage === 'pick') {
      body = h(
        'div',
        { class: 'stack' },
        h('p', null, h('strong', null, k.fileName), ` 에서 ${k.parsed.speakers.length}명의 대화를 찾았어요. 어느 이름이 나인가요?`),
        h(
          'ul',
          { class: 'radio-list' },
          k.parsed.speakers.slice(0, 30).map((sp, i) =>
            h(
              'li',
              null,
              h(
                'label',
                { class: 'radio-item' },
                h('input', {
                  type: 'radio',
                  name: 'kakao-speaker',
                  checked: k.speaker === sp.name,
                  onChange: () => {
                    k.speaker = sp.name
                    const btn = document.getElementById('kakao-import')
                    if (btn) btn.disabled = false
                  },
                  id: `kakao-speaker-${i}`,
                }),
                h('span', { class: 'grow' }, sp.name),
                h('span', { class: 'muted small' }, `${sp.count.toLocaleString('ko-KR')}개`),
              ),
            ),
          ),
        ),
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'btn dark', type: 'button', id: 'kakao-import', disabled: !k.speaker, onClick: importOwnMessages }, '내 메시지만 가져오기'),
          h(
            'button',
            {
              class: 'btn ghost',
              type: 'button',
              onClick: () => {
                draft.kakao = emptyKakao()
                ctx.rerender()
              },
            },
            '취소',
          ),
        ),
        h('p', { class: 'help' }, '고른 이름이 보낸 메시지만 남기고, 나머지는 이 브라우저 메모리에서 바로 지워요. 파일은 서버로 올라가지 않아요.'),
      )
    } else if (k.stage === 'done') {
      body = h(
        'div',
        { class: 'stack' },
        h(
          'div',
          { class: 'notice ok' },
          icon('check'),
          h('p', null, `내 메시지 ${k.utterances.length.toLocaleString('ko-KR')}개(${k.chars.toLocaleString('ko-KR')}자)를 가져왔어요. 상대방 메시지와 이름은 남기지 않았어요.`),
        ),
        h(
          'div',
          { class: 'row' },
          h(
            'button',
            {
              class: 'btn outline small',
              type: 'button',
              onClick: () => {
                draft.kakao = emptyKakao()
                ctx.rerender()
              },
            },
            icon('trash'),
            '가져온 메시지 지우기',
          ),
        ),
      )
    } else {
      body = h(
        'div',
        {
          class: 'dropzone',
          id: 'kakao-drop',
          onDragover: (e) => {
            e.preventDefault()
            e.currentTarget.dataset.over = 'true'
          },
          onDragleave: (e) => {
            e.currentTarget.dataset.over = 'false'
          },
          onDrop: (e) => {
            e.preventDefault()
            e.currentTarget.dataset.over = 'false'
            readChatFile(e.dataTransfer?.files?.[0])
          },
        },
        icon('upload', { size: 28 }),
        h('p', null, h('strong', null, '카카오톡 ‘대화 내용 내보내기’ 파일'), '을 여기에 끌어다 놓거나'),
        h(
          'label',
          { class: 'btn outline', for: 'kakao-file' },
          '파일 고르기',
          h('input', { type: 'file', id: 'kakao-file', class: 'sr-only', accept: '.txt,.csv,text/plain,text/csv', onChange: (e) => readChatFile(e.target.files?.[0]) }),
        ),
        h('p', { class: 'help' }, '.txt 또는 .csv · 10MB 이하 · 파일은 이 브라우저 안에서만 읽어요'),
      )
    }
    return h('div', { class: 'stack', role: 'tabpanel', id: 'panel-kakao', 'aria-labelledby': 'tab-kakao' }, body)
  }

  function textSection() {
    const tab = (id, label) =>
      h(
        'button',
        {
          class: 'tab',
          type: 'button',
          role: 'tab',
          id: `tab-${id}`,
          'aria-selected': draft.tab === id ? 'true' : 'false',
          'aria-controls': `panel-${id}`,
          onClick: () => {
            draft.tab = id
            ctx.rerender()
          },
        },
        label,
      )
    return h(
      'section',
      { class: 'card stack', 'aria-labelledby': 'text-title' },
      h('h2', { class: 'section-title', id: 'text-title' }, h('span', { class: 'num' }, '1'), '글 말투'),
      h('p', { class: 'muted' }, '자주 쓰는 어미·표현, ㅋㅋ·이모티콘 습관을 글에서 찾아요.'),
      inputCaution(),
      h('div', { class: 'tabs', role: 'tablist', 'aria-label': '글 넣는 방법' }, tab('paste', '직접 붙여넣기'), tab('kakao', '카카오톡 대화 파일')),
      draft.tab === 'paste' ? pastePanel() : kakaoPanel(),
      h(
        'div',
        { class: 'stack-s' },
        h('div', { class: 'meterbar', id: 'text-meter', 'aria-hidden': 'true' }, h('span')),
        h('p', { class: 'small muted', id: 'text-count', 'aria-live': 'polite' }, ''),
      ),
    )
  }

  // ── 목소리 말투 ──────────────────────────────────────────

  function paintRecorderControls() {
    const btn = document.getElementById('rec-btn')
    const label = document.getElementById('rec-state')
    const level = document.getElementById('rec-level')
    const on = rec.state === 'recording'
    if (btn) {
      btn.dataset.on = String(on)
      btn.disabled = rec.state === 'starting' || rec.state === 'stopping'
      btn.setAttribute('aria-label', on ? '녹음 끝내기' : '녹음 시작')
      btn.replaceChildren(icon(on ? 'stop' : 'mic'))
    }
    if (level) level.dataset.on = String(on)
    if (label) {
      label.textContent =
        rec.state === 'starting'
          ? '마이크를 준비하고 있어요…'
          : on
            ? '듣고 있어요. 다 말했으면 버튼을 다시 눌러 주세요.'
            : rec.state === 'stopping'
              ? '정리하고 있어요…'
              : '버튼을 누르고 30초~1분쯤 편하게 말해 주세요.'
    }
  }

  function finishRecording(result) {
    if (!session) return
    session = null
    rec.state = 'idle'
    // 녹음 도중 음성 동의를 거뒀다면 결과를 받지 않는다
    if (!result || !hasVoiceConsent(getState())) {
      ctx.rerender()
      return
    }
    draft.voice = result
    if (result.seconds < LIMITS.voice.minSeconds) toast(`녹음이 ${LIMITS.voice.minSeconds}초보다 짧아요. 조금 더 길게 말해 주면 좋아요.`, { ms: 4500 })
    else if (result.stt?.error && !result.utterances.length) toast('받아쓰기가 되지 않았어요. 아래에 말한 내용을 적어 주면 분석에 쓸 수 있어요.', { ms: 5000 })
    ctx.rerender()
  }

  async function startRecording() {
    if (session) return
    rec.state = 'starting'
    rec.seconds = 0
    rec.finals = []
    rec.interim = ''
    rec.level = 0
    levelHistory.fill(0)
    draft.voice = null
    paintRecorderControls()
    paintTimer()
    paintTranscript()
    const current = new VoiceSession({
      maxSeconds: LIMITS.voice.maxSeconds,
      lang: 'ko-KR',
      onLevel: (rms) => {
        rec.level = rms
        paintLevel()
      },
      onInterim: (text) => {
        rec.interim = text
        paintTranscript()
      },
      onFinal: (text) => {
        rec.finals.push(text)
        rec.interim = ''
        paintTranscript()
      },
      onTick: (sec) => {
        rec.seconds = sec
        paintTimer()
      },
      onState: (state) => {
        if (session !== current) return
        rec.state = state
        paintRecorderControls()
      },
      onError: () => {},
    })
    session = current
    try {
      await current.start()
    } catch (err) {
      if (session === current) session = null
      rec.state = 'idle'
      paintRecorderControls()
      toast(VOICE_ERRORS[err?.code] || VOICE_ERRORS.failed, { type: 'error', ms: 5500 })
      return
    }
    rec.state = 'recording'
    paintRecorderControls()
    // 최대 시간이 되면 스스로 멈춘다
    if (current.done && typeof current.done.then === 'function') {
      current.done.then(
        (result) => {
          if (session === current) finishRecording(result)
        },
        () => {
          if (session === current) finishRecording(null)
        },
      )
    }
  }

  async function stopRecording() {
    const current = session
    if (!current || rec.state !== 'recording') return
    rec.state = 'stopping'
    paintRecorderControls()
    let result = null
    try {
      result = await current.stop()
    } catch {
      result = null
    }
    if (session === current) finishRecording(result)
  }

  function voiceResult() {
    const v = draft.voice
    const chars = sumChars(v.utterances)
    const rhythm = v.rhythm
    const sttFailed = !v.utterances.length
    return h(
      'div',
      { class: 'stack' },
      h(
        'div',
        { class: 'stat-row' },
        h('div', { class: 'stat' }, h('div', { class: 'k' }, '녹음 길이'), h('div', { class: 'v' }, `${Math.round(v.seconds)}초`)),
        h('div', { class: 'stat' }, h('div', { class: 'k' }, '받아쓴 글'), h('div', { class: 'v' }, `${chars.toLocaleString('ko-KR')}자`)),
        h(
          'div',
          { class: 'stat' },
          h('div', { class: 'k' }, '말 빠르기'),
          h('div', { class: 'v' }, rhythm?.syllPerSec ? `초당 ${rhythm.syllPerSec}음절` : '—'),
          h('div', { class: 'd' }, TEMPO_LABEL[rhythm?.tempo || 'unknown']),
        ),
      ),
      h('div', { class: 'notice ok' }, icon('shield'), h('p', null, '원본 음성은 저장하지 않았어요. 받아쓴 글과 말 리듬 수치만 분석에 써요.')),
      sttFailed
        ? h(
            'div',
            { class: 'field' },
            h('label', { for: 'manual-transcript' }, '방금 말한 내용을 적어 주세요 (선택)'),
            h('textarea', {
              class: 'textarea',
              id: 'manual-transcript',
              rows: 4,
              maxLength: 2000,
              placeholder: '이 브라우저에서는 받아쓰기가 되지 않았어요. 말한 내용을 적어 주면 말버릇 분석에 쓸 수 있어요.',
              value: draft.manualTranscript,
              onInput: (e) => {
                draft.manualTranscript = e.target.value
                paintActionHint()
              },
            }),
          )
        : h('div', { class: 'field' }, h('span', { class: 'label' }, '받아쓴 글'), h('div', { class: 'transcript' }, v.utterances.join('\n'))),
      h(
        'div',
        { class: 'row' },
        h(
          'button',
          {
            class: 'btn outline small',
            type: 'button',
            onClick: () => {
              draft.voice = null
              draft.manualTranscript = ''
              ctx.rerender()
            },
          },
          icon('refresh'),
          '다시 녹음',
        ),
      ),
    )
  }

  function recorder() {
    return h(
      'div',
      { class: 'recorder' },
      h(
        'div',
        { class: 'prompt-card' },
        h('p', { class: 'tiny' }, '이렇게 말해 보세요'),
        h('p', { class: 'q', id: 'voice-prompt' }, VOICE_PROMPTS[draft.promptIndex % VOICE_PROMPTS.length]),
        h(
          'button',
          {
            class: 'btn ghost small',
            type: 'button',
            onClick: () => {
              draft.promptIndex = (draft.promptIndex + 1) % VOICE_PROMPTS.length
              const q = document.getElementById('voice-prompt')
              if (q) q.textContent = VOICE_PROMPTS[draft.promptIndex]
            },
          },
          icon('refresh'),
          '다른 질문',
        ),
      ),
      h(
        'div',
        { class: 'rec-top' },
        h('button', { class: 'rec-btn', type: 'button', id: 'rec-btn', onClick: () => (rec.state === 'recording' ? stopRecording() : startRecording()) }, icon('mic')),
        h('div', { class: 'stack-s' }, h('div', { class: 'rec-timer', id: 'rec-timer', 'aria-live': 'off' }, ''), h('p', { class: 'small muted', id: 'rec-state', 'aria-live': 'polite' }, '')),
        h('div', { class: 'level', id: 'rec-level', 'aria-hidden': 'true' }, Array.from({ length: LEVEL_BARS }, () => h('i'))),
      ),
      h('div', { class: 'transcript', id: 'rec-transcript', 'data-empty': support.stt ? '말하면 여기에 받아쓴 글이 나타나요.' : '이 브라우저는 받아쓰기를 지원하지 않아 말 리듬만 재요.' }),
    )
  }

  function voiceSection() {
    let body
    if (!voiceConsented) {
      body = h(
        'div',
        { class: 'stack' },
        h('p', { class: 'muted' }, '음성 말투 분석에 동의하면 녹음할 수 있어요. 동의하지 않아도 글만으로 프로필을 만들 수 있어요.'),
        consented
          ? h(
              'div',
              null,
              h(
                'button',
                {
                  class: 'btn outline small',
                  type: 'button',
                  onClick: () => {
                    // 선택 동의는 미리 체크하지 않는다 — 내용을 읽고 직접 고르게 한다
                    draft.consentForm = { age14: true, text: true, voice: false }
                    draft.editingConsent = true
                    ctx.rerender()
                    document.getElementById('consent-title')?.scrollIntoView({ block: 'start' })
                  },
                },
                '음성 동의 내용 보기',
              ),
            )
          : null,
      )
    } else if (!support.secure) {
      body = h('div', { class: 'notice caution' }, icon('alert'), h('p', null, VOICE_ERRORS.insecure))
    } else if (!support.mic && !support.stt) {
      body = h('div', { class: 'notice caution' }, icon('alert'), h('p', null, VOICE_ERRORS.unsupported))
    } else if (draft.voice) {
      body = voiceResult()
    } else {
      body = recorder()
    }
    return h(
      'section',
      { class: 'card stack', 'aria-labelledby': 'voice-title' },
      h('h2', { class: 'section-title', id: 'voice-title' }, h('span', { class: 'num' }, '2'), '목소리 말투', h('span', { class: 'badge' }, '선택')),
      h('p', { class: 'muted' }, '말버릇·추임새·감탄사와 말 리듬(빠르기, 쉼)을 목소리에서 찾아요. 목소리는 저장하지 않아요.'),
      body,
    )
  }

  // ── 분석 ──────────────────────────────────────────

  function readiness() {
    const { chars } = textStats()
    const voice = usableVoice()
    const vChars = sumChars(voiceUtterances())
    const textOk = chars >= LIMITS.text.minChars
    const voiceOk = Boolean(voice) && voice.seconds >= LIMITS.voice.minSeconds && vChars >= 40
    const addingToProfile = isUsableProfile(getState().profile) && !getState().profile.sample && chars === 0
    let hint = ''
    if (!consented) hint = '먼저 필수 항목에 동의해 주세요.'
    else if (session) hint = '녹음을 끝낸 뒤 분석할 수 있어요.'
    else if (!textOk && !voiceOk) hint = chars > 0 ? `글이 ${LIMITS.text.minChars - chars}자 더 필요해요 (또는 ${LIMITS.voice.minSeconds}초 이상 녹음).` : `내가 쓴 글을 ${LIMITS.text.minChars}자 이상 넣거나 ${LIMITS.voice.minSeconds}초 이상 녹음해 주세요.`
    else if (textOk && voice && !voiceOk) hint = '글로 분석해요. 녹음은 너무 짧거나 받아쓴 글이 적어 말 리듬만 반영돼요.'
    else if (voiceOk && addingToProfile) hint = '지금 프로필에 목소리 분석을 더해요.'
    else hint = voiceOk && chars > 0 ? '글과 목소리를 함께 분석해요.' : voiceOk ? '목소리만으로 분석해요.' : '글만으로 분석해요.'
    return { ok: consented && !session && (textOk || voiceOk), hint, textOk, voiceOk, voice }
  }

  function paintActionHint() {
    const r = readiness()
    const hint = document.getElementById('analyze-hint')
    const btn = document.getElementById('analyze-btn')
    if (hint) hint.textContent = r.hint
    if (btn) btn.disabled = !r.ok
  }

  async function analyze() {
    const r = readiness()
    if (!r.ok) {
      toast(r.hint)
      return
    }
    const { pasted } = textStats()
    // 글이 최소 분량에 못 미쳐도, 녹음으로 분석할 수 있으면 있는 글은 함께 쓴다
    const textUtterances = [...pasted, ...draft.kakao.utterances]
    const voice = r.voice
    const current = getState()
    const hasExisting = isUsableProfile(current.profile) && !current.profile.sample
    // 글 없이 목소리만 새로 넣으면(‘목소리 녹음 더하기’) 지금 프로필을 갈아 치우지 않고 더한다
    const addVoiceOnly = hasExisting && textUtterances.length === 0 && r.voiceOk
    if (hasExisting && !addVoiceOnly) {
      const yes = await confirmDialog({ title: '프로필을 새로 만들까요?', message: '지금 프로필(직접 고친 내용 포함)이 새 분석 결과로 바뀌어요.', confirmLabel: '새로 만들기' })
      if (!yes) return
    }
    let analyzed
    try {
      analyzed = analyzeStyle({
        textUtterances,
        // 너무 짧은 녹음은 안내대로 말 리듬만 반영하고 받아쓴 글은 쓰지 않는다
        voiceUtterances: r.voiceOk ? voiceUtterances() : [],
        voiceRhythm: voice?.rhythm ?? null,
        voiceMeta: voice ? { seconds: voice.seconds, onDevice: Boolean(voice.stt?.onDevice) } : null,
        sample: Boolean(draft.sampleId) && !draft.kakao.utterances.length && !voice,
      })
    } catch (err) {
      console.error(err)
      toast('말투를 분석하지 못했어요. 글을 조금 더 넣고 다시 시도해 주세요.', { type: 'error' })
      return
    }
    const profile = addVoiceOnly ? mergeProfiles(current.profile, analyzed) : analyzed
    if (!isUsableProfile(profile)) {
      toast('말투를 찾기에 글이 부족해요. 평소에 쓰는 말을 조금 더 넣어 주세요.', { type: 'error' })
      return
    }
    update({ profile, result: null })
    // 원문과 녹음 결과는 프로필을 만든 즉시 지운다
    resetDraftInputs()
    toast(addVoiceOnly ? '지금 프로필에 목소리 분석을 더했어요. 녹음 결과는 지웠어요.' : '말투 프로필을 만들었어요. 입력한 원문은 지웠어요.', { type: 'ok', ms: 4000 })
    ctx.navigate('#/profile')
  }

  const existing = isUsableProfile(s.profile)
  const ready = readiness()

  const view = h(
    'div',
    { class: 'wrap stack' },
    h(
      'header',
      { class: 'page-head' },
      h('p', { class: 'eyebrow' }, '1단계'),
      h('h1', null, '말투 등록'),
      h('p', null, '내가 쓴 글을 넣고, 원하면 목소리도 녹음해 주세요. 수집 목적·항목·보관 기간을 먼저 알려 드리고 동의를 받아요.'),
    ),
    existing
      ? h(
          'div',
          { class: 'notice' },
          icon('info'),
          h('p', null, '이미 말투 프로필이 있어요. 다시 분석하면 새 프로필로 바뀌어요. ', h('a', { href: '#/profile' }, '지금 프로필 보기')),
        )
      : null,
    consentSection(),
    consented ? textSection() : null,
    consented ? voiceSection() : null,
    h(
      'div',
      { class: 'actionbar' },
      h(
        'div',
        { class: 'actionbar-inner' },
        h('p', { class: 'hint', id: 'analyze-hint', 'aria-live': 'polite' }, ready.hint),
        h('button', { class: 'btn primary big', type: 'button', id: 'analyze-btn', disabled: !ready.ok, onClick: analyze }, '말투 분석하기', icon('arrowRight')),
      ),
    ),
  )

  // 다 그린 뒤, id로 찾는 부분을 한 번 채운다
  queueMicrotask(() => {
    paintTextMeter()
    paintTimer()
    paintRecorderControls()
    paintTranscript()
  })
  return view
}
