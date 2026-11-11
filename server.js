// 실행: node server.js  (또는 npm start)
import { buildServer } from './server/main.js'

const server = await buildServer()
const { config, llm } = server

let address
try {
  address = await server.start()
} catch (err) {
  if (err.code === 'EADDRINUSE') {
    console.error(`포트 ${config.port}가 이미 쓰이고 있습니다. PORT 환경변수로 다른 포트를 지정하세요. 예: PORT=3100 node server.js`)
  } else {
    console.error('서버를 시작하지 못했습니다:', err)
  }
  process.exit(1)
}

const shownHost = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host
const url = `http://${shownHost.includes(':') ? `[${shownHost}]` : shownHost}:${address.port}`

console.log('')
console.log(`  ${config.serviceName} — 내 말투 × 떠오르는 밈 = 나만의 유행어`)
console.log(`  사용자 화면   ${url}/`)
console.log(`  운영 화면     ${url}/ops.html`)
console.log('')
const llmState = llm.status()
console.log(
  `  생성 엔진     ${llm.available() ? `AI 엔진 (${config.llm.model})` : llmState.enabled ? `기본 엔진(규칙 기반) — AI 엔진을 쓸 수 없습니다: ${llmState.reason || '원인 미상'}` : '기본 엔진(규칙 기반) — ANTHROPIC_API_KEY를 넣으면 AI 엔진으로 바뀝니다'}`,
)
console.log(`  트렌드        ${config.youtube.enabled ? `YouTube 인기 차트 수집 (${config.trends.refreshMinutes}분마다, 검수 ${config.trends.reviewMode === 'manual' ? '후 노출' : '없이 자동 노출'})` : '예시 데이터 — YOUTUBE_API_KEY를 넣으면 실제 수집을 시작합니다'}`)
console.log(`  인스타그램    ${config.instagram.enabled ? '해시태그 반응 확인 켜짐 (7일 30개 한도)' : '꺼짐'}`)
console.log(`  기록 보관     반응·생성 ${config.retention.events}일 · 신고 ${config.retention.reports}일 뒤 자동 삭제`)
const exposed = (config.host !== '127.0.0.1' && config.host !== 'localhost' && config.host !== '::1') || config.allowedHosts.size > 4 || config.allowAnyHost
if (exposed) {
  console.log('')
  if (!config.adminToken) console.log('  ※ 외부에서 접속할 수 있게 설정했습니다. 운영 화면은 이 컴퓨터에서 localhost로 연 경우에만 열리며, 원격에서 쓰려면 ADMIN_TOKEN을 설정하세요.')
  console.log('  ※ 마이크(음성 녹음)는 HTTPS 또는 localhost에서만 동작합니다. 같은 컴퓨터의 HTTPS 프록시 뒤라면 TRUST_PROXY=true로 손님 주소를 구분하세요.')
}
console.log('')

let stopping = false
async function shutdown() {
  if (stopping) return
  stopping = true
  try {
    await server.stop()
  } finally {
    process.exit(0)
  }
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
