import type { Pool } from "pg";
import {
  claimNextInboundJob,
  claimNextOutboundJob,
  getCustomer,
  getIntegration,
  getOutboundMessage,
  markOutboundAmbiguous,
  markOutboundFailed,
  markOutboundSent,
  markOutboundTransient,
  withTenant,
} from "@tavo/database";
import { decryptPhone, decryptUtf8, type PhoneCryptoConfig } from "@tavo/security";
import { OUTBOUND_MAX_ATTEMPTS, retryBackoffSeconds } from "@tavo/shared";
import {
  AmbiguousSendError,
  ClientSendError,
  TransientSendError,
  type WhatsAppProvider,
} from "@tavo/whatsapp";
import type { InboundProcessor, MessageCrypto } from "./inbound-processor";

export async function runInboundOnce(
  pool: Pool,
  workerId: string,
  processor: InboundProcessor,
): Promise<boolean> {
  const client = await pool.connect();
  let claimed: { job_id: string; tenant_id: string } | undefined;
  try {
    claimed = await claimNextInboundJob(client, workerId);
  } finally {
    client.release();
  }
  if (!claimed) return false;
  await processor.processClaimedJob(claimed.job_id, claimed.tenant_id, workerId);
  return true;
}

export async function runOutboundOnce(
  pool: Pool,
  workerId: string,
  phones: PhoneCryptoConfig,
  messages: MessageCrypto,
  provider: WhatsAppProvider,
  signal?: AbortSignal,
): Promise<boolean> {
  const claimClient = await pool.connect();
  let claimed: { outbox_id: string; tenant_id: string } | undefined;
  try {
    claimed = await claimNextOutboundJob(claimClient, workerId);
  } finally {
    claimClient.release();
  }
  if (!claimed) return false;

  const loaded = await withTenant(pool, claimed.tenant_id, async (txn) => {
    const row = await getOutboundMessage(txn, claimed!.tenant_id, claimed!.outbox_id);
    if (!row) return null;
    const customer = await getCustomer(txn, claimed!.tenant_id, row.customer_id);
    const integration = await getIntegration(txn, claimed!.tenant_id, row.integration_id);
    if (!customer || !integration) {
      await markOutboundFailed(txn, claimed!.tenant_id, row.id, "missing customer");
      return null;
    }
    const toE164 = decryptPhone(
      customer.phone_encrypted,
      phones.encryptionKeyring,
      customer.phone_encryption_key_version,
    );
    const body = decryptUtf8(
      row.body_encrypted,
      messages.encryptionKeyring,
      row.message_encryption_key_version,
    );
    return {
      id: row.id,
      phoneNumberId: integration.phone_number_id,
      toE164,
      body,
      attemptCount: row.attempt_count,
    };
  });
  if (!loaded) return true;

  try {
    const sent = await provider.sendText(
      {
        phoneNumberId: loaded.phoneNumberId,
        toE164: loaded.toE164,
        body: loaded.body,
      },
      signal,
    );
    await withTenant(pool, claimed.tenant_id, (txn) =>
      markOutboundSent(txn, claimed!.tenant_id, loaded.id, sent.providerMessageId),
    );
  } catch (e) {
    await withTenant(pool, claimed.tenant_id, async (txn) => {
      if (e instanceof AmbiguousSendError) {
        await markOutboundAmbiguous(txn, claimed!.tenant_id, loaded.id, e.message);
        return;
      }
      if (e instanceof ClientSendError) {
        await markOutboundFailed(txn, claimed!.tenant_id, loaded.id, e.message);
        return;
      }
      const msg = e instanceof Error ? e.message : "send";
      if (e instanceof TransientSendError) {
        await markOutboundTransient(
          txn,
          claimed!.tenant_id,
          loaded.id,
          msg,
          retryBackoffSeconds(loaded.attemptCount),
          OUTBOUND_MAX_ATTEMPTS,
        );
        return;
      }
      await markOutboundTransient(
        txn,
        claimed!.tenant_id,
        loaded.id,
        msg,
        retryBackoffSeconds(loaded.attemptCount),
        OUTBOUND_MAX_ATTEMPTS,
      );
    });
  }
  return true;
}
