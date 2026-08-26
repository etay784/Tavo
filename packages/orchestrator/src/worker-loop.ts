import type { Pool } from "pg";
import type { PhoneCryptoConfig } from "@tavo/security";
import type { WhatsAppProvider } from "@tavo/whatsapp";
import type { InboundProcessor, MessageCrypto } from "./inbound-processor";
import { runInboundOnce, runOutboundOnce } from "./workers";

export type WorkerLoopOptions = {
  pool: Pool;
  processor: InboundProcessor;
  phones: PhoneCryptoConfig;
  messages: MessageCrypto;
  provider: WhatsAppProvider;
  pollMs?: number;
  instanceId?: string;
};

export function startWorkerLoop(opts: WorkerLoopOptions): { stop: () => Promise<void> } {
  const pollMs = opts.pollMs ?? 500;
  const instanceId = opts.instanceId ?? `worker-${process.pid}`;
  const ac = new AbortController();
  let stopped = false;
  let inFlight = 0;

  const loop = (async () => {
    while (!stopped) {
      const inboundId = `${instanceId}:in:${Date.now()}:${inFlight}`;
      const outboundId = `${instanceId}:out:${Date.now()}:${inFlight}`;
      inFlight += 1;
      let worked = false;
      try {
        worked = await runInboundOnce(opts.pool, inboundId, opts.processor);
        const out = await runOutboundOnce(
          opts.pool,
          outboundId,
          opts.phones,
          opts.messages,
          opts.provider,
          ac.signal,
        );
        worked = worked || out;
      } catch {
        /* next poll */
      }
      if (!worked && !stopped) {
        await new Promise((r) => setTimeout(r, pollMs));
      }
    }
  })();

  return {
    stop: async () => {
      stopped = true;
      ac.abort();
      await loop;
    },
  };
}
