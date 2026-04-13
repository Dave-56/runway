import { Transaction } from "plaid";
import { plaidClient } from "./client";
import { decrypt } from "@/lib/utils/crypto";

export interface SyncResult {
  added: Transaction[];
  modified: Transaction[];
  removed: string[];
  nextCursor: string;
}

/**
 * Incrementally sync transactions using cursor-based pagination.
 * Pass the stored cursor to get only new/modified/removed transactions since last sync.
 * Pass no cursor (or empty string) for the initial full pull.
 */
export async function syncTransactions(
  encryptedAccessToken: string,
  cursor?: string | null,
): Promise<SyncResult> {
  const accessToken = decrypt(encryptedAccessToken);
  const added: Transaction[] = [];
  const modified: Transaction[] = [];
  const removed: string[] = [];

  let hasMore = true;
  let nextCursor = cursor || "";

  while (hasMore) {
    const response = await plaidClient.transactionsSync({
      access_token: accessToken,
      cursor: nextCursor || undefined,
    });
    const data = response.data;

    added.push(...data.added);
    modified.push(...data.modified);
    removed.push(...data.removed.map((r) => r.transaction_id));

    nextCursor = data.next_cursor;
    hasMore = data.has_more;
  }

  return { added, modified, removed, nextCursor };
}
