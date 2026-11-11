// 서버 조립: 설정 → 저장소 → 엔진 → 라우트. server.js와 테스트가 함께 쓴다.
import path from 'node:path'
import { loadConfig } from './config.js'
import { createApp } from './http.js'
import { registerRoutes } from './api.js'
import { createEventLog } from './events.js'
import { flushWrites } from './store.js'
import { createTrendStore } from './trends/trend-store.js'
import { createQuotaLedger } from './trends/quota.js'
import { createYouTubeClient } from './trends/youtube.js'
import { createInstagramClient } from './trends/instagram.js'
import { createTrendPipeline } from './trends/pipeline.js'
import * as safety from './safety/filter.js'
import { createLlm } from './generate/llm.js'
import { createGenerator } from './generate/engine.js'

/**
 * @param {{ env?: NodeJS.ProcessEnv, loadDotEnv?: boolean, log?: any, fetchImpl?: typeof fetch }} [opts]
 */
export async function buildServer({ env = process.env, loadDotEnv = true, log = console, fetchImpl = fetch } = {}) {
  const config = loadConfig(env, { loadDotEnv })

  const trendStore = createTrendStore({ dataDir: config.dataDir, seedPath: config.seedTrendsPath, ttlDays: config.trends.ttlDays })
  await trendStore.init()

  const llm = createLlm({ config, log })
  // SDK를 불러오는 동안에는 available()이 false라, 첫 요청부터 올바른 엔진 상태를 보이도록 기다린다
  await llm.ready?.()

  let youtube = null
  if (config.youtube.enabled) {
    const ledger = createQuotaLedger({ file: path.join(config.dataDir, 'youtube-quota.json'), dailyBudget: config.youtube.dailyUnitBudget })
    await ledger.load()
    youtube = createYouTubeClient({ apiKey: config.youtube.apiKey, fetchImpl, ledger })
  }

  const instagram = config.instagram.enabled
    ? createInstagramClient({
        accessToken: config.instagram.accessToken,
        userId: config.instagram.userId,
        apiVersion: config.instagram.apiVersion,
        fetchImpl,
        ledgerFile: path.join(config.dataDir, 'instagram-hashtags.json'),
      })
    : null

  const pipeline = createTrendPipeline({ config, store: trendStore, youtube, instagram, llm, safety, log })
  const generator = createGenerator({ config, llm, safety, trendStore, log })
  const events = createEventLog({ dataDir: config.dataDir, retention: config.retention })

  const app = createApp({ config, log })
  registerRoutes(app, { config, trendStore, pipeline, generator, llm, events, instagram, log })

  // 정적 파일: 화면, 브라우저와 함께 쓰는 모듈, 글꼴
  app.static('/shared/', config.sharedDir, { extensions: ['.js'] })
  app.static('/vendor/pretendard/', path.join(config.root, 'node_modules', 'pretendard', 'dist', 'web', 'variable'), {
    extensions: ['.css', '.woff2'],
    immutable: true,
  })
  app.static('/vendor/black-han-sans/', path.join(config.root, 'node_modules', '@fontsource', 'black-han-sans'), {
    extensions: ['.css', '.woff2', '.woff'],
    immutable: true,
  })
  app.static('/', config.publicDir)

  // 보관 기간이 지난 기록과 트렌드를 지운다. 수집을 끄거나 수집이 실패해도 지우기는 따로 돈다.
  let housekeeping = null
  async function sweep() {
    try {
      const removed = await events.purge()
      const trendsRemoved = await trendStore.purgeExpired()
      if (removed.events || removed.reports || trendsRemoved) log.info(`[housekeeping] 보관 기간이 지난 기록 정리 · 반응 ${removed.events} · 신고 ${removed.reports} · 트렌드 ${trendsRemoved}`)
    } catch (err) {
      log.warn('[housekeeping] 정리 실패:', err.message)
    }
  }

  return {
    app,
    config,
    llm,
    pipeline,
    trendStore,
    events,
    sweep,
    async start() {
      const address = await app.listen(config.port, config.host)
      pipeline.start()
      await sweep()
      housekeeping = setInterval(sweep, 60 * 60 * 1000)
      housekeeping.unref?.()
      return address
    },
    async stop() {
      if (housekeeping) clearInterval(housekeeping)
      pipeline.stop()
      await app.close()
      await flushWrites()
    },
  }
}
