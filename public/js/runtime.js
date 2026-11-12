// 이 화면이 어떻게 배포됐는지 알려 준다. 'server'는 Node 서버(npm start)가 API와 함께 주는 경우다.
// 정적 배포 빌드(scripts/build-static.mjs)가 결과물 안의 이 파일을 mode 'static'(GitHub Pages)으로 덮어쓴다.
export const RUNTIME = Object.freeze({ mode: 'server' })
