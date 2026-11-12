// 알림(토스트)과 모달.
import { h, icon } from './dom.js'

export function toast(message, { type = 'info', ms = 3200 } = {}) {
  const root = document.getElementById('toast-root')
  if (!root) return
  const el = h('div', { class: 'toast', dataset: { type } }, message)
  root.append(el)
  // 한꺼번에 너무 많이 쌓이지 않게
  while (root.children.length > 3) root.firstElementChild.remove()
  setTimeout(() => el.remove(), ms)
}

let closeCurrent = null

/** 열려 있는 창을 닫는다(화면을 옮길 때). */
export function closeModals() {
  if (closeCurrent) closeCurrent()
}

/**
 * 모달을 연다. 돌려주는 close()로 닫는다.
 * @param {{ title: string, body: Node|Node[]|string, actions?: Node[], wide?: boolean, onClose?: () => void }} opts
 */
export function openModal({ title, body, actions = [], wide = false, onClose } = {}) {
  if (closeCurrent) closeCurrent()
  const root = document.getElementById('modal-root')
  const previouslyFocused = document.activeElement
  const titleId = `modal-title-${Date.now().toString(36)}`

  const close = () => {
    if (closeCurrent !== close) return
    closeCurrent = null
    document.removeEventListener('keydown', onKey, true)
    backdrop.remove()
    document.body.style.removeProperty('overflow')
    if (onClose) onClose()
    if (previouslyFocused instanceof HTMLElement && document.contains(previouslyFocused)) previouslyFocused.focus()
  }

  const dialog = h(
    'div',
    { class: `modal${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId, tabIndex: -1 },
    h(
      'div',
      { class: 'row between' },
      h('h2', { id: titleId }, title),
      h('button', { class: 'btn ghost small', type: 'button', 'aria-label': '닫기', onClick: close }, icon('x')),
    ),
    h('div', { class: 'modal-body stack' }, body),
    actions.length ? h('div', { class: 'modal-actions' }, actions) : null,
  )
  const backdrop = h('div', { class: 'modal-backdrop', onMousedown: (e) => e.target === backdrop && close() }, dialog)

  function onKey(e) {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
      return
    }
    if (e.key !== 'Tab') return
    // 초점이 모달 밖으로 나가지 않게 한다
    const focusables = dialog.querySelectorAll('a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])')
    if (!focusables.length) return
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    const active = document.activeElement
    // 창 자체에 초점이 있거나 창 밖으로 빠진 경우도 창 안으로 되돌린다
    if (!dialog.contains(active) || active === dialog) {
      e.preventDefault()
      ;(e.shiftKey ? last : first).focus()
    } else if (e.shiftKey && active === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault()
      first.focus()
    }
  }

  document.addEventListener('keydown', onKey, true)
  document.body.style.setProperty('overflow', 'hidden')
  root.append(backdrop)
  closeCurrent = close
  dialog.focus()
  return close
}

/** 확인 모달. 확인을 누르면 true. */
export function confirmDialog({ title, message, confirmLabel = '확인', cancelLabel = '취소', danger = false }) {
  return new Promise((resolve) => {
    let answered = false
    const done = (value) => {
      if (answered) return
      answered = true
      resolve(value)
      close()
    }
    const close = openModal({
      title,
      body: typeof message === 'string' ? h('p', null, message) : message,
      actions: [
        h('button', { class: 'btn outline', type: 'button', onClick: () => done(false) }, cancelLabel),
        h('button', { class: `btn ${danger ? 'danger' : 'dark'}`, type: 'button', onClick: () => done(true) }, confirmLabel),
      ],
      onClose: () => {
        if (!answered) {
          answered = true
          resolve(false)
        }
      },
    })
  })
}

/** 클립보드에 복사. 실패하면 false. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // 권한이 없거나 오래된 브라우저 — 임시 입력창으로 한 번 더 시도
    const ta = h('textarea', { value: text, readOnly: true, class: 'sr-only', 'aria-hidden': 'true' })
    document.body.append(ta)
    ta.select()
    let ok = false
    try {
      ok = document.execCommand('copy')
    } catch {
      ok = false
    }
    ta.remove()
    return ok
  }
}
