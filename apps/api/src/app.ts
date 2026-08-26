import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { Pool } from "pg";
import { z } from "zod";
import { AppointmentService, CatalogService, SchedulingService } from "@tavo/domain";
import { DomainError, systemClock, type Clock, type TrustedTenantContext } from "@tavo/shared";
import { persistParsedWebhook } from "@tavo/orchestrator";
import { verifyMetaSignature, verifySubscription } from "@tavo/whatsapp";
import { insertSystemSecurityEvent } from "@tavo/database";
import type { AppConfig } from "./config";
import { tenantForApiKey } from "./config";

declare module "fastify" {
  interface FastifyRequest {
    tenant: TrustedTenantContext | null;
    rawBody?: Buffer;
  }
}

function mustTenant(req: FastifyRequest): TrustedTenantContext {
  if (!req.tenant) {
    throw new DomainError("UNAUTHORIZED", "Authentication required.", 401);
  }
  return req.tenant;
}

const uuid = z.string().uuid();
const hits = new Map<string, { n: number; reset: number }>();

function rateLimit(key: string, limit = 120, windowMs = 60_000) {
  const now = Date.now();
  const cur = hits.get(key);
  if (!cur || now > cur.reset) {
    hits.set(key, { n: 1, reset: now + windowMs });
    return;
  }
  cur.n += 1;
  if (cur.n > limit) {
    throw new DomainError("RATE_LIMIT", "Too many requests", 429);
  }
}

