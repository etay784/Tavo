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
  withTenant,
} from "@tavo/database";
import { decryptPhone, decryptUtf8, type PhoneCryptoConfig } from "@tavo/security";
import {
  AmbiguousSendError,
  ClientSendError,
  type WhatsAppProvider,
} from "@tavo/whatsapp";
import type { InboundProcessor, MessageCrypto } from "./inbound-processor";

export async function runInboundOnce(
  pool: Pool,
  workerId: string,
  processor: InboundProcessor,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    const claimed = await claimNextInboundJob(client, workerId);
    if (!claimed) return false;
    await processor.processClaimedJob(claimed.job_id, claimed.tenant_id, workerId);
    return true;
  } finally {
    client.release();
  }
}

export async function runOutboundOnce(
  pool: Pool,
  workerId: string,
  phones: PhoneCryptoConfig,
  messages: MessageCrypto,
  provider: WhatsAppProvider,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    const claimed = await claimNextOutboundJob(client, workerId);
    if (!claimed) return false;
    await withTenant(pool, claimed.tenant_id, async (txn) => {
      const row = await getOutboundMessage(txn, claimed.tenant_id, claimed.outbox_id);
      if (!row) return;
      const customer = await getCustomer(txn, claimed.tenant_id, row.customer_id);
      const integration = await getIntegration(txn, claimed.tenant_id, row.integration_id);
      if (!customer || !integration) {
        await markOutboundFailed(txn, claimed.tenant_id, row.id, "missing customer");
        return;
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
      try {
        const sent = await provider.sendText({
          phoneNumberId: integration.phone_number_id,
          toE164,
          body,
        });
        await markOutboundSent(txn, claimed.tenant_id, row.id, sent.providerMessageId);
      } catch (e) {
        if (e instanceof AmbiguousSendError) {
          await markOutboundAmbiguous(txn, claimed.tenant_id, row.id, e.message);
          return;
        }
        if (e instanceof ClientSendError) {
          await markOutboundFailed(txn, claimed.tenant_id, row.id, e.message);
          return;
        }
        throw e;
      }
    });
    return true;
  } finally {
    client.release();
  }
}
