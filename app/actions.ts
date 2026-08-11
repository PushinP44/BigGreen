'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { getDb } from '@/lib/db/client'
import { recordSimpleTransaction } from '@/lib/ledger/record'

const schema = z.object({
  accountId: z.uuid('pick an account'),
  amount: z.string().min(1, 'enter an amount'),
  direction: z.enum(['spend', 'income']),
  description: z.string().max(200).optional(),
})

export interface ActionState {
  readonly error?: string
  readonly ok?: string
}

export async function addTransaction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const parsed = schema.safeParse({
    accountId: formData.get('accountId'),
    amount: formData.get('amount'),
    direction: formData.get('direction'),
    description: formData.get('description') ?? undefined,
  })

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'invalid input' }
  }

  try {
    const db = await getDb()
    const result = await recordSimpleTransaction(db, {
      accountId: parsed.data.accountId,
      amount: parsed.data.amount,
      direction: parsed.data.direction,
      description: parsed.data.description ?? '',
    })

    revalidatePath('/')
    return {
      ok:
        result.residualMinor === 0n
          ? 'Recorded.'
          : `Recorded, with ${result.residualMinor} minor units of FX rounding.`,
    }
  } catch (error) {
    // Surfacing the real message: a swallowed error here is a wrong balance,
    // and these messages are written to be read by the person who typed the
    // amount (PLAN §12, silent-failure-hunter).
    return { error: error instanceof Error ? error.message : 'could not record that' }
  }
}
