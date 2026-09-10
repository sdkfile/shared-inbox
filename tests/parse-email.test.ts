import { describe, expect, it } from 'vitest'
import {
  parseInboundEmail,
  resolveThreadKey,
  extractAddress,
  normalizeHeaders,
  findBusinessLicenseCandidates,
} from '../src/resend/parseEmail.js'

describe('전달된 메일의 원 수신 주소', () => {
  // 전달을 거치면 to 가 봇 주소로 바뀐다. 이걸 라우팅에 쓰면
  // 모든 메일이 한 곳으로 온 것처럼 보인다.
  const forwarded = {
    id: 'em_1',
    from: '고객사 <client@corp.co.kr>',
    to: ['bot@inbound.example.com'],
    subject: '문의',
    headers: [
      { name: 'Delivered-To', value: 'support@example.com' },
      { name: 'X-Forwarded-To', value: 'bot@inbound.example.com' },
      { name: 'X-Forwarded-For', value: 'support@example.com bot@inbound.example.com' },
    ],
  }

  it('delivered-to 로 원 주소를 복원한다', () => {
    expect(parseInboundEmail(forwarded).deliveredTo).toBe('support@example.com')
  })

  it('전달 여부를 표시한다', () => {
    expect(parseInboundEmail(forwarded).wasForwarded).toBe(true)
  })

  it('to 는 도착 주소 그대로 둔다', () => {
    // 라우팅엔 쓰지 않지만 디버깅에 필요하다.
    expect(parseInboundEmail(forwarded).to).toEqual(['bot@inbound.example.com'])
  })

  it('delivered-to 가 없으면 to 로 폴백한다', () => {
    const direct = { id: 'em_2', from: 'a@b.com', to: ['sales@example.com'], headers: [] }
    expect(parseInboundEmail(direct).deliveredTo).toBe('sales@example.com')
    expect(parseInboundEmail(direct).wasForwarded).toBe(false)
  })

  it('x-forwarded-for 는 첫 항목이 원 주소다', () => {
    const e = parseInboundEmail({
      id: 'em_3',
      from: 'a@b.com',
      to: ['bot@inbound.example.com'],
      headers: [{ name: 'X-Forwarded-For', value: 'billing@example.com bot@inbound.example.com' }],
    })
    expect(e.deliveredTo).toBe('billing@example.com')
  })
})

describe('헤더 정규화', () => {
  it('대소문자를 구분하지 않는다', () => {
    const m = normalizeHeaders([{ name: 'Message-ID', value: '<a@b>' }])
    expect(m.get('message-id')).toBe('<a@b>')
  })

  it('배열로 와도 객체로 와도 받는다', () => {
    expect(normalizeHeaders({ 'Message-Id': '<x@y>' }).get('message-id')).toBe('<x@y>')
  })

  it('같은 헤더가 여러 번이면 첫 값을 쓴다', () => {
    // 전달 체인에서 delivered-to 가 여러 번 붙는다. 가장 바깥이 우리 경로다.
    const m = normalizeHeaders([
      { name: 'Delivered-To', value: 'outer@example.com' },
      { name: 'Delivered-To', value: 'inner@example.com' },
    ])
    expect(m.get('delivered-to')).toBe('outer@example.com')
  })

  it('문자열이 아닌 헤더 값도 처리한다', () => {
    // 실측: return-path 가 [{value:[{address:"..."}]}] 로 왔다.
    const m = normalizeHeaders([
      { name: 'Return-Path', value: [{ value: [{ address: 'bounce@x.com', name: '' }] }] },
    ])
    expect(m.get('return-path')).toContain('bounce@x.com')
  })

  it('헤더가 없어도 죽지 않는다', () => {
    expect(normalizeHeaders(null).size).toBe(0)
    expect(() => parseInboundEmail({ id: 'e', from: 'a@b.c' })).not.toThrow()
  })
})

describe('주소 추출', () => {
  it('"이름 <주소>" 에서 주소만', () => {
    expect(extractAddress('홍길동 <hong@corp.co.kr>')).toBe('hong@corp.co.kr')
  })

  it('소문자로 정규화한다', () => {
    expect(extractAddress('Hong@Corp.CO.KR')).toBe('hong@corp.co.kr')
  })

  it('주소가 아니면 null', () => {
    expect(extractAddress('알 수 없음')).toBeNull()
    expect(extractAddress(null)).toBeNull()
  })
})

describe('스레드 묶기', () => {
  // 제목으로 묶지 않는 이유: 사람이 제목을 바꾸고,
  // Re:/Fwd: 접두사가 언어마다 다르다.
  it('references 의 첫 항목이 뿌리다', () => {
    const e = parseInboundEmail({
      id: 'em_1',
      from: 'a@b.com',
      headers: [
        { name: 'References', value: '<root@x> <mid@x>' },
        { name: 'In-Reply-To', value: '<mid@x>' },
        { name: 'Message-ID', value: '<leaf@x>' },
      ],
    })
    expect(resolveThreadKey(e)).toBe('<root@x>')
  })

  it('references 가 없으면 in-reply-to', () => {
    const e = parseInboundEmail({
      id: 'em_2',
      from: 'a@b.com',
      headers: [
        { name: 'In-Reply-To', value: '<parent@x>' },
        { name: 'Message-ID', value: '<self@x>' },
      ],
    })
    expect(resolveThreadKey(e)).toBe('<parent@x>')
  })

  it('첫 메일이면 자기 message-id 가 뿌리다', () => {
    const e = parseInboundEmail({
      id: 'em_3',
      from: 'a@b.com',
      headers: [{ name: 'Message-ID', value: '<first@x>' }],
    })
    expect(resolveThreadKey(e)).toBe('<first@x>')
  })

  it('꺾쇠 없는 목록도 파싱한다', () => {
    const e = parseInboundEmail({
      id: 'em_4',
      from: 'a@b.com',
      headers: [{ name: 'References', value: 'root@x mid@x' }],
    })
    expect(resolveThreadKey(e)).toBe('root@x')
  })
})

describe('첨부 후보 선별', () => {
  it('이름에 힌트가 있으면 타입이 특이해도 고른다', () => {
    const found = findBusinessLicenseCandidates([
      { filename: '사업자등록증.pdf', contentType: 'application/octet-stream' },
    ])
    expect(found).toHaveLength(1)
  })

  it('이름이 무의미해도 PDF/이미지면 고른다', () => {
    // 사람이 확인할 대상은 넓게 잡는 편이 낫다.
    const found = findBusinessLicenseCandidates([
      { filename: 'scan_001.pdf', contentType: 'application/pdf' },
    ])
    expect(found).toHaveLength(1)
  })

  it('관계없는 파일은 뺀다', () => {
    const found = findBusinessLicenseCandidates([
      { filename: '견적서.xlsx', contentType: 'application/vnd.ms-excel' },
    ])
    expect(found).toHaveLength(0)
  })

  it('content_type 과 contentType 을 모두 받는다', () => {
    const e = parseInboundEmail({
      id: 'em_5',
      from: 'a@b.com',
      attachments: [{ id: 'at_1', filename: 'x.pdf', content_type: 'application/pdf', size: 100 }],
    })
    expect(e.attachments[0]?.contentType).toBe('application/pdf')
  })
})
