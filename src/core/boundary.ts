/**
 * 사람과 AI 가 같은 메일함을 나눠 읽을 때의 분담 규칙.
 *
 * 자동화를 붙일 때 가장 흔한 실수는 AI 가 메일을 "처리해버리는" 것이다.
 * 읽음 표시를 하고, 라벨을 옮기고, 답장을 보내고 나면 사람이 볼 게 없다.
 * 그러면 사람은 자동화를 못 믿게 되고, 결국 둘 다 전부 읽게 된다.
 *
 * 여기서는 반대로 간다. **AI 는 메일함 상태를 바꾸지 않는다.**
 * 사람의 워크플로는 자동화가 없을 때와 똑같이 돌아가고, AI 는 그 옆에서
 * 초안과 판단 근거를 만들어 붙인다. 최종 행동은 사람이 한다.
 *
 *   사람  읽고, 판단하고, 보낸다        (원래 하던 대로)
 *   AI    분류하고, 초안 쓰고, 근거를 댄다  (옆에 붙여둔다)
 *
 * 이 파일은 그 경계를 타입으로 만든다. `Decision` 이 `AUTO_REPLY` 를 가질 수
 * 없는 이유는, 그 값을 만들 수 있으면 언젠가 누가 쓰기 때문이다.
 */

/** 메일 한 통에 대해 AI 가 내릴 수 있는 결론. */
export type Disposition =
  /** 사람이 봐야 한다. 초안을 준비해 옆에 붙인다. */
  | 'NEEDS_HUMAN'
  /** 자동으로 처리 가능한 정형 메일(영수증, 알림 등). 초안 없이 기록만. */
  | 'ROUTINE'
  /** 스팸·홍보. 사람에게 알리지 않는다. */
  | 'IGNORE'

/**
 * AI 의 판단 결과.
 *
 * 주목할 것: **보내기(send) 가 없다.** 이 타입으로 표현할 수 있는 최대치는
 * "초안을 만들어 두었다" 까지다.
 */
export interface Decision {
  disposition: Disposition
  /** 왜 이렇게 판단했는지. 사람이 읽고 뒤집을 수 있어야 한다. */
  reasoning: string
  /** 0~1. 통과 기준으로 쓰지 마라 — 아래 주석 참고. */
  confidence: number
  /** NEEDS_HUMAN 일 때 준비한 답장 초안. 보내지는 않는다. */
  draft?: {
    subject: string
    body: string
    /** 초안이 근거로 삼은 사실. 지어낸 값이 섞이면 여기서 걸러진다. */
    citedFacts: string[]
  }
}

/**
 * 승인 없이 나갈 수 있는 것.
 *
 * 이 목록에 없는 행동은 전부 사람 승인을 거친다. 목록을 늘릴 때는
 * "잘못 나가면 되돌릴 수 있는가"를 먼저 물어라. 메일 발송은 되돌릴 수 없다.
 */
export const AUTONOMOUS_ACTIONS = [
  'classify', // 분류
  'draft', // 초안 작성
  'extract', // 첨부에서 정보 추출
  'notify', // 사람에게 알림
] as const

export type AutonomousAction = (typeof AUTONOMOUS_ACTIONS)[number]

/**
 * 사람 승인이 필요한 것.
 *
 * 런타임에서 이 목록을 검사해 막는 게 아니라, 코드를 읽는 사람에게
 * 경계를 보여주기 위한 것이다. 실제 방어는 "발송 함수를 만들지 않는 것"이다.
 */
export const REQUIRES_APPROVAL = [
  'send', // 메일 발송
  'archive', // 보관 처리
  'mark_read', // 읽음 표시 — 사람이 못 보게 된다
  'label', // 라벨 변경 — 사람의 분류를 덮어쓴다
  'delete',
] as const

/**
 * 확신도를 자동 통과 기준으로 쓰지 않는다.
 *
 * 실측 사례: 사업자등록증에서 상호를 읽을 때 gpt-4.1 이 confidence 0.99 로
 * "별오디스튜디오" 를 반환했다. 정답은 "널포인터스튜디오" 였다. 모델은 자기가
 * 틀렸다는 걸 모르고, 확신도는 정확도와 무관하게 높게 나온다.
 *
 * 확신도는 사람에게 "이건 좀 더 봐주세요" 라고 말하는 용도로만 쓴다.
 */
export function needsCloserLook(decision: Decision): boolean {
  return decision.confidence < 0.7 || decision.disposition === 'NEEDS_HUMAN'
}

/**
 * 자기 자신에게 보내는 메일을 막는다.
 *
 * 자동화가 자기가 보낸 메일에 반응하면 무한 루프가 된다. 실제로 겪은 사고라
 * 기본 방어로 넣었다. 운영 주소를 전부 넣어라 — 별칭까지.
 */
export function isSelfAddressed(
  fromAddress: string | null,
  ownAddresses: readonly string[],
): boolean {
  if (!fromAddress) return false
  const from = fromAddress.toLowerCase()
  return ownAddresses.some((own) => own.toLowerCase() === from)
}
