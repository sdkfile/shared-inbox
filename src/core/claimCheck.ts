/**
 * 초안이 없는 것을 있다고 말하는지 검사한다.
 *
 * LLM 은 그럴듯한 문장을 만들도록 훈련돼 있지, 사실을 말하도록 훈련되지
 * 않았다. 실제로 겪은 것들:
 *
 *   "표준 계약서 양식이 있으며 보내드리겠습니다"   → 그런 양식이 없었다
 *   "견적서에 별도 항목으로 안내드렸습니다"        → 그런 항목이 없었다
 *   "https://drive.google.com/file/d/1m9cKabGpqRRVsARu..."
 *                                                  → 정본은 RVsARu. R 이 하나 늘었다
 *
 * 앞의 둘은 상대가 확인하면 바로 드러나는 거짓이고, 마지막은 사람 눈으로
 * 절대 못 잡는다. 프롬프트로 "거짓말하지 마" 라고 쓰는 건 확률이지만,
 * 이건 정규식으로 잡을 수 있는 사실관계다.
 *
 * 발송을 막지는 않는다 — 오탐이 있을 수 있고, 사람이 승인 화면에서 보고
 * 고치면 된다. 막아버리면 정상 답신까지 손으로 보내게 되고, 그러면 자동화를
 * 끄게 된다.
 */

/** 승인 화면에 띄울 경고. */
export interface ClaimWarning {
  /** 문제가 된 문장. 어디를 고쳐야 하는지 알아야 한다. */
  quote: string
  /** 왜 문제인지. 사람이 읽고 판단한다. */
  reason: string
}

/** "우리에게 없는 것"을 있다고 말하는 패턴. */
export interface ClaimRule {
  pattern: RegExp
  reason: string
}

/**
 * 정확해야 하는 URL.
 *
 * 본문에 `domain` 이 들어간 링크가 있는데 `canonical` 과 다르면 잡는다.
 */
export interface UrlRule {
  /** 검사 대상 도메인 조각. 예: 'drive.google.com' */
  domain: string
  /** 정본 URL. */
  canonical: string
  reason?: string
}

export interface ClaimCheckConfig {
  rules?: ClaimRule[]
  urls?: UrlRule[]
  /**
   * 유보 표현. 같은 줄에 있으면 단정한 게 아니므로 넘어간다.
   *
   * "확인 후 안내드리겠습니다" 는 정직한 답이다. 이걸 잡으면 오탐이 되고,
   * 오탐이 잦으면 사람이 경고 자체를 무시하게 된다 — 그게 제일 나쁘다.
   */
  hedgePattern?: RegExp
}

const DEFAULT_HEDGE =
  /(확인|검토|파악)\s*후\s*(안내|회신|답변|말씀)|보유\s*여부|여쭤보고|알아보고|확인해\s*보고/

/**
 * 어느 팀에나 해당하는 기본 규칙.
 *
 * 도메인 특화 규칙(우리 회사에 계약서 양식이 있는가)은 설정으로 넘겨라.
 */
export const COMMON_RULES: ClaimRule[] = [
  {
    pattern: /(첨부|첨부파일)(해\s*드렸|되어\s*있|하였|했)/,
    reason: '첨부가 실제로 있는지 확인하세요 — 초안에는 첨부를 붙일 수 없습니다',
  },
  {
    pattern: /(이전|지난|앞서)\s*(메일|안내|말씀)[^.\n]{0,15}(드린\s*대로|드렸듯)/,
    reason: '이전에 실제로 그렇게 안내했는지 확인하세요',
  },
  {
    pattern: /(담당자|팀)[^.\n]{0,10}(확인했|검토했|승인했)/,
    reason: '사람이 실제로 확인했는지 알 수 없습니다',
  },
]

function findLine(body: string, at: number): string {
  const start = Math.max(0, body.lastIndexOf('\n', at) + 1)
  const mark = body.indexOf('\n', at)
  const end = mark === -1 ? body.length : mark
  return body.slice(start, end)
}

function checkUrls(body: string, urls: UrlRule[]): ClaimWarning[] {
  const out: ClaimWarning[] = []

  for (const rule of urls) {
    // 해당 도메인이 들어간 링크를 전부 찾는다.
    const escaped = rule.domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`https?://\\S*${escaped}\\S*`, 'g')

    for (const link of body.match(re) ?? []) {
      // 문장 끝에 붙은 부호를 떼고 비교한다.
      const clean = link.replace(/[).,;:'"]+$/, '')
      if (clean !== rule.canonical) {
        out.push({
          quote: clean,
          reason: rule.reason ?? `링크가 정본과 다릅니다 (정본: ${rule.canonical})`,
        })
      }
    }
  }

  return out
}

/**
 * 본문에서 근거 없는 주장을 찾는다.
 *
 * @example
 * const warnings = checkClaims(draft.body, {
 *   rules: [
 *     ...COMMON_RULES,
 *     { pattern: /표준\s*계약서[^.\n]{0,12}있/, reason: '계약서 양식이 없습니다' },
 *   ],
 *   urls: [{ domain: 'drive.google.com', canonical: MEDIA_KIT_URL }],
 * })
 */
export function checkClaims(body: string, config: ClaimCheckConfig = {}): ClaimWarning[] {
  const rules = config.rules ?? COMMON_RULES
  const hedge = config.hedgePattern ?? DEFAULT_HEDGE

  const out: ClaimWarning[] = [...checkUrls(body, config.urls ?? [])]

  for (const rule of rules) {
    const m = body.match(rule.pattern)
    if (!m) continue

    const at = body.indexOf(m[0])
    // 같은 줄에 유보 표현이 있으면 단정한 게 아니다.
    if (hedge.test(findLine(body, at))) continue

    out.push({
      quote: findLine(body, at).trim().slice(0, 120),
      reason: rule.reason,
    })
  }

  return out
}
