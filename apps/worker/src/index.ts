import { Pool } from "pg";
import { parseKeyring } from "@tavo/security";
import { AppointmentService, SchedulingService } from "@tavo/domain";
import { FakeAIProvider } from "@tavo/ai";
import { FakeWhatsAppProvider } from "@tavo/whatsapp";
import { InboundProcessor, startWorkerLoop } from "@tavo/orchestrator";
import { systemClock } from "@tavo/shared";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

async function main() {
  const hmacKeyring = parseKeyring(requireEnv("TAVO_PHONE_HMAC_KEYS"));
  const encryptionKeyring = parseKeyring(requireEnv("TAVO_PHONE_ENCRYPTION_KEYS"));
  const hmacWriteVersion = Number(requireEnv("TAVO_PHONE_HMAC_WRITE_VERSION"));
  const encryptionWriteVersion = Number(requireEnv("TAVO_PHONE_ENCRYPTION_WRITE_VERSION"));
  const messageKeyring = parseKeyring(requireEnv("TAVO_MESSAGE_ENCRYPTION_KEYS"));
  const messageWriteVersion = Number(requireEnv("TAVO_MESSAGE_ENCRYPTION_WRITE_VERSION"));
  const phones = {
    hmacKeyring,
    encryptionKeyring,
    hmacWriteVersion,
    encryptionWriteVersion,
  };
  const messages = { encryptionKeyring: messageKeyring, writeVersion: messageWriteVersion };
  const pool = new Pool({ connectionString: requireEnv("DATABASE_URL"), max: 8 });
  const clock = systemClock;
  const scheduling = new SchedulingService(pool, clock);
  const appointments = new AppointmentService(pool, scheduling, phones);
  const processor = new InboundProcessor(
    pool,
    clock,
    phones,
    messages,
    scheduling,
    appointments,
    new FakeAIProvider(),
  );
  const loop = startWorkerLoop({
    pool,
    processor,
    phones,
    messages,
    provider: new FakeWhatsAppProvider(),
  });
  const shutdown = () => {
    void loop.stop().then(async () => {
      await pool.end();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
