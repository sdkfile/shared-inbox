import { describe, expect, it } from 'vitest'
import { checkClaims, COMMON_RULES } from '../src/core/claimCheck.js'
import {
  isSelfAddressed,
  needsCloserLook,
  AUTONOMOUS_ACTIONS,
  REQUIRES_APPROVAL,
  type Decision,
} from '../src/core/boundary.js'

describe('URL 변조 검출 — 사람 눈으로 못 잡는 것', () => {
  const CANON = 'https://drive.google.com/file/d/1m9cKabGpqRVsARu2RcmlGs26PNTmf8DO/view'
  const urls = [{ domain: 'drive.google.com', canonical: CANON }]

  it('정본과 같으면 통과', () => {
    expect(checkClaims(`자료입니다: ${CANON}`, { urls })).toHaveLength(0)
  })

  it('한 글자 다르면 잡는다', () => {
    // 실제 사고: RVsARu -> RRVsARu. R 이 하나 늘었다.
    const typo = CANON.replace('GpqRVsARu', 'GpqRRVsARu')
    const w = checkClaims(`자료입니다: ${typo}`, { urls })
    expect(w).toHaveLength(1)
    expect(w[0]?.reason).toContain('정본')
  })

  it('문장 끝 부호는 링크에서 뗀다', () => {
    expect(checkClaims(`자료입니다(${CANON}).`, { urls })).toHaveLength(0)
  })

  it('여러 링크를 각각 검사한다', () => {
    const bad = CANON.replace('1m9', '1M9')
    expect(checkClaims(`${CANON} 그리고 ${bad}`, { urls })).toHaveLength(1)
  })

  it('다른 도메인은 건드리지 않는다', () => {
    expect(checkClaims('https://example.com/anything', { urls })).toHaveLength(0)
  })
})

describe('없는 것을 있다고 말하는 초안', () => {
  const rules = [
    ...COMMON_RULES,
    { pattern: /표준\s*계약서[^.\n]{0,12}(있|보유|드릴)/, reason: '계약서 양식이 없습니다' },
  ]

  it('단정하면 잡는다', () => {
    const w = checkClaims('표준 계약서 양식이 있으니 보내드리겠습니다.', { rules })
    expect(w).toHaveLength(1)
    expect(w[0]?.reason).toBe('계약서 양식이 없습니다')
  })

  it('유보 표현이 같은 줄에 있으면 넘어간다', () => {
    // "확인 후 안내" 는 정직한 답이다. 오탐이 잦으면 사람이 경고를 무시한다.
    const w = checkClaims('표준 계약서 양식이 있는지 확인 후 안내드리겠습니다.', { rules })
    expect(w).toHaveLength(0)
  })

  it('문제가 된 문장을 그대로 보여준다', () => {
    // 어디를 고쳐야 하는지 알아야 고칠 수 있다.
    const w = checkClaims('안녕하세요.\n표준 계약서 양식이 있습니다.\n감사합니다.', { rules })
    expect(w[0]?.quote).toBe('표준 계약서 양식이 있습니다.')
  })

  it('첨부했다는 주장을 잡는다', () => {
    // 초안 단계에서는 첨부를 붙일 수 없다.
    expect(checkClaims('파일을 첨부해 드렸습니다.').length).toBeGreaterThan(0)
  })

  it('사람이 확인했다는 주장을 잡는다', () => {
    expect(checkClaims('담당자가 확인했습니다.').length).toBeGreaterThan(0)
  })

  it('깨끗한 본문은 통과', () => {
    expect(checkClaims('문의 감사합니다. 검토 후 회신드리겠습니다.')).toHaveLength(0)
  })
})

describe('사람과 AI 의 경계', () => {
  it('자율 행동에 발송이 없다', () => {
    // 이 목록에 send 가 들어가면 이 리포의 전제가 무너진다.
    expect(AUTONOMOUS_ACTIONS).not.toContain('send')
  })

  it('발송·읽음표시·라벨은 승인 대상이다', () => {
    // 읽음 표시와 라벨 변경도 위험하다 — 사람이 못 보게 되거나 분류가 덮인다.
    expect(REQUIRES_APPROVAL).toContain('send')
    expect(REQUIRES_APPROVAL).toContain('mark_read')
    expect(REQUIRES_APPROVAL).toContain('label')
  })

  it('두 목록이 겹치지 않는다', () => {
    const overlap = AUTONOMOUS_ACTIONS.filter((a) => (REQUIRES_APPROVAL as readonly string[]).includes(a))
    expect(overlap).toEqual([])
  })
})

describe('확신도를 통과 기준으로 쓰지 않는다', () => {
  const decision = (over: Partial<Decision>): Decision => ({
    disposition: 'ROUTINE',
    reasoning: '자동 영수증',
    confidence: 0.95,
    ...over,
  })

  it('확신도가 높아도 NEEDS_HUMAN 이면 사람이 본다', () => {
    // gpt-4.1 이 confidence 0.99 로 상호를 틀리게 읽은 실측 사례가 있다.
    expect(needsCloserLook(decision({ disposition: 'NEEDS_HUMAN', confidence: 0.99 }))).toBe(true)
  })

  it('확신도가 낮으면 분류와 무관하게 사람이 본다', () => {
    expect(needsCloserLook(decision({ confidence: 0.4 }))).toBe(true)
  })

  it('정형 메일이고 확신도가 높으면 넘어간다', () => {
    expect(needsCloserLook(decision({}))).toBe(false)
  })
})

describe('자기 메일 차단 — 무한 루프 방어', () => {
  const own = ['support@example.com', 'billing@example.com']

  it('자기 주소에서 온 메일을 막는다', () => {
    expect(isSelfAddressed('support@example.com', own)).toBe(true)
  })

  it('대소문자가 달라도 막는다', () => {
    expect(isSelfAddressed('Support@Example.COM', own)).toBe(true)
  })

  it('외부 주소는 통과', () => {
    expect(isSelfAddressed('client@corp.co.kr', own)).toBe(false)
  })

  it('발신자가 없으면 통과', () => {
    expect(isSelfAddressed(null, own)).toBe(false)
  })
})
