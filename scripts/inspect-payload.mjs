#!/usr/bin/env node
/**
 * 실제로 받은 웹훅 페이로드를 넣어 파싱 결과를 본다.
 *
 *   node scripts/inspect-payload.mjs <페이로드.json>
 *   cat payload.json | node scripts/inspect-payload.mjs
 *
 * 왜 필요한가: 전달을 거친 메일은 `to` 가 봇 주소로 바뀐다. 라우팅이
 * 이상하면 여기서 delivered-to 가 제대로 복원됐는지부터 본다.
 */

import { readFileSync } from 'node:fs'
import { parseInboundEmail, resolveThreadKey } from '../dist/resend/parseEmail.js'
import { findBusinessLicenseCandidates } from '../dist/resend/parseEmail.js'

function readInput() {
  const file = process.argv[2]
  if (file) return readFileSync(file, 'utf8')
  return readFileSync(0, 'utf8') // stdin
}

const raw = JSON.parse(readInput())
// 웹훅 봉투로 감싸져 있으면 벗긴다.
const payload = raw.data ?? raw

const email = parseInboundEmail(payload)

console.log('\n=== 파싱 결과 ===\n')
console.log(`  발신     ${email.from}`)
console.log(`  주소     ${email.fromAddress ?? '(추출 실패)'}`)
console.log(`  제목     ${email.subject || '(없음)'}`)
console.log(`  수신시각 ${email.receivedAt.toISOString()}`)

console.log('\n=== 라우팅 ===\n')
console.log(`  도착 주소   ${email.to.join(', ') || '(없음)'}`)
console.log(`  원 수신처   ${email.deliveredTo ?? '(복원 실패)'}`)
console.log(`  전달 경유   ${email.wasForwarded ? '예' : '아니오'}`)

if (email.wasForwarded && !email.deliveredTo) {
  console.log('\n  ⚠ 전달을 거쳤는데 원 주소를 못 찾았습니다.')
  console.log('    delivered-to / x-original-to / x-forwarded-for 헤더를 확인하세요.')
  console.log('    이 값으로 라우팅하면 모든 메일이 한 곳으로 온 것처럼 보입니다.')
}

console.log('\n=== 스레드 ===\n')
console.log(`  Message-ID   ${email.messageId ?? '(없음)'}`)
console.log(`  In-Reply-To  ${email.inReplyTo ?? '(없음)'}`)
console.log(`  References   ${email.references.join(' ') || '(없음)'}`)
console.log(`  스레드 키    ${resolveThreadKey(email) ?? '(없음)'}`)

console.log('\n=== 첨부 ===\n')
if (email.attachments.length === 0) {
  console.log('  (없음)')
  console.log('\n  웹훅에는 첨부 메타데이터가 없을 수 있습니다.')
  console.log('  listAttachments(emailId) 로 별도 조회하세요.')
} else {
  for (const a of email.attachments) {
    const size = a.size ? `${(a.size / 1024).toFixed(0)}KB` : '크기 미상'
    console.log(`  · ${a.filename ?? '(이름 없음)'}  ${a.contentType ?? '?'}  ${size}`)
  }
  const cands = findBusinessLicenseCandidates(email.attachments)
  if (cands.length > 0) {
    console.log(`\n  판독 후보 ${cands.length}건: ${cands.map((c) => c.filename).join(', ')}`)
  }
}

console.log('\n=== 본문 ===\n')
if (email.text || email.html) {
  const preview = (email.text ?? email.html ?? '').slice(0, 200)
  console.log(`  ${preview.replace(/\n/g, '\n  ')}${preview.length >= 200 ? '…' : ''}`)
} else {
  console.log('  (없음)')
  console.log('\n  웹훅 페이로드에는 본문이 오지 않습니다 — 메타데이터만 옵니다.')
  console.log('  fetchReceivedEmail(emailId) 로 별도 조회하세요.')
}

console.log()
