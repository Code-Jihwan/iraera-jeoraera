// 예시 트렌드의 문형 틀 문법:
//   {X} 빈칸 · {X|은/는} 빈칸 + 받침에 맞는 조사 · {X1} 빈칸 말의 첫 글자 · {form} 완성형이 들어갈 자리
import { attach } from '../../shared/hangul.js'

const TOKEN = /\{(X1|X|form)(?:\|([^{}|]*))?\}/g
const SLOT_TOKEN = /\{X1?(?:\|[^{}|]*)?\}/

const VALUES = {
  X: ({ X }) => X,
  X1: ({ X }) => Array.from(X)[0] ?? '',
  form: ({ form }) => form,
}

const asText = (value) => (value == null ? '' : String(value).trim())

/** 틀이 빈칸({X}, {X|…}, {X1})을 쓰는지 */
export function usesSlot(template) {
  return typeof template === 'string' && SLOT_TOKEN.test(template)
}

/**
 * 틀을 채운다. 모르는 토큰은 그대로 둔다.
 * 빈칸이 있는 틀인데 넣을 말이 없으면 만들 수 없으므로 빈 문자열을 돌려준다.
 * @param {string} template
 * @param {{ X?: string, form?: string }} [values]
 * @returns {string}
 */
export function fillTemplate(template, values) {
  if (typeof template !== 'string') return ''
  const filled = { X: asText(values?.X), form: asText(values?.form) }
  if (!filled.X && usesSlot(template)) return ''
  return template
    .replace(TOKEN, (_, name, pair) => {
      const value = VALUES[name](filled)
      return pair === undefined ? value : attach(value, pair)
    })
    .replace(/\s{2,}/g, ' ')
    .trim()
}
