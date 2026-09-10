/**
 * 수신 메일 첨부 조회·다운로드.
 *
 * 웹훅에는 첨부가 오지 않는다. 메타데이터조차 안 올 때가 있어서 별도 API 를
 * 부른다.
 *
 * 실측한 응답 (2026-09, 문서에 명시돼 있지 않아 직접 확인했다):
 *
 *   GET /emails/{id}/attachments
 *   {
 *     "object": "list",
 *     "has_more": false,
 *     "data": [{
 *       "id": "...",
 *       "filename": "사업자등록증.pdf",
 *       "content_type": "application/pdf",     <- snake_case 다
 *       "size": 102400,
 *       "download_url": "https://...",          <- pre-signed. 헤더 없이 GET
 *       "expires_at": "..."
 *     }]
 *   }
 *
 * `download_url` 은 pre-signed 라 Authorization 헤더를 붙이면 안 된다.
 */

const API = 'https://api.resend.com'

export interface ResendAttachment {
  id: string
  filename: string
  contentType: string
  size: number
  downloadUrl: string
  expiresAt: string | null
}

function apiKey(): string | undefined {
  // 수신 조회에는 full-access 키가 필요하다.
  // 발신 전용 키를 쓰면 401 restricted_api_key 가 온다.
  return process.env.RESEND_FULL_API_KEY ?? process.env.RESEND_API_KEY
}

/**
 * 응답이 배열로 올 수도, {data: []} 로 올 수도 있다.
 *
 * 실측에서는 후자였지만 양쪽을 받아둔다 — 이런 데서 터지면 첨부가 통째로
 * 유실되고, 유실됐다는 사실조차 모른다.
 */
function unwrapList(payload: unknown): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload as Record<string, unknown>[]
  if (payload && typeof payload === 'object') {
    const data = (payload as { data?: unknown }).data
    if (Array.isArray(data)) return data as Record<string, unknown>[]
  }
  return []
}

export async function listAttachments(
  emailId: string,
  options: { timeoutMs?: number } = {},
): Promise<ResendAttachment[]> {
  const key = apiKey()
  if (!key) return []

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8_000)

  try {
    const res = await fetch(`${API}/emails/${emailId}/attachments`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
    })
    if (!res.ok) return []

    return unwrapList(await res.json())
      .map((a) => ({
        id: String(a.id ?? ''),
        filename: String(a.filename ?? ''),
        // snake_case 로 오지만 camelCase 도 받아둔다.
        contentType: String(a.content_type ?? a.contentType ?? ''),
        size: Number(a.size ?? 0),
        downloadUrl: String(a.download_url ?? a.downloadUrl ?? ''),
        expiresAt: (a.expires_at ?? a.expiresAt ?? null) as string | null,
      }))
      .filter((a) => a.id && a.downloadUrl)
  } catch {
    // 첨부를 못 가져와도 메일 처리는 계속돼야 한다.
    return []
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 첨부를 내려받는다.
 *
 * @param maxBytes 상한을 두는 이유: 서버리스 메모리 한계도 있지만, 큰 파일을
 *   LLM 에 그대로 넘기면 비용이 튄다. 넘으면 사람이 직접 보게 한다.
 */
export async function downloadAttachment(
  attachment: ResendAttachment,
  options: { maxBytes?: number; timeoutMs?: number } = {},
): Promise<Buffer | null> {
  const maxBytes = options.maxBytes ?? 12 * 1024 * 1024

  if (attachment.size > maxBytes) return null

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000)

  try {
    // pre-signed URL 이라 Authorization 을 붙이면 안 된다.
    const res = await fetch(attachment.downloadUrl, { signal: controller.signal })
    if (!res.ok) return null

    const buf = Buffer.from(await res.arrayBuffer())
    // size 를 못 믿는 경우를 대비해 실제 크기도 확인한다.
    return buf.byteLength > maxBytes ? null : buf
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 매직 바이트로 실제 형식을 확인한다.
 *
 * content_type 은 보내는 쪽이 정하는 값이라 믿을 수 없다. PDF 를
 * application/octet-stream 으로 보내는 클라이언트가 흔하다.
 */
export function sniffFileType(buf: Buffer): 'pdf' | 'png' | 'jpeg' | 'webp' | null {
  if (buf.length < 12) return null

  if (buf.subarray(0, 4).toString('latin1') === '%PDF') return 'pdf'
  if (buf[0] === 0x89 && buf.subarray(1, 4).toString('latin1') === 'PNG') return 'png'
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg'
  if (
    buf.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buf.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'webp'
  }

  return null
}
