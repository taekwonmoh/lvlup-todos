// Shared list merge for the browser, the sync Worker, and the GitHub Action.
// Newest updatedAt wins per item. A tombstone wins until a strictly newer edit.

export const STATUSES = ["not_started", "in_progress", "needs_input", "completed"];

export function parseTime(iso) {
  const n = Date.parse(iso || "");
  return Number.isNaN(n) ? 0 : n;
}

export function normText(s) {
  return String(s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function stableId(list, text) {
  const s = list + "|" + normText(text);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return "t" + (h >>> 0).toString(36);
}

export function normalizeTodo(raw, fallbackList) {
  if (!raw || typeof raw !== "object") return null;
  const textRaw = typeof raw.text === "string" ? raw.text.trim() : "";
  if (!textRaw) return null;
  const text = textRaw.length > 5000 ? textRaw.slice(0, 5000) : textRaw;
  const list = raw.list === "work" || raw.list === "personal"
    ? raw.list
    : (fallbackList === "personal" ? "personal" : "work");
  let status = "not_started";
  if (typeof raw.status === "string" && STATUSES.indexOf(raw.status) !== -1) status = raw.status;
  else if (raw.done === true) status = "completed";
  let updatedAt = "1970-01-01T00:00:00.000Z";
  if (typeof raw.updatedAt === "string" && parseTime(raw.updatedAt)) updatedAt = raw.updatedAt;
  else if (typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt)) {
    updatedAt = new Date(raw.createdAt).toISOString();
  }
  let notes = typeof raw.notes === "string" ? raw.notes : "";
  if (notes.length > 100000) notes = notes.slice(0, 100000);
  let id = typeof raw.id === "string" ? raw.id.trim() : "";
  if (!id) id = stableId(list, text);
  if (id.length > 200) id = id.slice(0, 200);
  return { id, text, list, status, updatedAt, notes };
}

export function normalizeDeleted(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const id of Object.keys(raw)) {
    if (typeof id !== "string" || !id || id.length > 200) continue;
    const ts = raw[id];
    if (typeof ts === "string" && parseTime(ts)) out[id] = ts;
  }
  return out;
}

export function emptyState() {
  return { schemaVersion: 1, updatedAt: "", todos: [], deleted: {}, gitSha: null };
}

function newestStamp(todos, deleted, fallback) {
  let newest = "";
  for (const t of todos) {
    if (t.updatedAt > newest) newest = t.updatedAt;
  }
  for (const ts of Object.values(deleted)) {
    if (ts > newest) newest = ts;
  }
  return newest || fallback || "";
}

// base is the copy we already have. incoming is the other copy.
// New incoming ids are placed at the front so a task added on the other device
// shows up at the top, matching the Add button.
// matchText adopts the canonical id when list + title match (legacy todos.json).
export function mergeDocs(base, incoming, options) {
  const matchText = !!(options && options.matchText);
  const source = Array.isArray(base && base.todos) ? base.todos : [];
  const list = [];
  const indexById = new Map();
  for (const raw of source) {
    const todo = normalizeTodo(raw);
    if (!todo) continue;
    if (indexById.has(todo.id)) {
      const idx = indexById.get(todo.id);
      if (parseTime(todo.updatedAt) >= parseTime(list[idx].updatedAt)) list[idx] = todo;
      continue;
    }
    indexById.set(todo.id, list.length);
    list.push(todo);
  }

  const deleted = normalizeDeleted(base && base.deleted);
  const incDeleted = normalizeDeleted(incoming && incoming.deleted);
  for (const id of Object.keys(incDeleted)) {
    if (!deleted[id] || parseTime(incDeleted[id]) > parseTime(deleted[id])) deleted[id] = incDeleted[id];
  }

  const fresh = [];
  const incomingTodos = Array.isArray(incoming && incoming.todos) ? incoming.todos : [];
  for (const raw of incomingTodos) {
    const remote = normalizeTodo(raw);
    if (!remote) continue;
    const tomb = deleted[remote.id];
    if (tomb && parseTime(tomb) >= parseTime(remote.updatedAt)) continue;

    let idx = indexById.has(remote.id) ? indexById.get(remote.id) : -1;
    if (idx === -1 && matchText) {
      const key = remote.list + "|" + normText(remote.text);
      for (let i = 0; i < list.length; i++) {
        const cur = list[i];
        if (cur.list + "|" + normText(cur.text) === key) {
          idx = i;
          break;
        }
      }
    }

    if (idx === -1) {
      if (deleted[remote.id]) delete deleted[remote.id];
      fresh.push(remote);
      continue;
    }

    const local = list[idx];
    if (local.id !== remote.id) {
      const localTomb = deleted[local.id];
      if (localTomb && parseTime(localTomb) >= parseTime(remote.updatedAt)) continue;
    }

    if (parseTime(remote.updatedAt) >= parseTime(local.updatedAt)) {
      if (local.id !== remote.id) indexById.delete(local.id);
      list[idx] = remote;
      indexById.set(remote.id, idx);
      if (deleted[remote.id]) delete deleted[remote.id];
      if (local.id !== remote.id && deleted[local.id]) delete deleted[local.id];
    } else if (local.id !== remote.id) {
      if (deleted[local.id]) {
        const moved = deleted[local.id];
        delete deleted[local.id];
        if (!deleted[remote.id] || parseTime(moved) > parseTime(deleted[remote.id])) deleted[remote.id] = moved;
      }
      indexById.delete(local.id);
      local.id = remote.id;
      indexById.set(remote.id, idx);
    }
  }

  const kept = [];
  const seen = new Set();
  for (const t of fresh.concat(list)) {
    if (seen.has(t.id)) continue;
    const tomb = deleted[t.id];
    if (tomb && parseTime(tomb) >= parseTime(t.updatedAt)) continue;
    if (tomb && parseTime(t.updatedAt) > parseTime(tomb)) delete deleted[t.id];
    seen.add(t.id);
    kept.push(t);
  }

  const fallback = (incoming && incoming.updatedAt) || (base && base.updatedAt) || "";
  return {
    schemaVersion: 1,
    updatedAt: newestStamp(kept, deleted, typeof fallback === "string" ? fallback : ""),
    todos: kept,
    deleted
  };
}

