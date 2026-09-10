# 웹훅 핸들러

Next.js App Router 기준. 다른 프레임워크도 요점은 같다.

## 전체 코드

```ts
// app/api/webhooks/resend/route.ts
import {
  verifyResendWebhook,
  readSvixHeaders,
  parseInboundEmail,
  resolveThreadKey,
} from 'shared-inbox'

export async function POST(req: Request) {
  // 1. 원문 그대로 읽는다.
  //    JSON.parse 후 재직렬화하면 키 순서·공백이 바뀌어 서명이 깨진다.
  const raw = await req.text()

  const result = verifyResendWebhook(
    raw,
    readSvixHeaders(req.headers),
    process.env.RESEND_WEBHOOK_SECRET,
  )

  if (!result.ok) {
    // 실패 사유는 로그에만. 응답 본문에 넣으면 공격자에게 힌트가 된다.
    console.warn('[resend] 서명 검증 실패:', result.reason)
    return new Response('unauthorized', { status: 401 })
  }

  const body = JSON.parse(raw)
  if (body.type !== 'email.received') {
    // 모르는 이벤트도 200. 재전송돼도 결과가 같다.
    return Response.json({ ok: true, skipped: body.type })
  }

  const email = parseInboundEmail(body.data)

  // 2. 저장만 한다. 판독·LLM 호출은 여기서 하지 않는다.
  try {
    await db.inboundEmail.upsert({
      where: { emailId: email.emailId },   // 재전송 대비
      create: {
        emailId: email.emailId,
        messageId: email.messageId,
        threadKey: resolveThreadKey(email),
        fromAddress: email.fromAddress,
        deliveredTo: email.deliveredTo,     // 라우팅은 이 값으로
        subject: email.subject,
        receivedAt: email.receivedAt,
        // processedAt 은 비워둔다. 처리 작업이 채운다.
      },
      update: {},                            // 이미 있으면 그대로
    })
  } catch (e) {
    // DB 장애는 500. 재전송이 도움된다.
    console.error('[resend] 저장 실패:', e)
    return new Response('storage error', { status: 500 })
  }

  return Response.json({ ok: true })
}

// 웹훅 URL 등록 시 접근 확인용. 정보는 노출하지 않는다.
export function GET() {
  return Response.json({ ok: true })
}
```

## 왜 저장만 하는가

웹훅 핸들러에서 첨부를 받고 LLM 을 부르면 이렇게 된다.

```
Resend → 웹훅 → 첨부 다운로드(3s) → LLM 판독(8s) → 카드 게시(1s)
                                                      ↑ 서버리스 타임아웃
```

타임아웃이 나면 Resend 는 **실패로 보고 재전송한다.** 그런데 첨부는 이미
받았고 LLM 도 이미 불렀다. 재전송될 때마다 비용이 나가고, 운이 나쁘면
카드가 여러 장 올라간다.

저장과 처리를 나누면 웹훅은 200ms 안에 끝난다.

```
웹훅        저장만                      (빠르다)
크론/큐     미처리 건을 집어서 처리      (느려도 된다)
```

## 응답 코드가 곧 재전송 정책

| 상황 | 코드 | 이유 |
|---|---|---|
| 서명 불일치 | 401 | 재전송해도 같다. 조용히 넘기지 않는다 |
| 모르는 이벤트 타입 | 200 | 재전송해도 같다 |
| 이미 저장된 메일 | 200 | upsert 로 흡수 |
| DB 장애 | 500 | 재전송이 도움된다 |
| 파싱 실패 | 200 | 재전송해도 같은 페이로드다 |

**"실패했으니 500" 이 아니라 "재전송이 도움되는가" 로 판단한다.**

## 처리 작업

```ts
// 크론에서 15분마다
const pending = await db.inboundEmail.findMany({
  where: { processedAt: null },
  take: 10,                                 // 상한을 둔다
  orderBy: { receivedAt: 'asc' },
})

for (const row of pending) {
  try {
    await processOne(row)
  } catch (e) {
    // 한 건 실패가 나머지를 막으면 안 된다.
    console.error(`[process] ${row.emailId} 실패:`, e)
    await db.inboundEmail.update({
      where: { id: row.id },
      data: { processedAt: new Date(), failureReason: String(e).slice(0, 500) },
    })
  }
}
```

### 처리할 게 없어도 processedAt 을 찍는다

실제 사고였다. 첨부 없는 메일에 `processedAt` 을 안 찍었더니 15분마다 같은
5건을 다시 집었고, `take: 10` 안에서 자리를 차지해 **새 메일이 계속 밀렸다.**

```ts
// 틀림
if (!hasAttachment) return          // 다음 크론에서 또 집는다

// 맞음
if (!hasAttachment) {
  await markProcessed(row.id, { reason: 'no_attachment' })
  return
}
```

"아무것도 안 했다" 와 "처리했는데 할 게 없었다" 는 다르다. 후자를 기록해야
루프가 끊긴다.

**이 버그를 덮고 있던 테스트가 있었다.** "첨부가 없으면 아무것도 하지 않는다"
를 검증하고 있었는데, 그게 정확히 버그였다. 테스트가 버그와 같은 가정 위에
서 있으면 통과해도 의미가 없다.

## 첨부 처리

```ts
const files = await listAttachments(email.emailId)
if (files.length === 0) {
  await markProcessed(row.id, { reason: 'no_attachment' })
  return
}

const buf = await downloadAttachment(files[0], { maxBytes: 12 * 1024 * 1024 })
if (!buf) {
  // 너무 크거나 받기 실패. 사람이 직접 보게 한다.
  await markProcessed(row.id, { reason: 'attachment_too_large' })
  return
}

// content_type 을 믿지 않는다. 매직 바이트로 확인한다.
const kind = sniffFileType(buf)
if (kind === 'pdf') {
  // OpenAI Vision 은 PDF 를 image_url 로 받지 않는다 → 400 invalid_image_format
  await callVision({ type: 'file', data: buf })
} else if (kind) {
  await callVision({ type: 'image_url', data: buf })
}
```

## 로컬 테스트

Resend 는 웹훅을 재전송해주지만, 로컬에서는 저장한 페이로드를 직접 쏘는 게
빠르다.

```bash
# 서명 없이 (검증을 임시로 끄고)
curl -X POST http://localhost:3000/api/webhooks/resend \
  -H 'Content-Type: application/json' \
  -d @examples/webhook-forwarded.json

# 파싱 결과만 보고 싶으면
node scripts/inspect-payload.mjs examples/webhook-forwarded.json
```
