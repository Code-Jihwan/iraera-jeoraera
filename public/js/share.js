// 공유 창과 신고 창. 결과 화면과 보관함이 함께 쓴다.
import { h, icon } from './dom.js'
import { getState } from './store.js'
import { api, sendEvent } from './api.js'
import { toast, openModal, copyText } from './ui.js'
import { AI_MARK, REPORT_REASONS } from '../shared/constants.js'
import { drawShareCard, canvasToBlob } from './share-card.js'
import { isStaticHosting, shareSuffix, retentionDays } from './notices.js'

/**
 * @param {{ text:string, examples:string[], requestId:string, candidateId:string, technique?:string, trendKeyword:string, serviceName:string }} item
 */
export function openShareModal(item) {
  const canvas = h('canvas', { width: 1080, height: 1350, role: 'img', 'aria-label': `공유 이미지: ${item.text}` })
  const shareText = `${item.text}\n${shareSuffix(item.serviceName)}`
  let blobPromise = null
  // 그림(글꼴 받기 포함)이 끝나기 전에 저장을 누르면 빈 그림이 나가므로, 저장·공유는 그리기가 끝난 뒤에 한다
  const drawn = drawShareCard(canvas, {
    text: item.text,
    example: item.examples?.[0] || '',
    trendKeyword: item.trendKeyword,
    serviceName: item.serviceName,
    mark: AI_MARK.short,
  }).then(
    () => true,
    () => {
      toast('공유 이미지를 그리지 못했어요.', { type: 'error' })
      return false
    },
  )

  const record = () => sendEvent({ anonId: getState().anonId, type: 'share', requestId: item.requestId, candidateId: item.candidateId, technique: item.technique })

  const getBlob = async () => {
    if (!(await drawn)) return null
    if (!blobPromise) blobPromise = canvasToBlob(canvas)
    return blobPromise
  }

  async function download() {
    const blob = await getBlob()
    if (!blob) {
      toast('이미지를 만들지 못했어요.', { type: 'error' })
      return
    }
    const url = URL.createObjectURL(blob)
    const a = h('a', { href: url, download: `my-catchphrase-${Date.now()}.png` })
    document.body.append(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 3000)
    record()
    toast('이미지를 저장했어요. ‘AI 생성’ 표시가 들어 있어요.', { type: 'ok' })
  }

  async function nativeShare() {
    const blob = await getBlob()
    const file = blob ? new File([blob], 'my-catchphrase.png', { type: 'image/png' }) : null
    try {
      if (file && navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], text: shareText })
      else await navigator.share({ text: shareText })
      record()
    } catch (err) {
      // 사용자가 공유 창을 닫은 경우는 오류가 아니다
      if (err?.name !== 'AbortError') toast('공유하지 못했어요. 이미지 저장이나 문구 복사를 이용해 주세요.', { type: 'error' })
    }
  }

  async function copy() {
    const ok = await copyText(shareText)
    if (ok) {
      record()
      toast('문구를 복사했어요. 끝에 ‘AI 생성’ 표시가 붙어 있어요.', { type: 'ok' })
    } else {
      toast('복사하지 못했어요.', { type: 'error' })
    }
  }

  openModal({
    title: '공유하기',
    body: [
      h('div', { class: 'share-preview' }, canvas),
      h('p', { class: 'small muted' }, `공유 이미지와 복사한 문구에는 ‘${AI_MARK.short}’ 표시가 함께 들어가요. 밈 원문이나 영상은 싣지 않아요.`),
    ],
    actions: [
      h('button', { class: 'btn outline', type: 'button', onClick: copy }, icon('copy'), '문구 복사'),
      typeof navigator.share === 'function' ? h('button', { class: 'btn outline', type: 'button', onClick: nativeShare }, icon('share'), '공유하기') : null,
      h('button', { class: 'btn dark', type: 'button', onClick: download }, icon('download'), '이미지 저장'),
    ].filter(Boolean),
  })
}

/**
 * @param {{ text:string, requestId:string, candidateId:string, trendKeyword:string, engine:string }} item
 * @param {() => void} onReported
 * @param {object|null} [status] 서버 상태(신고 보관 기간 안내용)
 */
export function openReportModal(item, onReported, status = null) {
  // GitHub Pages 정적 데모에는 운영 서버가 없어 신고가 누구에게도 전달되지 않는다 — 화면은 그대로 두고 그 사실만 알린다
  const isStatic = isStaticHosting(status)
  let reason = ''
  let sending = false
  const submit = async (e) => {
    if (sending) return
    if (!reason) {
      toast('신고 사유를 골라 주세요.')
      return
    }
    const note = document.getElementById('report-note')?.value.trim() || ''
    // 두 번 눌러 같은 신고가 두 번 들어가지 않게 보내는 동안 막는다
    sending = true
    const button = e?.currentTarget
    if (button) button.disabled = true
    try {
      await api.report({
        anonId: getState().anonId,
        requestId: item.requestId,
        candidateId: item.candidateId,
        reason,
        text: item.text,
        trendKeyword: item.trendKeyword,
        engine: item.engine,
        note,
      })
      close()
      toast(isStatic ? '이 문구를 목록에서 뺐어요. 데모라 신고 내용은 누구에게도 전달되지 않아요.' : '신고를 접수했어요. 이 문구는 목록에서 뺐어요.', { type: 'ok' })
      onReported()
    } catch (err) {
      toast(err.message, { type: 'error' })
      sending = false
      if (button) button.disabled = false
    }
  }
  const close = openModal({
    title: '이 문구 신고하기',
    body: [
      h('p', null, h('strong', null, `“${item.text}”`)),
      h(
        'ul',
        { class: 'radio-list', role: 'radiogroup', 'aria-label': '신고 사유' },
        REPORT_REASONS.map((r) =>
          h(
            'li',
            null,
            h(
              'label',
              { class: 'radio-item' },
              h('input', {
                type: 'radio',
                name: 'report-reason',
                onChange: () => {
                  reason = r.id
                },
              }),
              h('span', null, r.label),
            ),
          ),
        ),
      ),
      h('div', { class: 'field' }, h('label', { for: 'report-note' }, '덧붙일 말 (선택)'), h('input', { class: 'input', id: 'report-note', type: 'text', maxLength: 200, autocomplete: 'off' })),
      isStatic
        ? h('p', { class: 'tiny muted' }, '이 데모에는 운영 서버가 없어 신고 내용은 누구에게도 전달되지 않아요. 신고하면 이 기기에서만 이 문구를 목록에서 빼요.')
        : h('p', { class: 'tiny muted' }, `신고한 문구, 사유, 덧붙인 말은 검토를 위해 서버에 ${retentionDays(status).reports}일 동안 보관돼요(연락처 같은 부분은 가려서 저장). 내 말투 프로필은 함께 보내지 않아요.`),
    ],
    actions: [h('button', { class: 'btn outline', type: 'button', onClick: () => close() }, '취소'), h('button', { class: 'btn danger', type: 'button', onClick: submit }, icon('flag'), '신고하기')],
  })
}
