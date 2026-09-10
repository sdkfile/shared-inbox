import { describe, expect, it } from 'vitest'
import crypto from 'crypto'
import { verifyResendWebhook, readSvixHeaders } from '../src/resend/verifySignature.js'

const SECRET = 'whsec_' + Buffer.from('test-secret-key-1234567890').toString('base64')
const BODY = '{"type":"email.received","data":{"id":"em_1"}}'
const ID = 'msg_2abc'

function sign(body: string, id: string, ts: number, secret = SECRET): string {
  const raw = secret.startsWith('whsec_') ? secret.slice(6) : secret
  const mac = crypto
    .createHmac('sha256', Buffer.from(raw, 'base64'))
    .update(`${id}.${ts}.${body}`)
    .digest('base64')
  return `v1,${mac}`
}

const NOW = new Date('2026-09-10T00:00:00Z')
const TS = Math.floor(NOW.getTime() / 1000)

describe('정상 서명', () => {
  it('통과시킨다', () => {
    const r = verifyResendWebhook(
      BODY,
      { id: ID, timestamp: String(TS), signature: sign(BODY, ID, TS) },
      SECRET,
      { now: NOW },
    )
    expect(r.ok).toBe(true)
  })

  it('키 회전 중 여러 서명이 오면 하나만 맞아도 통과', () => {
    const good = sign(BODY, ID, TS)
    const r = verifyResendWebhook(
      BODY,
      { id: ID, timestamp: String(TS), signature: `v1,ZmFrZQ== ${good}` },
      SECRET,
      { now: NOW },
    )
    expect(r.ok).toBe(true)
  })

  it('whsec_ 접두사가 없는 시크릿도 받는다', () => {
    const bare = SECRET.slice(6)
    const r = verifyResendWebhook(
      BODY,
      { id: ID, timestamp: String(TS), signature: sign(BODY, ID, TS, bare) },
      bare,
      { now: NOW },
    )
    expect(r.ok).toBe(true)
  })
})

describe('거절', () => {
  it('본문이 한 글자만 달라도 거절한다', () => {
    const r = verifyResendWebhook(
      BODY + ' ',
      { id: ID, timestamp: String(TS), signature: sign(BODY, ID, TS) },
      SECRET,
      { now: NOW },
    )
    expect(r).toEqual({ ok: false, reason: 'no_matching_signature' })
  })

  it('오래된 타임스탬프를 거절한다 (재전송 방어)', () => {
    // 서명이 유효해도 오래된 페이로드를 다시 쏘는 공격이 가능하다.
    const old = TS - 10 * 60
    const r = verifyResendWebhook(
      BODY,
      { id: ID, timestamp: String(old), signature: sign(BODY, ID, old) },
      SECRET,
      { now: NOW },
    )
    expect(r).toEqual({ ok: false, reason: 'timestamp_out_of_tolerance' })
  })

  it('미래 타임스탬프도 거절한다', () => {
    const future = TS + 10 * 60
    const r = verifyResendWebhook(
      BODY,
      { id: ID, timestamp: String(future), signature: sign(BODY, ID, future) },
      SECRET,
      { now: NOW },
    )
    expect(r).toEqual({ ok: false, reason: 'timestamp_out_of_tolerance' })
  })

  it('시크릿이 없으면 거절한다', () => {
    // 설정 실수로 전부 통과되는 것보다 전부 막히는 게 낫다.
    const r = verifyResendWebhook(BODY, { id: ID, timestamp: String(TS), signature: 'v1,x' }, undefined)
    expect(r).toEqual({ ok: false, reason: 'missing_secret' })
  })

  it('헤더가 없으면 거절한다', () => {
    const r = verifyResendWebhook(BODY, { id: null, timestamp: null, signature: null }, SECRET)
    expect(r).toEqual({ ok: false, reason: 'missing_headers' })
  })

  it('타임스탬프가 숫자가 아니면 거절한다', () => {
    const r = verifyResendWebhook(
      BODY,
      { id: ID, timestamp: 'abc', signature: 'v1,x' },
      SECRET,
      { now: NOW },
    )
    expect(r).toEqual({ ok: false, reason: 'bad_timestamp' })
  })

  it('v1 이 아닌 버전은 무시한다', () => {
    const r = verifyResendWebhook(
      BODY,
      { id: ID, timestamp: String(TS), signature: `v2,${sign(BODY, ID, TS).slice(3)}` },
      SECRET,
      { now: NOW },
    )
    expect(r.ok).toBe(false)
  })

  it('다른 시크릿으로 만든 서명을 거절한다', () => {
    const other = 'whsec_' + Buffer.from('another-secret-value-000').toString('base64')
    const r = verifyResendWebhook(
      BODY,
      { id: ID, timestamp: String(TS), signature: sign(BODY, ID, TS, other) },
      SECRET,
      { now: NOW },
    )
    expect(r.ok).toBe(false)
  })
})

describe('헤더 읽기', () => {
  it('svix-* 를 읽는다', () => {
    const h = new Headers({ 'svix-id': 'a', 'svix-timestamp': '1', 'svix-signature': 'v1,x' })
    expect(readSvixHeaders(h)).toEqual({ id: 'a', timestamp: '1', signature: 'v1,x' })
  })

  it('webhook-* 로도 받는다', () => {
    const h = new Headers({ 'webhook-id': 'b', 'webhook-timestamp': '2', 'webhook-signature': 'v1,y' })
    expect(readSvixHeaders(h)).toEqual({ id: 'b', timestamp: '2', signature: 'v1,y' })
  })
})
