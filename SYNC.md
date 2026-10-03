# There's always Moh to do — sync

Canonical list for the agent and the PWA.

- Live app: https://taekwonmoh.github.io/lvlup-todos/
- Canonical file: `todos.json` (repo root, served as `./todos.json`)
- The phone keeps a copy in `localStorage` key `moh-todos-v3` and merges this file on each load.

## Schema (`schemaVersion`: 1)

```json
{
  "schemaVersion": 1,
  "updatedAt": "2026-10-03T15:53:00.000Z",
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
| `updatedAt` | yes | ISO-8601 UTC. Newer value wins on merge. |
| `notes` | no | String. Omit or `""` when empty. |

Labels in the app: Not started, In progress, Needs input, Completed.

Old on-device items used `{ done: true/false }`. The app maps `done: true` → `completed` and anything else → `not_started`.

## How the agent updates the list

1. Edit `todos.json` in this repo (add, change status, set `notes`, bump that item's `updatedAt` and the file `updatedAt`).
2. Commit and push to `main`. GitHub Pages serves the file.
3. The PWA fetches `./todos.json` with a cache-bust query on load (network-first; the service worker does not precache it) and merges.

There is no backend. The PWA cannot push edits back to GitHub by itself.

## Merge rules

- Match by `id`. If ids differ but `list` + normalized `text` match, they are treated as the same task and the canonical `id` is kept.
- The copy with the later `updatedAt` wins (text, list, status, notes).
- Tasks that exist only on the device stay on the device.
- Tasks that exist only in `todos.json` are added.
- A delete on the device is a local tombstone. It sticks until `todos.json` has a newer `updatedAt` for that id (then the task comes back). To remove a task everywhere, delete it from `todos.json`.

## Device → agent

The app's **Copy JSON** button puts the current on-device list (same schema, no tombstones) on the clipboard. Paste that when the phone has tasks the repo does not.

## Status meanings for the agent

- `not_started` — not picked up
- `in_progress` — agent or Mike is doing it
- `needs_input` — blocked on a decision or detail from Mike
- `completed` — done