export function deviceMerge(state, incoming) {
  const merged = mergeDocs(state || emptyState(), incoming || {});
  return {
    ...merged,
    gitSha: state && state.gitSha ? state.gitSha : null
  };
}

function laterStamp(now, other) {
  const nowOk = typeof now === "string" && parseTime(now);
  const otherOk = typeof other === "string" && parseTime(other);
  if (nowOk && otherOk) return parseTime(now) >= parseTime(other) ? now : other;
  if (nowOk) return now;
  if (otherOk) return other;
  return new Date().toISOString();
}

// Git push merge. `removed` lists ids the commit actually deleted (present in the
// previously synced file, absent now). Phone edits newer than that copy are kept.
// Items that were never in that file are left alone, so a stale full-file write
// does not wipe tasks that only exist on a device.
export function applyGitPush(state, input) {
  const base = state || emptyState();
  const doc = input && input.doc ? input.doc : {};
  const removed = Array.isArray(input && input.removed) ? input.removed : [];
  const now = input && input.now;
  const deleted = normalizeDeleted(base.deleted);
  const todos = Array.isArray(base.todos) ? base.todos.map((t) => ({ ...t })) : [];

  for (const rem of removed) {
    if (!rem || typeof rem.id !== "string" || !rem.id) continue;
    const cur = todos.find((t) => t.id === rem.id);
    const curAt = cur ? parseTime(cur.updatedAt) : 0;
    const remAt = parseTime(rem.updatedAt);
    if (cur && curAt > remAt) continue;
    const stamp = laterStamp(now, cur ? cur.updatedAt : rem.updatedAt);
    if (!deleted[rem.id] || parseTime(stamp) > parseTime(deleted[rem.id])) deleted[rem.id] = stamp;
  }

  const removedIds = new Set(removed.filter((r) => r && r.id).map((r) => r.id));
  const docTodos = Array.isArray(doc.todos) ? doc.todos.filter((t) => t && !removedIds.has(t.id)) : [];
  const merged = mergeDocs(
    { todos, deleted, updatedAt: base.updatedAt },
    { todos: docTodos, deleted: doc.deleted, updatedAt: doc.updatedAt }
  );

  let gitSha = base.gitSha || null;
  if (typeof input.gitSha === "string" && /^[0-9a-fA-F]{7,64}$/.test(input.gitSha)) {
    gitSha = input.gitSha;
  }

  return { ...merged, gitSha };
}

export function publicDoc(state) {
  const src = state || emptyState();
  const todos = (Array.isArray(src.todos) ? src.todos : [])
    .map((t) => normalizeTodo(t))
    .filter(Boolean)
    .map((t) => ({
      id: t.id,
      text: t.text,
      list: t.list,
      status: t.status,
      updatedAt: t.updatedAt,
      notes: t.notes || ""
    }));
  const deleted = {};
  const norm = normalizeDeleted(src.deleted);
  for (const id of Object.keys(norm).sort()) deleted[id] = norm[id];
  return {
    schemaVersion: 1,
    updatedAt: typeof src.updatedAt === "string" ? src.updatedAt : "",
    todos,
    deleted
  };
}

export function substance(doc) {
  const normalized = mergeDocs({ todos: [], deleted: {} }, doc || {});
  const todos = normalized.todos
    .map((t) => ({
      id: t.id,
      text: t.text,
      list: t.list,
      status: t.status,
      updatedAt: t.updatedAt,
      notes: t.notes || ""
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const deleted = {};
  for (const id of Object.keys(normalized.deleted).sort()) deleted[id] = normalized.deleted[id];
  return JSON.stringify({ todos, deleted });
}

export function prettyJson(doc) {
  return JSON.stringify(publicDoc(doc), null, 2) + "\n";
}
