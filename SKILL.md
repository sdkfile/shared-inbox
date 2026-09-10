---
name: shared-inbox
description: 메일함 자동화에 AI를 붙일 때 사용. 사람이 계속 읽는 구조를 지킨다.
version: 0.1.0
author: Seonggu Kim (sdkfile)
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [이메일, 메일자동화, inbound, resend, webhook, human-in-the-loop, 승인]
---

# 사람과 AI 가 같은 메일함을 나눠 읽기

수신 메일함에 자동화를 붙일 때 쓴다. 웹훅을 받고, 파싱하고, 분류하고,
초안을 만들어 사람 앞에 놓는 데까지가 범위다.

**전제: AI 는 메일함 상태를 바꾸지 않는다.** 읽음 표시도, 라벨도, 발송도
하지 않는다. 사람의 워크플로는 자동화가 없을 때와 똑같이 돌아가고, AI 는
그 옆에 분류·초안·근거를 붙여둔다.

그래서 이 패키지에는 **메일을 보내는 함수가 없다.** 빠뜨린 게 아니라
만들지 않은 것이다.

## When to Use

- 문의·지원 메일함에 자동 분류나 초안 작성을 붙일 때
- 수신 웹훅(Resend 등)을 받아 처리할 때
- 첨부에서 정보를 뽑아 시스템에 넣을 때
- "AI 가 메일을 처리했는데 사람이 못 봤다" 를 막아야 할 때

**쓰지 않을 것:** 발신 전용 자동화(뉴스레터, 알림 메일), 메일 서버 구축.

## 왜 이 구조인가

자동화를 붙일 때 가장 흔한 실패는 AI 가 메일을 **처리해버리는** 것이다.
읽음 표시하고, 라벨 옮기고, 답장까지 보내고 나면 사람이 볼 게 없다.

그러면 이렇게 된다.

```
AI 가 잘 처리함  →  사람이 안 봄  →  AI 가 한 번 크게 틀림
                                   →  사람이 자동화를 못 믿음
                                   →  결국 둘 다 전부 읽음
```

한 번의 실수가 신뢰를 통째로 날린다. 그래서 반대로 간다.

```
사람   읽고, 판단하고, 보낸다          (원래 하던 대로)
AI     분류하고, 초안 쓰고, 근거를 댄다  (옆에 붙여둔다)
```

사람이 자동화를 꺼도 업무가 그대로 돌아가야 한다. 그게 이 설계의 기준이다.

## Prerequisites

```bash
npm install
npm run build
```

```bash
export RESEND_FULL_API_KEY=re_xxxxx    # 수신 조회는 full access 키가 필요
export RESEND_WEBHOOK_SECRET=whsec_xxx # 없으면 모든 요청을 거절한다
```

발신 전용 키를 쓰면 `401 restricted_api_key` 가 온다.

## 절차

### 1. 수신 설정 점검

```
terminal(command="node scripts/preflight.mjs")
```

키 권한·도메인 검증·MX·웹훅 시크릿을 한 번에 본다.

**완료 기준:** 수신 도메인의 MX 가 Resend 를 가리키고, 시크릿이 있다.

### 2. 웹훅 핸들러 배선

`references/webhook.md` 에 전체 코드가 있다. 요점만:

```ts
const raw = await req.text()   // 원문 그대로. JSON.parse 후 재직렬화하면 서명이 깨진다
const v = verifyResendWebhook(raw, readSvixHeaders(req.headers), process.env.RESEND_WEBHOOK_SECRET)
if (!v.ok) return new Response('unauthorized', { status: 401 })

const email = parseInboundEmail(JSON.parse(raw).data)
await db.save(email)           // 저장만 한다. 처리는 별도 작업으로
return Response.json({ ok: true })
```

**웹훅에서는 저장만 한다.** 판독·LLM 호출을 여기서 하면 타임아웃이 나고,
Resend 가 재전송하면서 같은 메일이 여러 번 처리된다.

**완료 기준:** 테스트 메일을 보내 DB 에 행이 생긴다.

### 3. 페이로드 확인

라우팅이 이상하면 여기서 본다.

```
terminal(command="node scripts/inspect-payload.mjs <저장한페이로드.json>")
```

`원 수신처` 가 비어 있으면 전달 헤더를 못 읽은 것이다 — 이 값으로
라우팅하면 모든 메일이 한 곳으로 온 것처럼 보인다.

### 4. 본문·첨부 조회

**웹훅에는 본문이 오지 않는다.** 메타데이터만 온다.

```ts
const detail = await fetchReceivedEmail(email.emailId)   // 본문·헤더
const files = await listAttachments(email.emailId)       // 첨부 목록
const buf = await downloadAttachment(files[0])           // 실제 파일
```

### 5. 분류하고 초안 만들기

