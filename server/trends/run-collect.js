// CLI: `npm run collect` — 실제 설정으로 트렌드 수집을 한 번 돌리고 결과 보고서를 JSON으로 출력한다.
// 서버와 같은 조립(server/main.js)을 그대로 써서 같은 저장 파일과 할당량·해시태그 장부를 본다.
// 서버가 떠 있는 동안에는 운영 화면의 "지금 수집하기"를 쓰는 편이 낫다: 서버는 트렌드 목록을 메모리에 들고 있어서,
// 이 CLI가 따로 저장한 내용은 서버를 다시 띄우거나 서버가 다음 수집을 돌 때에야 반영된다.
import { buildServer } from '../main.js'
import { flushWrites } from '../store.js'

// 표준 출력에는 보고서(JSON)만 나가도록 로그는 모두 표준 오류로 보낸다
const log = { log: console.error, info: console.error, warn: console.error, error: console.error }

let report
try {
  const { pipeline, llm } = await buildServer({ log })
  // AI 추출을 쓸 수 있는 설정이면 쓰도록, LLM 준비(SDK 불러오기)가 끝난 뒤에 수집을 시작한다
  await llm.ready?.()
  report = await pipeline.runOnce({ trigger: 'cli' })
  await flushWrites()
} catch (err) {
  console.error('수집을 시작하지 못했습니다:', err)
  process.exit(1)
}

console.log(JSON.stringify(report, null, 2))
process.exitCode = report.ok ? 0 : 1
