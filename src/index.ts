/**
 * shared-inbox
 *
 * 사람과 AI 가 같은 메일함을 나눠 읽는다.
 *
 * 전제: **AI 는 메일함 상태를 바꾸지 않는다.** 읽음 표시도, 라벨도, 발송도
 * 하지 않는다. 사람의 워크플로는 자동화가 없을 때와 똑같이 돌아가고, AI 는
 * 그 옆에 분류·초안·근거를 붙여둔다.
 *
 * 그래서 이 패키지에는 메일을 보내는 함수가 없다. 만들지 않은 것이지
 * 빠뜨린 게 아니다.
 */

// 경계 — 무엇을 AI 가 하고 무엇을 사람이 하는가
export * from './core/boundary.js'

// 초안 사실 검사 — LLM 이 없는 것을 있다고 말하는지
export * from './core/claimCheck.js'

// Resend 수신
export * from './resend/parseEmail.js'
export * from './resend/verifySignature.js'
export * from './resend/fetchDetail.js'
export * from './resend/attachments.js'
