// 공유 이미지(1080×1350)를 캔버스에 그린다. 이미지 안에 ‘AI 생성’ 표시를 항상 넣는다.
// 밈 원문이나 영상 장면은 싣지 않고, 만든 유행어와 예문만 담는다.

const W = 1080
const H = 1350
const PAD = 84
const NAVY = '#1b2150'
const YELLOW = '#ffe14a'
const PINK = '#ff5c9d'

const DISPLAY = '"Black Han Sans", "Pretendard Variable", Pretendard, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif'
const BODY = '"Pretendard Variable", Pretendard, "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", sans-serif'

/** 글꼴이 아직 안 받아졌으면 잠깐 기다린다(끝내 안 되면 시스템 글꼴로 그린다). */
async function ensureFonts(text) {
  if (!document.fonts?.load) return
  const wait = Promise.all([document.fonts.load(`400 120px "Black Han Sans"`, text), document.fonts.load(`600 40px "Pretendard Variable"`, text)])
  await Promise.race([wait.catch(() => {}), new Promise((r) => setTimeout(r, 1800))])
}

/** 낱말 단위로 줄을 나누되, 한 낱말이 너무 길면 글자 단위로 자른다. */
function wrapLines(ctx, text, maxWidth) {
  const lines = []
  for (const paragraph of String(text).split('\n')) {
    let line = ''
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word
      if (ctx.measureText(candidate).width <= maxWidth) {
        line = candidate
        continue
      }
      if (line) lines.push(line)
      if (ctx.measureText(word).width <= maxWidth) {
        line = word
        continue
      }
      let chunk = ''
      for (const ch of Array.from(word)) {
        if (ctx.measureText(chunk + ch).width > maxWidth && chunk) {
          lines.push(chunk)
          chunk = ch
        } else {
          chunk += ch
        }
      }
      line = chunk
    }
    if (line) lines.push(line)
  }
  return lines
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function pill(ctx, text, x, y, { bg, fg, font, padX = 26, height = 64, align = 'left' }) {
  ctx.font = font
  const width = ctx.measureText(text).width + padX * 2
  const left = align === 'right' ? x - width : x
  ctx.fillStyle = bg
  roundRect(ctx, left, y, width, height, height / 2)
  ctx.fill()
  ctx.fillStyle = fg
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.fillText(text, left + padX, y + height / 2 + 2)
  return width
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{ text: string, example?: string, trendKeyword?: string, serviceName: string, mark: string }} data
 */
export async function drawShareCard(canvas, { text, example = '', trendKeyword = '', serviceName, mark }) {
  await ensureFonts(`${text}${example}${serviceName}${mark}${trendKeyword}`)
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')

  // 바탕
  ctx.fillStyle = NAVY
  ctx.fillRect(0, 0, W, H)
  ctx.fillStyle = '#363d6b'
  ctx.beginPath()
  ctx.arc(W - 90, 80, 300, 0, Math.PI * 2)
  ctx.fill()
  ctx.globalAlpha = 0.22
  ctx.fillStyle = PINK
  ctx.beginPath()
  ctx.arc(W - 220, H + 40, 260, 0, Math.PI * 2)
  ctx.fill()
  ctx.globalAlpha = 1

  // 머리말
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.fillStyle = '#9ea3c4'
  ctx.font = `600 34px ${BODY}`
  ctx.fillText('내 말투 × 떠오르는 밈', PAD, PAD)

  // 유행어: 칸에 맞게 글자 크기를 줄여 가며 넣는다
  const maxWidth = W - PAD * 2
  let size = 156
  let lines = []
  for (; size >= 68; size -= 8) {
    ctx.font = `400 ${size}px ${DISPLAY}`
    lines = wrapLines(ctx, text, maxWidth)
    if (lines.length <= 4) break
  }
  const lineHeight = Math.round(size * 1.18)
  const blockHeight = lines.length * lineHeight
  const exampleRoom = example ? 260 : 0
  let y = Math.max(PAD + 110, Math.round((H - 250 - exampleRoom - blockHeight) / 2) + 40)
  ctx.fillStyle = '#ffffff'
  ctx.textBaseline = 'top'
  for (const line of lines) {
    ctx.fillText(line, PAD, y)
    y += lineHeight
  }

  // 밈 이름
  y += 28
  if (trendKeyword) {
    pill(ctx, `밈 · ${trendKeyword}`, PAD, y, { bg: 'rgba(255,255,255,0.12)', fg: YELLOW, font: `700 34px ${BODY}`, height: 60 })
    y += 60 + 44
  }

  // 예문
  if (example) {
    ctx.font = `500 40px ${BODY}`
    const exLines = wrapLines(ctx, example, maxWidth - 40).slice(0, 3)
    const exHeight = exLines.length * 58
    if (y + exHeight < H - 200) {
      ctx.fillStyle = PINK
      roundRect(ctx, PAD, y + 4, 8, exHeight - 8, 4)
      ctx.fill()
      ctx.fillStyle = '#dfe2f3'
      ctx.textBaseline = 'top'
      let ey = y
      for (const line of exLines) {
        ctx.fillText(line, PAD + 36, ey)
        ey += 58
      }
    }
  }

  // 바닥: 서비스명과 AI 생성 표시(지울 수 없는 가시 표시)
  const footY = H - PAD - 64
  ctx.fillStyle = '#ffffff'
  ctx.font = `400 46px ${DISPLAY}`
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  ctx.fillText(serviceName, PAD, footY + 34)
  pill(ctx, mark, W - PAD, footY, { bg: YELLOW, fg: NAVY, font: `800 36px ${BODY}`, height: 64, align: 'right' })
  return canvas
}

/** @returns {Promise<Blob|null>} */
export function canvasToBlob(canvas) {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), 'image/png')
    } catch {
      resolve(null)
    }
  })
}
