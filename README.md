# shared-inbox

사람과 AI 가 같은 메일함을 나눠 읽는다.

> npm 에는 아직 올리지 않았다. 지금은 클론해서 쓴다.

```bash
git clone https://github.com/sdkfile/shared-inbox
cd shared-inbox && npm install && npm run build
```

## 전제

**AI 는 메일함 상태를 바꾸지 않는다.** 읽음 표시도, 라벨도, 발송도 하지
않는다. 사람의 워크플로는 자동화가 없을 때와 똑같이 돌아가고, AI 는 그 옆에
분류·초안·근거를 붙여둔다.

그래서 이 패키지에는 **메일을 보내는 함수가 없다.** 빠뜨린 게 아니라
만들지 않은 것이다.

```
사람   읽고, 판단하고, 보낸다          (원래 하던 대로)
AI     분류하고, 초안 쓰고, 근거를 댄다  (옆에 붙여둔다)
```

## 왜 이렇게 만들었나

자동화를 붙일 때 흔한 실패는 AI 가 메일을 **처리해버리는** 것이다.

```
1주차   AI 가 90% 를 정확히 처리한다. 사람은 감탄한다.
4주차   사람이 안 본다. 거의 맞으니까.
6주차   AI 가 중요한 걸 하나 놓친다. 아무도 몰랐다.
7주차   사람이 전부 다시 읽는다. 자동화는 켜져 있지만 아무도 안 본다.
```

**90% 정확한 자동화는 100% 신뢰를 얻거나 0% 를 얻는다.** 중간이 없다.

그래서 사람이 계속 읽게 만드는 쪽을 택했다. AI 는 읽는 속도를 올려주는
도구지 읽기를 대신하는 도구가 아니다.

판단 기준은 하나다 — **사람이 자동화를 꺼도 업무가 그대로 돌아가는가.**

## 들어 있는 것

```
core/boundary.ts     무엇을 AI 가 하고 무엇을 사람이 하는가 (타입으로 표현)
core/claimCheck.ts   초안이 없는 것을 있다고 말하는지 검사
resend/parseEmail    전달 헤더 복원, 스레드 묶기, 첨부 선별
resend/verifySignature  Svix HMAC 검증 (의존성 없음)
resend/fetchDetail   웹훅에 안 오는 본문·헤더 조회
resend/attachments   첨부 목록·다운로드·매직바이트 판별
```

## 빠른 시작

```bash
export RESEND_FULL_API_KEY=re_xxxxx
export RESEND_WEBHOOK_SECRET=whsec_xxx

node scripts/preflight.mjs                              # 수신 설정 점검
node scripts/inspect-payload.mjs examples/webhook-forwarded.json   # 파싱 확인
```

## 코드로 쓰기

```ts
// npm 게시 전이라 클론 후 npm link 하거나 상대경로로 import 한다
import {
  verifyResendWebhook,
  readSvixHeaders,
  parseInboundEmail,
  resolveThreadKey,
  checkClaims,
} from 'shared-inbox'

export async function POST(req: Request) {
  // 원문 그대로 검증한다. 재직렬화하면 서명이 깨진다.
  const raw = await req.text()
  const v = verifyResendWebhook(raw, readSvixHeaders(req.headers), SECRET)
  if (!v.ok) return new Response('unauthorized', { status: 401 })

  const email = parseInboundEmail(JSON.parse(raw).data)

  await db.save({
    emailId: email.emailId,
    threadKey: resolveThreadKey(email),
    deliveredTo: email.deliveredTo,   // to 가 아니라 이 값으로 라우팅
  })

  return Response.json({ ok: true })   // 저장만. 처리는 별도 작업으로
}
```

## 실제로 겪은 것들

문서에 적힌 내용은 대부분 사고에서 나왔다.

