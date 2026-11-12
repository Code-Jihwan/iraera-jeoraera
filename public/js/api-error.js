// 화면에 보여 줄 수 있는 메시지를 가진 API 오류. 서버 API와 정적 배포의 브라우저 안 백엔드가 같은 모양으로 던진다.

export class ApiError extends Error {
  constructor(message, { status = 0, code = 'error' } = {}) {
    super(message)
    this.status = status
    this.code = code
  }
}
