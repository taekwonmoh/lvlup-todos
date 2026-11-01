import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  applyGitPush,
  deviceMerge,
  mergeDocs,
  publicDoc,
  substance
} from "../lib/merge.js";
import { rateCheck, rateFail } from "../lib/rate.js";

const T1 = "2026-10-01T00:00:00.000Z";
const T2 = "2026-10-02T00:00:00.000Z";
const T3 = "2026-10-03T00:00:00.000Z";

function item(id, updatedAt, extra) {
  return {
    id,
    text: extra && extra.text ? extra.text : id,
    list: extra && extra.list ? extra.list : "work",
    status: extra && extra.status ? extra.status : "not_started",
    updatedAt,
    notes: extra && extra.notes ? extra.notes : ""
  };
}

test("newer remote edit wins and older remote edit does not", () => {
  const local = { todos: [item("a", T2, { text: "local", notes: "L" })], deleted: {} };
  const older = mergeDocs(local, { todos: [item("a", T1, { text: "old", notes: "O" })] });
  assert.equal(older.todos[0].text, "local");
  assert.equal(older.todos[0].notes, "L");

  const newer = mergeDocs(local, { todos: [item("a", T3, { text: "remote", status: "completed", notes: "R" })] });
  assert.equal(newer.todos[0].text, "remote");
  assert.equal(newer.todos[0].status, "completed");
  assert.equal(newer.todos[0].notes, "R");
});

test("tombstone blocks an older copy and a newer edit brings the item back", () => {
  const local = { todos: [], deleted: { a: T2 } };
  const blocked = mergeDocs(local, { todos: [item("a", T1)] });
  assert.equal(blocked.todos.length, 0);
  assert.equal(blocked.deleted.a, T2);

  const back = mergeDocs(local, { todos: [item("a", T3, { text: "again" })] });
  assert.equal(back.todos.length, 1);
  assert.equal(back.todos[0].text, "again");
  assert.equal(back.deleted.a, undefined);
});

test("items that exist on only one side are kept", () => {
  const merged = mergeDocs(
    { todos: [item("local", T1)], deleted: {} },
    { todos: [item("remote", T2)], deleted: {} }
  );
  const ids = merged.todos.map((t) => t.id);
  assert.deepEqual(ids, ["remote", "local"]);
});

test("equal timestamps keep the incoming edit so a push is not dropped", () => {
  const merged = mergeDocs(
    { todos: [item("a", T1, { text: "server" })], deleted: {} },
    { todos: [item("a", T1, { text: "client" })], deleted: {} }
  );
  assert.equal(merged.todos[0].text, "client");
});

test("text match adopts the canonical id without clobbering a newer local edit", () => {
  const local = { todos: [item("phone", T2, { text: "Order pens", notes: "from phone" })], deleted: {} };
  const remote = { todos: [item("work-lvlup-pens", T1, { text: "Order pens", notes: "old" })], deleted: {} };
  const merged = mergeDocs(local, remote, { matchText: true });
  assert.equal(merged.todos.length, 1);
  assert.equal(merged.todos[0].id, "work-lvlup-pens");
  assert.equal(merged.todos[0].notes, "from phone");
  assert.equal(merged.todos[0].updatedAt, T2);
});

test("text match does not collapse two tasks when disabled", () => {
  const merged = mergeDocs(
    { todos: [item("phone", T1, { text: "Order pens" })], deleted: {} },
    { todos: [item("repo", T2, { text: "Order pens" })], deleted: {} }
  );
  assert.equal(merged.todos.length, 2);
});

test("done:true maps to completed", () => {
  const merged = mergeDocs({ todos: [], deleted: {} }, {
    todos: [{ id: "a", text: "Old", done: true, list: "personal" }]
  });
  assert.equal(merged.todos[0].status, "completed");
  assert.equal(merged.todos[0].list, "personal");
});