**전달을 거치면 `to` 를 믿을 수 없다.** `support@` 로 온 메일이
`bot@inbound...` 로 전달되면서 `to` 가 바뀐다. `delivered-to` 로 원 주소를
복원해야 주소별 라우팅이 된다.

**웹훅에는 본문이 없다.** 메타데이터만 온다. 본문·헤더·첨부는 별도 API 다.

**LLM 이 URL 을 한 글자 바꿨다.** `1m9cKabGpqRVsARu` → `1m9cKabGpqRRVsARu`.
사람 눈으로 못 잡는다. `checkClaims()` 가 정본과 대조한다.

**확신도 0.99 로 틀렸다.** `gpt-4.1` 이 사업자등록증 상호를 "별오디스튜디오"
로 읽었다. 정답은 "널포인터스튜디오". 확신도는 통과 기준이 될 수 없다.

**처리 실패를 기록 안 해서 무한 루프가 났다.** 첨부 없는 메일에
`processedAt` 을 안 찍었더니 15분마다 같은 5건을 다시 집었고 새 메일이
밀렸다. 그리고 **그 버그를 덮는 테스트가 있었다** — "첨부가 없으면 아무것도
하지 않는다" 를 검증하고 있었는데, 그게 정확히 버그였다.

## Claude Code 스킬로 쓰기

스킬 디렉터리에 두면 Claude 가 `SKILL.md` 를 읽고 스크립트를 직접 실행한다.
수신 설정 점검, 웹훅 페이로드 진단, 라우팅이 이상할 때 원인 찾기까지 절차가
문서에 있다.

### 설치

```bash
# Claude Code
git clone https://github.com/sdkfile/shared-inbox \
  ~/.claude/skills/shared-inbox

# Hermes
git clone https://github.com/sdkfile/shared-inbox \
  ~/.hermes/skills/shared-inbox
```

### 빌드 (최초 1회, 필수)

```bash
cd ~/.claude/skills/shared-inbox
npm install && npm run build
```

`inspect-payload` 가 `dist/` 를 쓴다. 잊었을 때는 스크립트가 무엇을 해야
하는지 알려준다.

### 키 설정

```bash
export RESEND_FULL_API_KEY=re_xxxxx    # 수신 조회는 full access 키
export RESEND_WEBHOOK_SECRET=whsec_xxx # 없으면 모든 요청을 거절한다
```

발신 전용 키를 쓰면 `401 restricted_api_key` 가 온다.

### 확인

```bash
node scripts/preflight.mjs
```

수신 도메인의 MX 가 Resend 를 가리키는지까지 본다. Claude 에게는 이렇게
말하면 된다.

> 수신 메일 웹훅 설정 제대로 됐는지 봐줘

### 사용 예

```
사용자: 메일이 왔는데 우리 시스템에 안 들어와. 봐줄래?

Claude: (preflight → MX·시크릿 확인 → 저장한 페이로드 진단)

        원 수신처   (복원 실패)
        전달 경유   예

        ⚠ 전달을 거쳤는데 원 주소를 못 찾았습니다.
          delivered-to 헤더를 확인하세요. 이 값으로 라우팅하면
          모든 메일이 한 곳으로 온 것처럼 보입니다.
```

이 스킬은 **메일을 보내지 않는다.** 진단하고 알려줄 뿐이다.

## 문서

- [`SKILL.md`](SKILL.md) — 절차와 함정
- [`references/webhook.md`](references/webhook.md) — 핸들러 전체 코드, 응답 코드 정책
- [`references/human-ai-split.md`](references/human-ai-split.md) — 승인 화면 설계, 실패 사례

## 개발

```bash
npm run check     # 타입 검사 + 테스트 55개
```

## 범위

**하는 것:** 수신 파싱, 서명 검증, 첨부 조회, 분류 경계, 초안 사실 검사

**안 하는 것:** 메일 발송, 메일함 상태 변경, LLM 호출(직접 구현한다),
승인 UI(Discord·Slack 등 각자 환경에 맞게)

## License

MIT