export function buildApp(
  config: AppConfig,
  pool: Pool,
  clock: Clock = systemClock,
  hooks?: { persistWebhook?: typeof persistParsedWebhook },
): FastifyInstance {
  const app = Fastify({ logger: false });
  app.addHook("preParsing", async (req, _reply, payload) => {
    if (!(req.url.startsWith("/webhooks/meta/whatsapp") && req.method === "POST")) {
      return payload;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of payload) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const buf = Buffer.concat(chunks);
    req.rawBody = buf;
    const { Readable } = await import("node:stream");
    return Readable.from(buf);
  });
  const scheduling = new SchedulingService(pool, clock);
  const catalog = new CatalogService(pool);
  const appointments = new AppointmentService(pool, scheduling, config.phones);

  app.decorateRequest("tenant", null as TrustedTenantContext | null);

  app.addHook("preHandler", async (req, reply) => {
    if (req.url === "/health" || req.url.startsWith("/webhooks/")) return;
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      return reply.code(401).send({ error: { code: "UNAUTHORIZED" } });
    }
    const key = header.slice("Bearer ".length);
    try {
      rateLimit(key);
    } catch (e) {
      if (e instanceof DomainError) {
        return reply.code(e.httpStatus).send({ error: { code: e.code, message: e.message } });
      }
      throw e;
    }
    const tenantId = tenantForApiKey(config, key);
    if (!tenantId) {
      return reply.code(401).send({ error: { code: "UNAUTHORIZED" } });
    }
    req.tenant = {
      tenantId,
      actorType: "HARNESS",
      actorId: "api-key",
    };
  });

  app.get("/health", async () => ({ ok: true }));

  app.get("/webhooks/meta/whatsapp", async (req, reply) => {
    const q = req.query as { "hub.mode"?: string; "hub.verify_token"?: string; "hub.challenge"?: string };
    const meta = config.meta;
    const result = verifySubscription(
      { mode: q["hub.mode"], token: q["hub.verify_token"], challenge: q["hub.challenge"] },
      meta.verifyToken,
    );
    if (!result.ok) return reply.code(403).send();
    return reply.type("text/plain").send(result.challenge);
  });

  app.post("/webhooks/meta/whatsapp", async (req, reply) => {
    const meta = config.meta;
    const raw = req.rawBody ?? Buffer.from("");
    const sig = typeof req.headers["x-hub-signature-256"] === "string" ? req.headers["x-hub-signature-256"] : undefined;
    if (!verifyMetaSignature(raw, sig, meta.appSecret)) {
      const c = await pool.connect();
      try {
        await insertSystemSecurityEvent(c, "webhook.signature_rejected", { reason: sig ? "mismatch" : "missing" });
      } catch {
        /* ignore */
      } finally {
        c.release();
      }
      return reply.code(403).send({ error: { code: "FORBIDDEN" } });
    }
    if (req.body && typeof req.body === "object" && (req.body as { __malformed?: boolean }).__malformed) {
      const c = await pool.connect();
      try {
        await insertSystemSecurityEvent(c, "webhook.malformed_envelope", { schema: "json" });
      } finally {
        c.release();
      }
      return reply.code(200).send({ ok: true });
    }
    try {
      const persist = hooks?.persistWebhook ?? persistParsedWebhook;
      await persist(pool, raw, req.body, meta.messages, meta.routingHmacKey);
    } catch {
      return reply.code(503).send({ error: { code: "UNAVAILABLE" } });
    }
    return reply.code(200).send({ ok: true });
  });

  app.post("/v1/staff", async (req) => {
    const body = z.object({ name: z.string().min(1) }).parse(req.body);
    const ctx = mustTenant(req);
    return catalog.createStaff(ctx, body.name);
  });

  app.post("/v1/services", async (req) => {
    const body = z
      .object({
        name: z.string().min(1),
        durationMinutes: z.number().int().positive(),
        priceMinor: z.number().int().nonnegative(),
        bufferBeforeMinutes: z.number().int().nonnegative().optional(),
        bufferAfterMinutes: z.number().int().nonnegative().optional(),
      })
      .parse(req.body);
    const ctx = mustTenant(req);
    return catalog.createService(ctx, {
      name: body.name,
      durationMinutes: body.durationMinutes,
      priceMinor: body.priceMinor,
      ...(body.bufferBeforeMinutes !== undefined
        ? { bufferBeforeMinutes: body.bufferBeforeMinutes }
        : {}),
      ...(body.bufferAfterMinutes !== undefined
        ? { bufferAfterMinutes: body.bufferAfterMinutes }
        : {}),
    });
  });

  app.post("/v1/staff/:staffId/services", async (req) => {
    const params = z.object({ staffId: uuid }).parse(req.params);
    const body = z.object({ serviceId: uuid }).parse(req.body);
    const ctx = mustTenant(req);
    await catalog.assignService(ctx, params.staffId, body.serviceId);
    return { ok: true };
  });

  app.post("/v1/staff/:staffId/working-hours", async (req) => {
    const params = z.object({ staffId: uuid }).parse(req.params);
    const body = z
      .object({
        dayOfWeek: z.number().int().min(0).max(6),
        startTime: z.string(),
        endTime: z.string(),
      })
      .parse(req.body);
    const ctx = mustTenant(req);
    await catalog.setWorkingHours(
      ctx,
      params.staffId,
      body.dayOfWeek,
      body.startTime,
      body.endTime,
    );
    return { ok: true };
  });

  app.post("/v1/staff/:staffId/breaks", async (req) => {
    const params = z.object({ staffId: uuid }).parse(req.params);
    const body = z.object({ startsAt: z.string().datetime(), endsAt: z.string().datetime() }).parse(req.body);
    const ctx = mustTenant(req);
    await catalog.addBreak(ctx, params.staffId, new Date(body.startsAt), new Date(body.endsAt));
    return { ok: true };
  });

  app.post("/v1/staff/:staffId/time-off", async (req) => {
    const params = z.object({ staffId: uuid }).parse(req.params);
    const body = z.object({ startsAt: z.string().datetime(), endsAt: z.string().datetime() }).parse(req.body);
    const ctx = mustTenant(req);
    await catalog.addTimeOff(ctx, params.staffId, new Date(body.startsAt), new Date(body.endsAt));
    return { ok: true };
  });

  app.post("/v1/availability", async (req) => {
    const body = z
      .object({
        serviceId: uuid,
        staffId: uuid.optional(),
        from: z.string().datetime(),
        to: z.string().datetime(),
        tenant_id: z.unknown().optional(),
      })
      .parse(req.body);
    const ctx = mustTenant(req);
    const slots = await scheduling.findAvailableSlots(ctx, {
      serviceId: body.serviceId,
      ...(body.staffId !== undefined ? { staffId: body.staffId } : {}),
      from: new Date(body.from),
      to: new Date(body.to),
    });
    return { slots };
  });

  app.post("/v1/appointments", async (req) => {
    const body = z
      .object({
        staffId: uuid,
        serviceId: uuid,
        startAt: z.string().datetime(),
        customerPhone: z.string().min(8),
        customerName: z.string().optional(),
        tenant_id: z.unknown().optional(),
      })
      .parse(req.body);
    const ctx = mustTenant(req);
    return appointments.create(ctx, {
      staffId: body.staffId,
      serviceId: body.serviceId,
      startAt: new Date(body.startAt),
      customerPhone: body.customerPhone,
      ...(body.customerName !== undefined ? { customerName: body.customerName } : {}),
      source: "HARNESS",
    });
  });

  app.get("/v1/appointments/:id", async (req) => {
    const params = z.object({ id: uuid }).parse(req.params);
    const ctx = mustTenant(req);
    return appointments.get(ctx, params.id);
  });

  app.post("/v1/appointments/:id/reschedule", async (req) => {
    const params = z.object({ id: uuid }).parse(req.params);
    const body = z.object({ startAt: z.string().datetime() }).parse(req.body);
    const ctx = mustTenant(req);
    return appointments.reschedule(ctx, params.id, new Date(body.startAt));
  });

  app.post("/v1/appointments/:id/cancel", async (req) => {
    const params = z.object({ id: uuid }).parse(req.params);
    const ctx = mustTenant(req);
    return appointments.cancel(ctx, params.id);
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof DomainError) {
      return reply.code(err.httpStatus).send({ error: { code: err.code, message: err.message } });
    }
    if (err instanceof z.ZodError) {
      return reply.code(400).send({ error: { code: "VALIDATION", message: err.message } });
    }
    const message = err instanceof Error ? err.message : "request error";
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: { code: "REQUEST", message } });
    }
    return reply.code(500).send({ error: { code: "INTERNAL" } });
  });

  return app;
}
