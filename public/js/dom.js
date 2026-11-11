// 작은 DOM 도우미. innerHTML을 쓰지 않아 사용자 입력·AI 결과·외부 데이터가 마크업으로 해석되지 않는다.

const SVG_NS = 'http://www.w3.org/2000/svg'
const PROPS = new Set(['value', 'checked', 'disabled', 'hidden', 'selected', 'htmlFor', 'type', 'name', 'id', 'placeholder', 'rows', 'maxLength', 'accept', 'multiple', 'tabIndex', 'open', 'href', 'target', 'rel', 'title', 'min', 'max', 'step', 'readOnly', 'autocomplete', 'inputMode', 'download', 'src', 'alt', 'width', 'height', 'required'])

function append(parent, child) {
  if (child === null || child === undefined || child === false || child === true) return
  if (Array.isArray(child)) {
    for (const c of child) append(parent, c)
    return
  }
  parent.append(child instanceof Node ? child : document.createTextNode(String(child)))
}

/**
 * 요소를 만든다.
 * @param {string} tag
 * @param {Record<string, any>|null} [props] class, dataset, style(객체), on*(이벤트), aria-*, 그 밖의 속성
 * @param {...any} children 문자열·숫자·노드·배열 (null/false는 건너뜀)
 * @returns {HTMLElement}
 */
export function h(tag, props, ...children) {
  const el = document.createElement(tag)
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) {
        if (key === 'checked' || key === 'disabled' || key === 'hidden' || key === 'selected' || key === 'open') el[key] = false
        continue
      }
      // 반복문은 꼭 중괄호로 감싼다: 감싸지 않으면 뒤의 else가 반복문 안쪽 if에 붙는다
      if (key === 'class') {
        el.className = value
      } else if (key === 'text') {
        el.textContent = String(value)
      } else if (key === 'dataset') {
        for (const [k, v] of Object.entries(value)) {
          if (v !== null && v !== undefined) el.dataset[k] = String(v)
        }
      } else if (key === 'style') {
        for (const [k, v] of Object.entries(value)) el.style.setProperty(k, String(v))
      } else if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value)
      } else if (PROPS.has(key)) {
        el[key] = value
      } else {
        el.setAttribute(key, value === true ? '' : String(value))
      }
    }
  }
  for (const child of children) append(el, child)
  return el
}

/** 요소의 자식을 모두 지우고 새 자식으로 바꾼다. */
export function mount(el, ...children) {
  el.replaceChildren()
  for (const child of children) append(el, child)
  return el
}

const ICONS = {
  mic: ['M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z', 'M19 10v2a7 7 0 0 1-14 0v-2', 'M12 19v3'],
  stop: ['M7 7h10v10H7z'],
  check: ['M20 6 9 17l-5-5'],
  x: ['M18 6 6 18', 'M6 6l12 12'],
  plus: ['M12 5v14', 'M5 12h14'],
  like: ['M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.3a2 2 0 0 0 2-1.7l1.4-9a2 2 0 0 0-2-2.3H14z', 'M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3'],
  dislike: ['M10 15v4a3 3 0 0 0 3 3l4-9V2H5.7a2 2 0 0 0-2 1.7l-1.4 9a2 2 0 0 0 2 2.3H10z', 'M17 2h2.7A2.3 2.3 0 0 1 22 4v7a2.3 2.3 0 0 1-2.3 2H17'],
  bookmark: ['M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z'],
  share: ['M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8', 'M16 6l-4-4-4 4', 'M12 2v13'],
  flag: ['M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z', 'M4 22v-7'],
  external: ['M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6', 'M15 3h6v6', 'M10 14 21 3'],
  refresh: ['M23 4v6h-6', 'M1 20v-6h6', 'M3.5 9a9 9 0 0 1 14.9-3.4L23 10', 'M1 14l4.6 4.4A9 9 0 0 0 20.5 15'],
  trash: ['M3 6h18', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6', 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2'],
  info: ['M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z', 'M12 16v-4', 'M12 8h.01'],
  alert: ['M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z', 'M12 9v4', 'M12 17h.01'],
  download: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M7 10l5 5 5-5', 'M12 15V3'],
  copy: ['M20 9h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2z', 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'],
  arrowRight: ['M5 12h14', 'M12 5l7 7-7 7'],
  arrowLeft: ['M19 12H5', 'M12 19l-7-7 7-7'],
  upload: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M17 8l-5-5-5 5', 'M12 3v12'],
  sparkle: ['M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z', 'M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z'],
  shield: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'],
  user: ['M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2', 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z'],
  edit: ['M12 20h9', 'M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z'],
}

/** 선으로 그린 아이콘(SVG). 장식용이라 보조 기술에는 숨긴다. */
export function icon(name, { size } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('class', 'ico')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  if (size) {
    svg.style.setProperty('width', `${size}px`)
    svg.style.setProperty('height', `${size}px`)
  }
  for (const d of ICONS[name] || []) {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', d)
    svg.append(path)
  }
  return svg
}

/** ISO 시각을 '11월 11일 오후 3:20' 꼴로 */
export function formatDateTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat('ko-KR', { month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d)
}

/** 숫자를 천 단위 쉼표와 함께 */
export function formatNumber(n) {
  return new Intl.NumberFormat('ko-KR').format(Number(n) || 0)
}
