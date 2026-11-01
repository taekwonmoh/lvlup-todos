import assert from "node:assert/strict";
import test from "node:test";
import { unstable_dev } from "wrangler";
import { substance } from "../lib/merge.js";

const PASS = "test-passphrase";
const TOKEN = "test-token-value";

async function body(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (e) {
    return text;
  }
}

test("worker merges two devices and a git push", { timeout: 90000 }, async () => {
  const worker = await unstable_dev("worker/index.js", {
    config: "wrangler.toml",
    vars: { SYNC_PASSPHRASE: PASS, SYNC_TOKEN: TOKEN },
    persist: false,
    local: true,
    ip: "127.0.0.1",
    experimental: { disableExperimentalWarning: true },
    logLevel: "error"
  });

  const auth = (token) => ({ Authorization: "Bearer " + token, "Content-Type": "application/json" });

  try {
    const health = await body(await worker.fetch("http://127.0.0.1/health"));
    assert.equal(health.ok, true);
    assert.equal(health.configured, true);

    const denied = await worker.fetch("http://127.0.0.1/v1/list");
    assert.equal(denied.status, 401);

    const wrong = await worker.fetch("http://127.0.0.1/v1/list", { headers: auth("nope") });
    assert.equal(wrong.status, 401);

    const phone = await body(await worker.fetch("http://127.0.0.1/v1/list", {
      method: "POST",
      headers: auth(PASS),
      body: JSON.stringify({
        schemaVersion: 1,
        todos: [{
          id: "phone-1",
          text: "From the phone",
          list: "personal",
          status: "not_started",
          updatedAt: "2026-11-01T12:00:00.000Z",
          notes: ""
        }],
        deleted: {}
      })
    }));
    assert.equal(phone.todos.length, 1);

    const laptopEdit = await body(await worker.fetch("http://127.0.0.1/v1/list", {
      method: "POST",
      headers: auth(PASS),
      body: JSON.stringify({
        schemaVersion: 1,
        todos: [{
          id: "phone-1",
          text: "From the phone",
          list: "personal",
          status: "completed",
          updatedAt: "2026-11-01T12:05:00.000Z",
          notes: "done on laptop"
        }],
        deleted: {}
      })
    }));
    assert.equal(laptopEdit.todos[0].status, "completed");
    assert.equal(laptopEdit.todos[0].notes, "done on laptop");

    const stalePhone = await body(await worker.fetch("http://127.0.0.1/v1/list", {
      method: "POST",
      headers: auth(PASS),
      body: JSON.stringify({
        schemaVersion: 1,
        todos: [{
          id: "phone-1",
          text: "From the phone",
          list: "personal",
          status: "not_started",
          updatedAt: "2026-11-01T12:00:00.000Z",
          notes: ""
        }],
        deleted: {}
      })
    }));
    assert.equal(stalePhone.todos[0].status, "completed");
    assert.equal(stalePhone.todos[0].notes, "done on laptop");

    const git = await body(await worker.fetch("http://127.0.0.1/v1/github", {
      method: "POST",
      headers: auth(TOKEN),
      body: JSON.stringify({
        doc: {
          schemaVersion: 1,
          updatedAt: "2026-11-01T12:06:00.000Z",
          todos: [{
            id: "bot-1",
            text: "From a bot",
            list: "work",
            status: "needs_input",
            updatedAt: "2026-11-01T12:06:00.000Z",
            notes: "via todos.json"
          }]
        },
        removed: [],
        gitSha: "abc1234def"
      })
    }));
    assert.equal(git.todos.length, 2);
    assert.equal(substance(git).includes("bot-1"), true);
    assert.equal(substance(git).includes("phone-1"), true);

    const passphraseCannotGit = await worker.fetch("http://127.0.0.1/v1/github", {
      method: "POST",
      headers: auth(PASS),
      body: JSON.stringify({ doc: { todos: [] }, removed: [{ id: "phone-1", updatedAt: "2026-11-01T12:05:00.000Z" }], gitSha: "abc1234def" })
    });
    assert.equal(passphraseCannotGit.status, 401);

    const meta = await body(await worker.fetch("http://127.0.0.1/v1/meta", { headers: auth(TOKEN) }));
    assert.equal(meta.gitSha, "abc1234def");

    const deleted = await body(await worker.fetch("http://127.0.0.1/v1/github", {
      method: "POST",
      headers: auth(TOKEN),
      body: JSON.stringify({
        doc: { todos: git.todos.filter((t) => t.id !== "bot-1"), deleted: {} },
        removed: [{ id: "bot-1", updatedAt: "2026-11-01T12:06:00.000Z" }],
        gitSha: "bbb5678eee"
      })
    }));
    assert.equal(deleted.todos.some((t) => t.id === "bot-1"), false);
    assert.ok(deleted.deleted["bot-1"]);
    assert.equal(deleted.todos.some((t) => t.id === "phone-1"), true);
  } finally {
    await worker.stop();
  }
});
