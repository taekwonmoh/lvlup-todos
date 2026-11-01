import { applyGitPush, deviceMerge, emptyState, publicDoc } from "../lib/merge.js";
import { rateCheck, rateFail } from "../lib/rate.js";

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 8;
const MAX_BODY = 2_000_000;
const MAX_TODOS = 2000;

function cors(res) {
  const headers = new Headers(res.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
  headers.set("Access-Control-Max-Age", "86400");
  headers.set("Cache-Control", "no-store");
  return new Response(res.body, { status: res.status, headers });
}

function json(data, status, pretty) {
  const body = pretty ? JSON.stringify(data, null, 2) + "\n" : JSON.stringify(data);
  return new Response(body, {
    status: status || 200,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}

function presented(request) {
  const header = request.headers.get("Authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : "";
}

function safeEqual(a, b) {
  const enc = new TextEncoder();
  const aa = enc.encode(String(a));
  const bb = enc.encode(String(b));
  const len = Math.max(aa.length, bb.length);
  let diff = aa.length ^ bb.length;
  for (let i = 0; i < len; i++) diff |= (aa[i] || 0) ^ (bb[i] || 0);
  return diff === 0;
}

function configured(env) {
  return !!((env.SYNC_PASSPHRASE || "").trim() && (env.SYNC_TOKEN || "").trim());
}

function authKind(env, request) {
  const got = presented(request);
  const pass = (env.SYNC_PASSPHRASE || "").trim();
  const token = (env.SYNC_TOKEN || "").trim();
  const tokenOk = !!(got && token && safeEqual(got, token));
  const passOk = !!(got && pass && safeEqual(got, pass));
  if (tokenOk) return "token";
  if (passOk) return "passphrase";
  return "no";
}

export class TodoList {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this._lock = Promise.resolve();
    this.ready = ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
      );
    });
  }

  lock(fn) {
    const run = this._lock.then(() => this.ready).then(fn);
    this._lock = run.then(() => {}, () => {});
    return run;
  }

  readJson(key) {
    const rows = this.ctx.storage.sql.exec("SELECT value FROM kv WHERE key = ?", key).toArray();
    if (!rows.length) return null;
    try {
      return JSON.parse(rows[0].value);
    } catch (e) {
      return null;
    }
  }

  writeJson(key, value) {
    this.ctx.storage.sql.exec(
      "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      JSON.stringify(value)
    );
  }

  deleteKey(key) {
    this.ctx.storage.sql.exec("DELETE FROM kv WHERE key = ?", key);
  }

  readState() {
    const saved = this.readJson("state");
    if (!saved || typeof saved !== "object") return emptyState();
    const doc = deviceMerge(emptyState(), saved);
    doc.gitSha = typeof saved.gitSha === "string" ? saved.gitSha : null;
    doc.updatedAt = typeof saved.updatedAt === "string" ? saved.updatedAt : doc.updatedAt;
    return doc;
  }

  clientIp(request) {
    return request.headers.get("CF-Connecting-IP") || "local";
  }

  async fetch(request) {
    const url = new URL(request.url);
    const kind = authKind(this.env, request);
    const ip = this.clientIp(request);
    let raw = "";
    if (request.method === "POST") {
      try {
        raw = await request.text();
      } catch (e) {
        return json({ error: "bad_request" }, 400);
      }
      if (raw.length > MAX_BODY) return json({ error: "too_large" }, 413);
    }
    if (kind === "no") {
      const limited = await this.lock(() => {
        const prev = this.readJson("rl:" + ip);
        const now = Date.now();
        if (rateCheck(prev, now, MAX_FAILS).limited) return true;
        this.writeJson("rl:" + ip, rateFail(prev, now, WINDOW_MS));
        return false;
      });
      if (limited) return json({ error: "rate_limited" }, 429);
      return json({ error: "unauthorized" }, 401);
    }

    await this.lock(() => this.deleteKey("rl:" + ip));

    if (request.method === "GET" && url.pathname === "/v1/meta") {
      if (kind !== "token") return json({ error: "unauthorized" }, 401);
      const state = await this.lock(() => this.readState());
      return json({ gitSha: state.gitSha || null });
    }

    if (request.method === "GET" && url.pathname === "/v1/list") {
      const state = await this.lock(() => this.readState());
      return json(publicDoc(state), 200, true);
    }

    if (request.method === "POST" && (url.pathname === "/v1/list" || url.pathname === "/v1/github")) {
      if (url.pathname === "/v1/github" && kind !== "token") return json({ error: "unauthorized" }, 401);
      let body;
      try {
        body = JSON.parse(raw);
      } catch (e) {
        return json({ error: "bad_request" }, 400);
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "bad_request" }, 400);

      const now = new Date().toISOString();
      const state = await this.lock(() => {
        const current = this.readState();
        let next;
        if (url.pathname === "/v1/github") {
          const wrapped = body.doc && typeof body.doc === "object" && !Array.isArray(body.doc);
          const doc = wrapped ? body.doc : body;
          const removed = wrapped && Array.isArray(body.removed) ? body.removed.slice(0, MAX_TODOS) : [];
          if (Array.isArray(doc.todos) && doc.todos.length > MAX_TODOS) {
            return { error: "too_many" };
          }
          next = applyGitPush(current, {
            doc,
            removed,
            gitSha: wrapped ? body.gitSha : current.gitSha,
            now
          });
        } else {
          if (Array.isArray(body.todos) && body.todos.length > MAX_TODOS) return { error: "too_many" };
          next = deviceMerge(current, body);
        }
        this.writeJson("state", next);
        return next;
      });
      if (state && state.error) return json({ error: state.error }, 400);
      return json(publicDoc(state), 200, true);
    }

    return json({ error: "not_found" }, 404);
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));

    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return cors(json({ ok: true, configured: configured(env) }));
    }

    if (url.pathname !== "/v1/list" && url.pathname !== "/v1/github" && url.pathname !== "/v1/meta") {
      return cors(json({ error: "not_found" }, 404));
    }

    if (!configured(env)) return cors(json({ error: "sync_not_configured" }, 503));
    if (!env.TODO_LIST) return cors(json({ error: "sync_not_configured" }, 503));

    const id = env.TODO_LIST.idFromName("mike");
    const stub = env.TODO_LIST.get(id);
    return cors(await stub.fetch(request));
  }
};
