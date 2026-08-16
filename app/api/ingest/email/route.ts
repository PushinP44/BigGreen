import { z } from 'zod'
import { getDb } from '@/lib/db/client'
import { DEV_FALLBACK_USER_ID } from '@/lib/supabase/server'
import { ingestEmail, verifySignature } from '@/lib/ingest/email'
import { loadSafetySettings } from '@/lib/read/settings'

/**
 * Receiver for the Gmail Apps Script poller.
 *
 * The HMAC is the only thing that authenticates this endpoint. The sender
 * address inside the payload proves nothing — anyone can write one, and
 * forwarded mail fails DKIM anyway — so authenticity comes from the transport
 * signature and never from the message (PLAN §11).
 */
export const dynamic = 'force-dynamic'

const schema = z.object({
  messageId: z.string().min(1).max(200),
  from: z.string().max(320),
  subject: z.string().max(500),
  body: z.string().max(100_000),
  receivedAt: z.string(),
})

export async function POST(request: Request) {
  const secret = process.env.EMAIL_INGEST_SECRET
  if (!secret) {
    // Refusing outright is deliberate: an unsigned endpoint that writes to a
    // money ledger is worse than one that does not work.
    return Response.json({ error: 'ingest is not configured' }, { status: 503 })
  }

  // The raw body, not the parsed object — the signature covers exact bytes, and
  // re-serialising JSON would change them.
  const rawBody = await request.text()

  // TEMPORARY — diagnosing a signature-mismatch report. Logs nothing
  // secret: byte/char lengths, the already-transmitted signature and
  // timestamp headers, and the server's own clock. Remove once resolved.
  console.log('[ingest-debug]', {
    bodyByteLength: Buffer.byteLength(rawBody, 'utf8'),
    bodyCharLength: rawBody.length,
    receivedTimestamp: request.headers.get('x-timestamp'),
    receivedSignature: request.headers.get('x-signature'),
    serverNowMs: Date.now(),
  })

  const verified = verifySignature(
    rawBody,
    request.headers.get('x-signature'),
    request.headers.get('x-timestamp'),
    secret,
  )
  if (!verified.ok) {
    return Response.json({ error: verified.reason }, { status: 401 })
  }

  let payload: unknown
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return Response.json({ error: 'invalid JSON' }, { status: 400 })
  }

  const parsed = schema.safeParse(payload)
  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues[0]?.message ?? 'invalid payload' },
      { status: 400 },
    )
  }

  const receivedAt = new Date(parsed.data.receivedAt)
  if (Number.isNaN(receivedAt.getTime())) {
    return Response.json({ error: 'invalid receivedAt' }, { status: 400 })
  }

  // Called by the Apps Script, not by a browser, so there is no session to
  // read. The target user comes from configuration rather than from the
  // payload — and the HMAC is what makes that safe.
  //
  // NOT MULTI-USER YET: one global secret writes to one configured account. A
  // public build needs a per-user secret, stored against the account and looked
  // up before verification, or any holder of the secret could write to anyone.
  const targetUserId = process.env.EMAIL_INGEST_USER_ID ?? DEV_FALLBACK_USER_ID

  try {
    const db = await getDb(targetUserId)
    const { settings } = await loadSafetySettings(db)

    const outcome = await ingestEmail(
      db,
      { ...parsed.data, receivedAt },
      { autoPostConfidence: settings.autoPostConfidence },
    )

    return Response.json(outcome, { status: 200 })
  } catch (error) {
    // Returned rather than swallowed: the Apps Script logs it, and a silent
    // failure here is a transaction that never reaches the ledger.
    return Response.json(
      { error: error instanceof Error ? error.message : 'ingest failed' },
      { status: 500 },
    )
  }
}