```ts
const decision = await classify(email)     // 직접 구현 (LLM 호출)

if (decision.disposition === 'NEEDS_HUMAN') {
  const warnings = checkClaims(decision.draft.body, { rules, urls })
  await postApprovalCard(email, decision, warnings)   // 사람에게 보낸다
}
```

**완료 기준:** 승인 화면에 초안과 경고가 뜨고, 메일은 아직 나가지 않았다.

## 사고를 막는 규칙

### AI 가 상태를 바꾸지 않는다

```ts
AUTONOMOUS_ACTIONS   // classify, draft, extract, notify
REQUIRES_APPROVAL    // send, archive, mark_read, label, delete
```

`mark_read` 와 `label` 도 승인 대상이다. 읽음 표시는 사람이 못 보게 만들고,
라벨 변경은 사람의 분류를 덮어쓴다.

### 초안이 지어낸 사실을 검사한다

LLM 은 그럴듯한 문장을 만들도록 훈련됐지, 사실을 말하도록 훈련되지 않았다.
실제로 겪은 것들:

```
"표준 계약서 양식이 있으며 보내드리겠습니다"   → 그런 양식이 없었다
"견적서에 별도 항목으로 안내드렸습니다"        → 그런 항목이 없었다
".../file/d/1m9cKabGpqRRVsARu..."             → 정본은 RVsARu. R 이 하나 늘었다
```

앞의 둘은 상대가 확인하면 드러나고, **마지막은 사람 눈으로 못 잡는다.**

```ts
checkClaims(body, {
  rules: [...COMMON_RULES, { pattern: /표준\s*계약서[^.\n]{0,12}있/, reason: '양식이 없습니다' }],
  urls: [{ domain: 'drive.google.com', canonical: MEDIA_KIT_URL }],
})
```

발송을 막지 않고 경고만 띄운다. 막으면 오탐 때문에 정상 답신까지 손으로
보내게 되고, 그러면 자동화를 끈다.

### 확신도를 통과 기준으로 쓰지 않는다

사업자등록증에서 상호를 읽을 때 `gpt-4.1` 이 confidence **0.99** 로
"별오디스튜디오" 를 반환했다. 정답은 "널포인터스튜디오" 였다.

모델은 자기가 틀렸다는 걸 모른다. 확신도는 "이건 좀 더 봐주세요" 라고
말하는 용도로만 쓴다.

## Pitfalls

**전달을 거치면 `to` 를 믿을 수 없다.** `support@` 로 온 메일이
`bot@inbound...` 로 전달되면 `to` 가 후자로 바뀐다. `delivered-to` 로
원 주소를 복원해야 주소별 라우팅이 된다.

**웹훅 본문은 원문 그대로 서명 검증한다.** `JSON.parse` 후 다시
`JSON.stringify` 하면 키 순서와 공백이 바뀌어 서명이 깨진다.

**웹훅에는 본문·첨부가 오지 않는다.** 메타데이터만 온다. 별도 API 를 부른다.

**첨부 `download_url` 에 Authorization 을 붙이지 마라.** pre-signed URL 이라
헤더를 붙이면 오히려 실패한다.

**`content_type` 을 믿지 마라.** 보내는 쪽이 정하는 값이다. PDF 를
`application/octet-stream` 으로 보내는 클라이언트가 흔하다 →
`sniffFileType()` 로 매직 바이트를 확인한다.

**PDF 를 이미지로 LLM 에 보내지 마라.** OpenAI Vision 은
`400 invalid_image_format` 을 준다. `file` 파트를 써야 한다. 그리고 PDF 는
텍스트 레이어가 있어 이미지보다 정확하다 — 실측에서 이미지로는 못 읽던
한글 상호를 PDF 로는 5/5 정확히 읽었다.

**처리 실패도 "처리함" 으로 기록해라.** 실제 사고: 첨부 없는 메일에
`processedAt` 을 안 찍어서 15분마다 같은 5건을 다시 처리했고, 새 메일이
계속 밀렸다. "아무것도 안 했다" 와 "처리했는데 할 게 없었다" 는 다르다.

**자기 메일을 차단해라.** 자동화가 자기가 보낸 메일에 반응하면 무한 루프다.
`isSelfAddressed()` 에 운영 주소를 전부 넣어라 — 별칭까지.

## Verification

```
terminal(command="npm run check")
```

타입 검사 + 테스트 55개. 네트워크를 타지 않는다.

```
terminal(command="node scripts/inspect-payload.mjs examples/webhook-forwarded.json")
```

전달된 메일에서 원 수신처가 복원되는지 눈으로 확인한다.

## 문서

- `references/webhook.md` — 웹훅 핸들러 전체 코드와 응답 코드 정책
- `references/human-ai-split.md` — 승인 화면 설계, 실패 사례
