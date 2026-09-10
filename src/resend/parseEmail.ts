/**
 * Resend `email.received` 페이로드 파싱.
 *
 * 전달(forwarding)을 거치면 `to` 가 신뢰할 수 없게 된다. support@example.com 로 온
 * 메일이 bot@inbound.example.com 로 전달되면서 `to` 가 후자로 바뀌기 때문이다.
 * 실측한 헤더:
 *
 *   delivered-to    : support@example.com                          <- 원 수신 주소
 *   x-forwarded-for : support@example.com bot@inbound.example.com
 *   x-forwarded-to  : bot@inbound.example.com
 *
 * 그래서 "어느 주소로 온 메일인가"는 delivered-to 로 판단한다. 나중에 billing@,
 * sales@ 를 추가해도 같은 방식으로 구분된다.
 *
 * 스레드는 references / in-reply-to 로 묶는다. 제목 정규화로 묶는 방법도 있지만
 * 제목은 사람이 바꾸고 Re:/Fwd: 접두사가 언어마다 달라 안정적이지 않다.
 */

/** 헤더는 배열로도 객체로도 올 수 있어 양쪽을 받는다. */
export type RawHeaders =
  | Array<{ name?: unknown; value?: unknown }>
  | Record<string, unknown>
  | null
  | undefined

export interface InboundAttachment {
  id?: string
  filename?: string
  contentType?: string
  size?: number
}

export interface ParsedInboundEmail {
  /** Resend 수신 메일 ID. 첨부 조회에 쓴다. */
  emailId: string
  /** RFC Message-ID. 스레드 추적의 기준. */
  messageId: string | null
  /** 이 메일이 답장하는 대상. */
  inReplyTo: string | null
  /** 스레드 전체 사슬(오래된 것부터). */
  references: string[]
  from: string
  fromAddress: string | null
  /** 전달 후 실제 도착 주소(bot@inbound...). 라우팅 판단에 쓰지 않는다. */
  to: string[]
  /** 전달 전 원 수신 주소. 없으면 to 로 폴백한다. */
  deliveredTo: string | null
  cc: string[]
  replyTo: string[]
  subject: string
  text: string | null
  html: string | null
  attachments: InboundAttachment[]
  receivedAt: Date
  /** 전달을 거쳐 들어왔는가. 로그와 디버깅용. */
  wasForwarded: boolean
}

function toArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string')
  if (typeof value === 'string' && value.trim()) return [value]
  return []
}

/** 헤더를 소문자 키 맵으로 정규화한다. 헤더 이름은 대소문자를 구분하지 않는다. */
export function normalizeHeaders(raw: RawHeaders): Map<string, string> {
  const map = new Map<string, string>()
  if (!raw) return map

  const entries: Array<[string, unknown]> = Array.isArray(raw)
    ? raw.map((h) => [String(h?.name ?? ''), h?.value])
    : Object.entries(raw)

  for (const [name, value] of entries) {
    const key = name.toLowerCase().trim()
    if (!key) continue
    // 같은 헤더가 여러 번 오면 첫 값을 쓴다(전달 체인에서 delivered-to 가
    // 여러 번 붙을 수 있는데, 가장 바깥이 우리에게 도착한 경로다).
    if (map.has(key)) continue
    map.set(key, stringifyHeaderValue(value))
  }
  return map
}

/**
 * 헤더 값이 문자열이 아닐 수 있다.
 *
 * 실측에서 return-path 가 `[{"value":[{"address":"...","name":""}],...}]` 형태로
 * 왔다. 주소가 들어 있으면 뽑고, 아니면 JSON 으로 눌러 담는다.
 */
function stringifyHeaderValue(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (value == null) return ''

  if (Array.isArray(value)) {
    const parts = value.map(stringifyHeaderValue).filter(Boolean)
    return parts.join(' ')
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.address === 'string') return record.address
    if (record.value !== undefined) return stringifyHeaderValue(record.value)
    if (typeof record.text === 'string') return record.text
    return ''
  }

  return String(value)
}

/** "이름 <주소>" 또는 "주소" 에서 주소만 뽑는다. */
export function extractAddress(value: string | null | undefined): string | null {
  if (!value) return null
  const angled = value.match(/<([^>]+)>/)
  const candidate = (angled?.[1] ?? value).trim()
  return candidate.includes('@') ? candidate.toLowerCase() : null
}

