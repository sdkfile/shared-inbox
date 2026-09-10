/**
 * Resend 웹훅 서명 검증 (Svix 규격).
 *
 * svix 패키지를 들이지 않고 직접 구현한다. 검증 로직은 HMAC-SHA256 한 번이고,
 * 이 리포는 이미 NODE_ENV=production 이 셸에 떠 있어 npm install 이 devDeps 를
 * 날리는 사고 이력이 있다. 의존성을 안 늘리는 편이 낫다.
 *
 * Svix 규격 (https://docs.svix.com/receiving/verifying-payloads/how-manual):
 *   서명 대상 = `${svix-id}.${svix-timestamp}.${rawBody}`
 *   시크릿    = "whsec_" 접두사를 뗀 뒤 base64 디코드한 원본 바이트
 *   헤더      = svix-signature 는 "v1,<base64> v1,<base64> ..." 공백 구분 목록
 *               (키 회전 중에는 여러 개가 온다 — 하나라도 맞으면 통과)
 *
 * 재전송(replay) 방어: 타임스탬프가 허용 창을 벗어나면 거절한다. 서명이 유효해도
 * 오래된 페이로드를 다시 쏘는 공격이 가능하기 때문이다.
 */

import crypto from 'crypto'

/** Svix 권장값과 동일한 5분. */
const DEFAULT_TOLERANCE_SECONDS = 5 * 60

export interface SvixHeaders {
  id: string | null
  timestamp: string | null
  signature: string | null
}

export type VerifyFailure =
  | 'missing_secret'
  | 'missing_headers'
  | 'bad_timestamp'
  | 'timestamp_out_of_tolerance'
  | 'no_matching_signature'

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: VerifyFailure }

/** 요청에서 Svix 헤더를 뽑는다. Resend 는 svix-* 이름을 그대로 쓴다. */
export function readSvixHeaders(headers: Headers): SvixHeaders {
  return {
    id: headers.get('svix-id') ?? headers.get('webhook-id'),
    timestamp: headers.get('svix-timestamp') ?? headers.get('webhook-timestamp'),
    signature: headers.get('svix-signature') ?? headers.get('webhook-signature'),
  }
}

function decodeSecret(secret: string): Buffer {
  // "whsec_" 접두사가 붙어 오지만 서명에는 디코드된 원본 바이트를 쓴다.
  const raw = secret.startsWith('whsec_') ? secret.slice(6) : secret
  return Buffer.from(raw, 'base64')
}

/**
 * 길이가 달라도 안전하게 비교한다.
 *
 * timingSafeEqual 은 길이가 다르면 예외를 던지므로 미리 길이를 확인하는데,
 * 그 확인 자체는 타이밍 노출이 아니다(서명 길이는 공개 정보다).
 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return crypto.timingSafeEqual(bufA, bufB)
}

export function verifyResendWebhook(
  rawBody: string,
  headers: SvixHeaders,
  secret: string | undefined,
  options: { toleranceSeconds?: number; now?: Date } = {},
): VerifyResult {
  if (!secret) return { ok: false, reason: 'missing_secret' }

  const { id, timestamp, signature } = headers
  if (!id || !timestamp || !signature) {
    return { ok: false, reason: 'missing_headers' }
  }

  const sentAt = Number(timestamp)
  if (!Number.isFinite(sentAt)) {
    return { ok: false, reason: 'bad_timestamp' }
  }

  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000)
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS
  if (Math.abs(nowSeconds - sentAt) > tolerance) {
    return { ok: false, reason: 'timestamp_out_of_tolerance' }
  }

  const signedPayload = `${id}.${timestamp}.${rawBody}`
  const expected = crypto
    .createHmac('sha256', decodeSecret(secret))
    .update(signedPayload)
    .digest('base64')

  // 키 회전 중에는 서명이 여러 개 온다. 하나라도 맞으면 통과.
  for (const part of signature.split(' ')) {
    const [version, value] = part.split(',')
    if (version !== 'v1' || !value) continue
    if (safeEqual(value, expected)) return { ok: true }
  }

  return { ok: false, reason: 'no_matching_signature' }
}

/** 실패 사유를 로그용 한국어로. 응답 본문에는 넣지 않는다(공격자에게 힌트가 된다). */
export const VERIFY_FAILURE_MESSAGES: Record<VerifyFailure, string> = {
  missing_secret: 'RESEND_WEBHOOK_SECRET 이 설정되지 않았습니다.',
  missing_headers: 'svix 서명 헤더가 없습니다.',
  bad_timestamp: 'svix-timestamp 형식이 올바르지 않습니다.',
  timestamp_out_of_tolerance: '타임스탬프가 허용 범위를 벗어났습니다(재전송 의심).',
  no_matching_signature: '서명이 일치하지 않습니다.',
}