test("git push keeps phone-only items and applies a real delete", () => {
  const state = {
    todos: [item("a", T1), item("phone", T2, { text: "from phone" })],
    deleted: {},
    gitSha: "aaa1111",
    updatedAt: T2
  };
  const next = applyGitPush(state, {
    doc: { todos: [item("a", T1, { text: "a", status: "in_progress" })] },
    removed: [{ id: "gone", updatedAt: T1 }],
    gitSha: "bbb2222",
    now: T3
  });
  assert.equal(next.todos.find((t) => t.id === "phone").text, "from phone");
  assert.equal(next.todos.find((t) => t.id === "a").status, "in_progress");
  assert.equal(next.deleted.gone, T3);
  assert.equal(next.gitSha, "bbb2222");
});

test("git delete loses to a newer edit on the phone", () => {
  const state = {
    todos: [item("a", T3, { text: "phone won", notes: "newer" })],
    deleted: {},
    gitSha: "aaa1111"
  };
  const next = applyGitPush(state, {
    doc: { todos: [] },
    removed: [{ id: "a", updatedAt: T1 }],
    gitSha: "ccc3333",
    now: T2
  });
  assert.equal(next.todos.length, 1);
  assert.equal(next.todos[0].text, "phone won");
  assert.equal(next.deleted.a, undefined);
});

test("git delete removes an item the phone has not edited since that copy", () => {
  const state = {
    todos: [item("a", T1, { text: "same" }), item("b", T1)],
    deleted: {},
    gitSha: "aaa1111"
  };
  const next = applyGitPush(state, {
    doc: { todos: [item("b", T1)], deleted: {} },
    removed: [{ id: "a", updatedAt: T1 }],
    gitSha: "ddd4444",
    now: T2
  });
  assert.deepEqual(next.todos.map((t) => t.id), ["b"]);
  assert.ok(next.deleted.a);
});

test("a stale git file does not delete a phone item that was never in that file", () => {
  const state = {
    todos: [item("a", T1), item("phone", T2)],
    deleted: {},
    gitSha: null
  };
  const next = applyGitPush(state, {
    doc: { todos: [item("a", T1)] },
    removed: [],
    gitSha: "eee5555",
    now: T3
  });
  assert.deepEqual(next.todos.map((t) => t.id).sort(), ["a", "phone"]);
});

test("device merge does not drop the git bookmark", () => {
  const state = { todos: [item("a", T1)], deleted: {}, gitSha: "abc1234", updatedAt: T1 };
  const next = deviceMerge(state, { todos: [item("b", T2)], deleted: {} });
  assert.equal(next.gitSha, "abc1234");
  assert.equal(next.todos.length, 2);
});

test("substance ignores order", () => {
  const a = { todos: [item("a", T1), item("b", T2)], deleted: { z: T1 } };
  const b = { todos: [item("b", T2), item("a", T1)], deleted: { z: T1 } };
  assert.equal(substance(a), substance(b));
});

test("public json omits the git bookmark", () => {
  const doc = publicDoc({ todos: [item("a", T1)], deleted: {}, gitSha: "abc1234", updatedAt: T1 });
  assert.equal(doc.gitSha, undefined);
  assert.equal(doc.schemaVersion, 1);
  assert.deepEqual(Object.keys(doc.deleted), []);
});

test("current todos.json round-trips without dropping tasks", () => {
  const file = JSON.parse(readFileSync(new URL("../todos.json", import.meta.url), "utf8"));
  const once = mergeDocs({ todos: [], deleted: {} }, file, { matchText: true });
  const twice = mergeDocs(once, file, { matchText: true });
  assert.equal(once.todos.length, file.todos.length);
  assert.equal(substance(once), substance(twice));
  assert.equal(substance(once), substance(file));
  const invite = twice.todos.find((t) => t.id === "work-invite-parents-oct19");
  assert.ok(invite.notes.includes("Nov 9"));
});

test("rate limit locks after the max and resets when the window passes", () => {
  const windowMs = 1000;
  let rec = rateFail(null, 0, windowMs);
  assert.equal(rateCheck(rec, 10, 3).limited, false);
  rec = rateFail(rec, 10, windowMs);
  rec = rateFail(rec, 20, windowMs);
  assert.equal(rec.fails, 3);
  assert.equal(rateCheck(rec, 30, 3).limited, true);
  assert.equal(rateCheck(rec, 5000, 3).limited, false);
  const again = rateFail(rec, 5000, windowMs);
  assert.equal(again.fails, 1);
});