/** `<a@b> <c@d>` 형태의 헤더를 메시지 ID 배열로. */
function parseMessageIdList(value: string | undefined): string[] {
  if (!value) return []
  const matches = value.match(/<[^>]+>/g)
  if (matches) return matches
  // 꺾쇠 없이 공백으로만 구분해 오는 경우도 있다.
  return value.split(/\s+/).filter((part) => part.includes('@'))
}

export function parseInboundEmail(payload: Record<string, unknown>): ParsedInboundEmail {
  const headers = normalizeHeaders(payload.headers as RawHeaders)

  const to = toArray(payload.to)

  // 전달을 거쳤으면 delivered-to 에 원 주소가 남는다.
  const deliveredToHeader =
    extractAddress(headers.get('delivered-to')) ??
    extractAddress(headers.get('x-original-to')) ??
    // x-forwarded-for 는 "원주소 도착주소" 순서라 첫 항목이 원 주소다.
    extractAddress(headers.get('x-forwarded-for')?.split(/\s+/)[0])

  const wasForwarded =
    headers.has('x-forwarded-to') ||
    headers.has('x-forwarded-for') ||
    (deliveredToHeader !== null && !to.some((t) => extractAddress(t) === deliveredToHeader))

  const references = parseMessageIdList(headers.get('references'))
  const inReplyTo =
    parseMessageIdList(headers.get('in-reply-to'))[0] ?? null

  const attachments = Array.isArray(payload.attachments)
    ? (payload.attachments as Record<string, unknown>[]).map((a) => ({
        id: typeof a.id === 'string' ? a.id : undefined,
        filename: typeof a.filename === 'string' ? a.filename : undefined,
        contentType:
          typeof a.content_type === 'string'
            ? a.content_type
            : typeof a.contentType === 'string'
              ? a.contentType
              : undefined,
        size: typeof a.size === 'number' ? a.size : undefined,
      }))
    : []

  const from = typeof payload.from === 'string' ? payload.from : ''
  const createdAt = payload.created_at ?? payload.createdAt

  return {
    emailId: String(payload.id ?? payload.email_id ?? ''),
    messageId:
      typeof payload.message_id === 'string'
        ? payload.message_id
        : (headers.get('message-id') ?? null),
    inReplyTo,
    references,
    from,
    fromAddress: extractAddress(from),
    to,
    deliveredTo: deliveredToHeader ?? extractAddress(to[0]),
    cc: toArray(payload.cc),
    replyTo: toArray(payload.reply_to ?? payload.replyTo),
    subject: typeof payload.subject === 'string' ? payload.subject : '',
    text: typeof payload.text === 'string' ? payload.text : null,
    html: typeof payload.html === 'string' ? payload.html : null,
    attachments,
    receivedAt: typeof createdAt === 'string' ? new Date(createdAt) : new Date(),
    wasForwarded,
  }
}

/**
 * 스레드 식별자.
 *
 * references 의 첫 항목이 스레드의 뿌리다. 없으면 in-reply-to, 그것도 없으면
 * 이 메일이 스레드의 시작이므로 자기 message-id 를 쓴다.
 */
export function resolveThreadKey(email: ParsedInboundEmail): string | null {
  return email.references[0] ?? email.inReplyTo ?? email.messageId
}

/** 사업자등록증일 가능성이 있는 첨부만 고른다. */
export function findBusinessLicenseCandidates(
  attachments: InboundAttachment[],
): InboundAttachment[] {
  const nameHints = /사업자|등록증|business|license|registration|bizno/i
  const okType = /^(application\/pdf|image\/(png|jpe?g|heic|webp))$/i

  return attachments.filter((a) => {
    const byName = a.filename ? nameHints.test(a.filename) : false
    const byType = a.contentType ? okType.test(a.contentType) : false
    // 이름이 힌트에 맞으면 타입이 특이해도 후보로 둔다. 반대로 이름이 무의미해도
    // PDF/이미지면 후보다 — 사람이 확인할 대상을 넓게 잡는 편이 낫다.
    return byName || byType
  })
}
