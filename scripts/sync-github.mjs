// Merge todos.json with the live list and write the result back when it changed.
// Exits 0 when sync is not set up yet so the scheduled job stays green.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { substance } from "../lib/merge.js";

const token = (process.env.SYNC_TOKEN || "").trim();
let workerUrl = "";
try {
  const cfg = JSON.parse(readFileSync(new URL("../sync-config.json", import.meta.url), "utf8"));
  workerUrl = String(cfg.workerUrl || "").trim().replace(/\/$/, "");
} catch (e) {
  workerUrl = "";
}

if (!token || !workerUrl) {
  console.log("Sync is not configured yet (worker URL or SYNC_TOKEN missing). Skipping. See SETUP.md.");
  process.exit(0);
}

async function api(path, options) {
  const res = await fetch(workerUrl + path, {
    ...options,
    headers: {
      Authorization: "Bearer " + token,
      ...(options && options.body ? { "Content-Type": "application/json" } : {}),
      ...(options && options.headers ? options.headers : {})
    }
  });
  const text = await res.text();
  if (!res.ok) {
    console.error("Sync service " + path + " returned " + res.status);
    console.error(text.slice(0, 400));
    process.exit(1);
  }
  return JSON.parse(text);
}

const meta = await api("/v1/meta", { method: "GET" });
const after = JSON.parse(readFileSync(new URL("../todos.json", import.meta.url), "utf8"));
const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

let removed = [];
if (meta.gitSha) {
  try {
    const beforeRaw = execFileSync("git", ["show", meta.gitSha + ":todos.json"], { encoding: "utf8" });
    const before = JSON.parse(beforeRaw);
    const afterIds = new Set((after.todos || []).filter((t) => t && t.id).map((t) => t.id));
    for (const todo of before.todos || []) {
      if (!todo || !todo.id || afterIds.has(todo.id)) continue;
      removed.push({ id: todo.id, updatedAt: typeof todo.updatedAt === "string" ? todo.updatedAt : "" });
    }
  } catch (e) {
    console.log("Could not read the previously synced commit (" + meta.gitSha + "). Merging without inferring deletes.");
    removed = [];
  }
}

const live = await api("/v1/list", { method: "GET" });
if (removed.length === 0 && meta.gitSha === head && substance(live) === substance(after)) {
  console.log("todos.json already matches the live list.");
  process.exit(0);
}

const merged = await api("/v1/github", {
  method: "POST",
  body: JSON.stringify({ doc: after, removed, gitSha: head })
});

if (substance(merged) === substance(after)) {
  console.log("No list changes to write.");
  process.exit(0);
}

writeFileSync(new URL("../todos.json", import.meta.url), JSON.stringify(merged, null, 2) + "\n");
console.log("Updated todos.json from the live list (" + removed.length + " delete(s) inferred).");
