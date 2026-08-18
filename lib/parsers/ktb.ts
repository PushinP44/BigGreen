/**
 * Krungthai (KTB) — Thai-language PromptPay transfer notices. PLAN §7.0
 * recorded this as "push-first, no per-transaction email"; wrong, corrected
 * by the sample this parser is built from (PLAN §13).
 *
 * Unlike every other transfer notice in this codebase, KTB's template always
 * names the recipient by their own name — a real third party, never one of
 * your own accounts under a nickname. That makes this the one transfer shape
 * that is safe to record as an ordinary spend rather than routing through
 * the transfer machinery in lib/ingest/email.ts: there is no own-account
 * ambiguity to guard against here.
 *
 * Pure: no I/O, no clock.
 */

import { parseAmountInput } from '@/lib/domain/money'
import { clean, offsetDateTime } from './shared'
import type { EmailMessage, ParsedSpend, ParseResult, Parser } from './types'

const SENDER = /krungthai\.com|ktb\.co\.th/i

function isFrom(message: EmailMessage): boolean {
  return SENDER.test(message.from)
}

const SIGNAL = /พร้อมเพย์/
const AMOUNT = /จำนวนเงิน\s*:?\s*([\d,]+(?:\.\d{1,2})?)\s*บาท/
const RECIPIENT = /ไปยังบัญชีพร้อมเพย์\s*:?\s*([^\n]{2,80})/
const DATE = /วันที่ทำรายการ\s*:?\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/

function parseTransfer(message: EmailMessage): ParseResult | null {
  const text = `${message.subject}\n${message.body}`
  if (!SIGNAL.test(text)) return null

  const amountMatch = AMOUNT.exec(text)
  if (!amountMatch) return null

  let amountMinor: bigint
  try {
    amountMinor = parseAmountInput(amountMatch[1]!, 'THB').amountMinor
  } catch {
    // More decimals than THB has, or otherwise unparseable — a number we
    // cannot represent exactly is not a number to record.
    return null
  }
  if (amountMinor <= 0n) return null

  const recipient = RECIPIENT.exec(text)?.[1]
  const merchant = recipient ? clean(recipient) : null

  const dateMatch = DATE.exec(text)
  const occurredAt = dateMatch
    ? offsetDateTime(
        // Buddhist Era -> Common Era: the Thai civil calendar runs 543 years
        // ahead, and every date this template gives is in it.
        Number(dateMatch[3]) - 543,
        Number(dateMatch[2]),
        Number(dateMatch[1]),
        Number(dateMatch[4]),
        Number(dateMatch[5]),
        Number(dateMatch[6]),
        7, // Asia/Bangkok
      )
    : null

  const notes: string[] = []
  if (!merchant) notes.push('no recipient name found')

  const fields: ParsedSpend = {
    kind: 'transaction',
    amountMinor,
    currency: 'THB',
    // "คุณได้ทำรายการโอนเงิน...สำเร็จ" — you made this transfer; this
    // template has no incoming-transfer variant.
    direction: 'spend',
    merchant,
    accountLast4: null,
    occurredAt,
    description: merchant ?? 'PromptPay transfer',
  }

  return {
    parserId: 'ktb-promptpay-transfer',
    confidence: merchant ? 0.92 : 0.8,
    fields,
    notes,
  }
}

export const ktbParser: Parser = {
  id: 'ktb',

  matches(message: EmailMessage): boolean {
    return isFrom(message)
  },

  parse(message: EmailMessage): ParseResult | null {
    return parseTransfer(message)
  },
}
