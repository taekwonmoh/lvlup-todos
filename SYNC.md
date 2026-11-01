# There's always Moh to do — sync

Live app: https://taekwonmoh.github.io/lvlup-todos/

Mike's phone and laptop sync through a small Cloudflare Worker (see SETUP.md). The list in this repo stays the copy bots read and write. A GitHub Action merges the two.

Until the one-time setup in SETUP.md is done, the app keeps working as a local list and still merges `todos.json` on open. It cannot push device edits anywhere until that setup is finished.

## Schema (`schemaVersion`: 1)

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-10-03T15:53:00.000Z",
  "deleted": {},
  "todos": [
    {
      "id": "work-example",
      "text": "Task title",
      "list": "work",
      "status": "not_started",
      "updatedAt": "2026-10-03T15:53:00.000Z",
      "notes": ""
    }
  ]
}
```

| Field | Required | Values |
| --- | --- | --- |
| `id` | yes | Stable string. Do not reuse an id for a different task. |
| `text` | yes | Task title. |
| `list` | yes | `work` or `personal`. |
| `status` | yes | `not_started`, `in_progress`, `needs_input`, `completed`. |
| `updatedAt` | yes | ISO-8601 UTC. The newest value wins. |
| `notes` | no | String. Use `""` when empty. |
| `deleted` | no | Map of `id` → ISO time. A delete. Keep this object when you edit the file. |

Labels in the app: Not started, In progress, Needs input, Completed.

Old on-device items used `{ done: true/false }`. The app maps `done: true` → `completed` and anything else → `not_started`.

## How bots update the list

This is the same path as before: edit `todos.json` and push to `main`.

1. Pull the latest `main` first. The sync job adds tasks Mike created on his phone. A stale full-file write can drop those.
2. Change only the tasks you mean to change. Bump that task's `updatedAt` and the file's `updatedAt`.
3. To delete a task, remove it from `todos` and add `"that-id": "<current UTC time>"` under `deleted`. The time must be the same or later than the task's `updatedAt`. Leave every other `deleted` entry in place.
4. Commit and push to `main`.

Within about a minute the **Sync todos** action merges your file into the live list (newest `updatedAt` per task wins) and writes the merged file back. Mike's open devices pick that up within a few seconds. The action also runs every 5 minutes, so phone edits land in `todos.json` even when the app is closed.

Do not put a token or passphrase in the repo. Bots that only commit do not need either secret.

### Merge rules

- Match by `id`. The copy with the later `updatedAt` wins (text, list, status, notes).
- A `deleted` time wins until a strictly newer edit of that same id.
- Tasks that exist only on a device are kept. The action adds them to `todos.json`.
- Tasks that exist only in your commit are added.
- Removing an id that was in the previously synced file counts as a delete, unless a device saved a newer edit of that task after that copy.

## Direct API (optional)

The git file is enough. If a private automation already has `SYNC_TOKEN` (the GitHub secret, never the passphrase), it can merge without a commit:

```http
POST https://moh-todos.<subdomain>.workers.dev/v1/github
Authorization: Bearer <SYNC_TOKEN>
Content-Type: application/json

{
  "doc": { "schemaVersion": 1, "updatedAt": "...", "todos": [], "deleted": {} },
  "removed": [{ "id": "task-id", "updatedAt": "the updatedAt you deleted" }],
  "gitSha": "commit sha of the file you based this on, or omit"
}
```

Posting the raw list object (no `doc` wrapper) merges adds and edits only. It does not infer deletes. `GET /v1/list` with the same token returns the live list. The device passphrase is rejected on `/v1/github`.

The worker address is written to `sync-config.json` by the deploy workflow. It is not a secret. The token is.

## Device behavior

- The passphrase is typed once per device, stored only in that browser, and checked on the Worker. It is not in this repo.
- While the app is open it syncs about every 5 seconds. Opening it or coming back online syncs immediately.
- Offline edits stay in `localStorage` (`moh-todos-v3`) and merge when the device reconnects. Newest `updatedAt` per task wins.
- **Copy JSON** copies the on-device list, including `deleted`.
