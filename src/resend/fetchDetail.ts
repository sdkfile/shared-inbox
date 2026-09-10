/**
 * Resend 수신 메일 상세 조회.
 *
 * 웹훅 페이로드에는 메타데이터만 온다 — 본문, 헤더, 첨부는 빠져 있다.
 * (문서: "Webhooks do not include the email body, headers, or attachments,
 * only their metadata." 대용량 첨부를 서버리스에서 다루기 위한 설계다.)
 *
 * 그래서 전달 여부 판단에 필요한 delivered-to 헤더도 웹훅만으로는 알 수 없고,
 * 이 API 를 한 번 더 호출해야 한다.
 */

const API = 'https://api.resend.com'

export interface ReceivedEmailDetail {
  headers: Record<string, unknown> | Array<{ name?: unknown; value?: unknown }> | null
  text: string | null
  html: string | null
  attachments: unknown[]
  messageId: string | null
}

function apiKey(): string | undefined {
  // 수신 조회는 full-access 키가 필요하다. 발신 전용 키는 401 restricted_api_key.
  return process.env.RESEND_FULL_API_KEY ?? process.env.RESEND_API_KEY
}

/**
 * 수신 메일 상세를 가져온다.
 *
 * 실패해도 예외를 던지지 않는다. 웹훅은 메타데이터만으로도 행을 저장해야 하고,
 * 본문을 못 가져왔다고 500 을 돌려주면 Resend 가 같은 이벤트를 재전송한다.
 * 재전송돼도 unique 제약에 막혀 본문이 채워지지 않으므로 이득이 없다.
 * 못 가져온 건은 나중에 백필한다.
 */
export async function fetchReceivedEmail(
  emailId: string,
  options: { timeoutMs?: number } = {},
): Promise<ReceivedEmailDetail | null> {
  const key = apiKey()
  if (!key) {
    console.warn('[inbound] RESEND_FULL_API_KEY 가 없어 본문을 가져오지 못했습니다.')
    return null
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8_000)

  try {
    const res = await fetch(`${API}/emails/receiving/${emailId}`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
    })

    if (!res.ok) {
      console.warn(`[inbound] 상세 조회 실패 (HTTP ${res.status}) id=${emailId}`)
      return null
    }

    const body = (await res.json()) as Record<string, unknown>
    return {
      headers: (body.headers ?? null) as ReceivedEmailDetail['headers'],
      text: typeof body.text === 'string' ? body.text : null,
      html: typeof body.html === 'string' ? body.html : null,
      attachments: Array.isArray(body.attachments) ? body.attachments : [],
      messageId: typeof body.message_id === 'string' ? body.message_id : null,
    }
  } catch (error) {
    console.warn(`[inbound] 상세 조회 예외 id=${emailId}:`, error)
    return null
  } finally {
    clearTimeout(timer)
  }
}
