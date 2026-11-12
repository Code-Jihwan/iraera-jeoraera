// ES 모듈 소스에서 불러오는 경로(import/export … from, 문자열 import())를 찾는다.
// 주석·문자열·템플릿·정규식 리터럴을 건너뛰는 작은 토큰 분석기라, 주석 속 JSDoc의 import('…')는 세지 않는다.

const KEYWORDS_BEFORE_REGEX = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await'])
const NAME_CHAR = /[\w$\u0080-￿]/

/** @returns {{ type: 'name'|'string'|'punct'|'template'|'regex', value: string }[]} */
export function tokenize(src) {
  const tokens = []
  // '{'는 'brace', 템플릿의 '${'는 'tpl'을 쌓는다. 'tpl'을 닫는 '}'를 만나면 템플릿을 이어 읽는다.
  const braces = []
  const n = src.length
  let i = 0

  const regexAllowed = () => {
    const last = tokens[tokens.length - 1]
    if (!last) return true
    if (last.type === 'punct') return last.value !== ')' && last.value !== ']'
    if (last.type === 'name') return KEYWORDS_BEFORE_REGEX.has(last.value)
    return false
  }

  /** 템플릿 글자를 읽는다. '${'를 만나면 true(코드로 돌아감), 닫는 '`'를 만나면 false */
  function readTemplate() {
    while (i < n) {
      const ch = src[i]
      if (ch === '\\') {
        i += 2
      } else if (ch === '`') {
        i++
        return false
      } else if (ch === '$' && src[i + 1] === '{') {
        i += 2
        braces.push('tpl')
        return true
      } else {
        i++
      }
    }
    return false
  }

  while (i < n) {
    const ch = src[i]
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v' || ch === ' ' || ch === '﻿' || ch === ' ' || ch === ' ') {
      i++
      continue
    }
    if (ch === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n' && src[i] !== '\r') i++
      continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      i = end === -1 ? n : end + 2
      continue
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1
      let value = ''
      while (j < n && src[j] !== ch) {
        if (src[j] === '\\') {
          value += src.slice(j, j + 2)
          j += 2
        } else {
          value += src[j]
          j++
        }
      }
      tokens.push({ type: 'string', value })
      i = j + 1
      continue
    }
    if (ch === '`') {
      i++
      tokens.push({ type: 'template', value: '' })
      readTemplate()
      continue
    }
    if (ch === '{') {
      braces.push('brace')
      tokens.push({ type: 'punct', value: ch })
      i++
      continue
    }
    if (ch === '}') {
      const kind = braces.pop()
      i++
      if (kind === 'tpl') {
        // 템플릿 안의 식이 끝났다 — 남은 템플릿 글자를 읽는다(값 하나로 본다)
        readTemplate()
        continue
      }
      tokens.push({ type: 'punct', value: ch })
      continue
    }
    if (ch === '/' && regexAllowed()) {
      let j = i + 1
      let inClass = false
      let ok = false
      while (j < n) {
        const c = src[j]
        if (c === '\n' || c === '\r') break
        if (c === '\\') {
          j += 2
          continue
        }
        if (c === '[') inClass = true
        else if (c === ']') inClass = false
        else if (c === '/' && !inClass) {
          ok = true
          break
        }
        j++
      }
      if (ok) {
        j++
        while (j < n && NAME_CHAR.test(src[j])) j++
        tokens.push({ type: 'regex', value: src.slice(i, j) })
        i = j
        continue
      }
    }
    if (NAME_CHAR.test(ch)) {
      let j = i + 1
      while (j < n && NAME_CHAR.test(src[j])) j++
      tokens.push({ type: 'name', value: src.slice(i, j) })
      i = j
      continue
    }
    tokens.push({ type: 'punct', value: ch })
    i++
  }
  return tokens
}

const isPunct = (token, value) => token?.type === 'punct' && token.value === value
const isName = (token, value) => token?.type === 'name' && token.value === value

/**
 * @param {string} source
 * @returns {{ static: string[], dynamic: string[], dynamicNonLiteral: number }}
 *   static: import/export … from '…', import '…' / dynamic: import('…') / dynamicNonLiteral: 문자열이 아닌 import(식)의 개수
 */
export function scanModuleSpecifiers(source) {
  const tokens = tokenize(source)
  const found = { static: [], dynamic: [], dynamicNonLiteral: 0 }
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (!isName(t, 'import') && !isName(t, 'export')) continue
    const prev = tokens[i - 1]
    const next = tokens[i + 1]
    // obj.import, { import: … } 같은 속성 이름은 건너뛴다
    if (isPunct(prev, '.') || isPunct(next, ':')) continue

    if (t.value === 'import') {
      if (isPunct(next, '.')) continue // import.meta
      if (isPunct(next, '(')) {
        const arg = tokens[i + 2]
        const after = tokens[i + 3]
        if (arg?.type === 'string' && (isPunct(after, ')') || isPunct(after, ','))) found.dynamic.push(arg.value)
        else found.dynamicNonLiteral++
        continue
      }
      if (next?.type === 'string') {
        found.static.push(next.value)
        continue
      }
      // import 기본값, { 이름 }, * as 이름 … from '…'
      for (let j = i + 1; j < tokens.length && j < i + 400; j++) {
        const u = tokens[j]
        if (isPunct(u, ';') || isName(u, 'import') || isName(u, 'export')) break
        if (isName(u, 'from') && tokens[j + 1]?.type === 'string') {
          found.static.push(tokens[j + 1].value)
          break
        }
      }
      continue
    }

    // export * from '…' / export * as 이름 from '…' / export { … } from '…'
    let j = i + 1
    if (isPunct(tokens[j], '*')) {
      j++
      if (isName(tokens[j], 'as')) j += 2
    } else if (isPunct(tokens[j], '{')) {
      while (j < tokens.length && !isPunct(tokens[j], '}')) j++
      j++
    } else {
      continue // export const / function / default … 는 from이 없다
    }
    if (isName(tokens[j], 'from') && tokens[j + 1]?.type === 'string') found.static.push(tokens[j + 1].value)
  }
  return found
}
