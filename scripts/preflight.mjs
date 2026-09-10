#!/usr/bin/env node
/**
 * 수신 설정 점검. 메일을 받기 전에 무엇이 준비됐는지 본다.
 *
 *   node scripts/preflight.mjs
 *
 * 확인하는 것:
 *   - API 키가 수신 조회 권한을 가졌는가 (발신 전용 키면 401)
 *   - 도메인이 verified 인가
 *   - MX 레코드가 Resend 를 가리키는가
 *   - 웹훅 시크릿이 있는가
 */

import { promises as dns } from 'node:dns'

const API = 'https://api.resend.com'

const key = process.env.RESEND_FULL_API_KEY ?? process.env.RESEND_API_KEY
const secret = process.env.RESEND_WEBHOOK_SECRET

function line(ok, label, detail = '') {
  const mark = ok === null ? '·' : ok ? '✓' : '✗'
  console.log(`  ${mark} ${label}${detail ? '  ' + detail : ''}`)
}

async function main() {
  console.log('\n=== 수신 설정 점검 ===\n')

  if (!key) {
    line(false, 'API 키', 'RESEND_FULL_API_KEY 또는 RESEND_API_KEY 를 설정하세요')
    process.exit(1)
  }
  line(true, 'API 키', `${key.slice(0, 6)}… (길이 ${key.length})`)

  // 도메인 목록 — 이 호출이 401 이면 발신 전용 키다.
  const res = await fetch(`${API}/domains`, {
    headers: { Authorization: `Bearer ${key}` },
  })

  if (res.status === 401) {
    line(false, '키 권한', '수신 조회 권한이 없습니다 (발신 전용 키)')
    console.log('\n  Resend 대시보드에서 full access 키를 만드세요.')
    process.exit(1)
  }
  if (!res.ok) {
    line(false, '도메인 조회', `HTTP ${res.status}`)
    process.exit(1)
  }
  line(true, '키 권한', '수신 조회 가능')

  const body = await res.json()
  const domains = Array.isArray(body) ? body : (body.data ?? [])

  if (domains.length === 0) {
    line(false, '도메인', '등록된 도메인이 없습니다')
    process.exit(1)
  }

  console.log('\n=== 도메인 ===\n')
  for (const d of domains) {
    const ok = d.status === 'verified'
    line(ok, d.name, d.status)
  }

  // MX 확인 — 수신은 MX 가 Resend 를 가리켜야 한다.
  console.log('\n=== MX 레코드 ===\n')
  for (const d of domains) {
    try {
      const mx = await dns.resolveMx(d.name)
      const inbound = mx.filter((r) => /amazonaws\.com|resend/i.test(r.exchange))
      if (inbound.length > 0) {
        line(true, d.name, inbound.map((m) => m.exchange).join(', '))
      } else {
        // 수신용이 아닌 도메인일 수 있다. 실패가 아니라 정보다.
        line(null, d.name, mx.map((m) => `${m.priority} ${m.exchange}`).join(', '))
      }
    } catch {
      line(null, d.name, 'MX 없음 (발신 전용 도메인이면 정상)')
    }
  }

  console.log('\n=== 웹훅 ===\n')
  if (secret) {
    line(true, '시크릿', `${secret.slice(0, 10)}… (길이 ${secret.length})`)
  } else {
    line(false, '시크릿', 'RESEND_WEBHOOK_SECRET 이 없으면 모든 요청이 거절됩니다')
  }

  console.log('\n웹훅 URL 은 Resend 대시보드 > Webhooks 에서 등록합니다.')
  console.log('email.received 이벤트를 구독해야 수신 메일이 옵니다.\n')
}

main().catch((e) => {
  console.error('점검 실패:', e.message)
  process.exit(1)
})
