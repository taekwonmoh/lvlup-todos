# Set up sync (one time)

Do this after the sync change is on the `main` branch. The app already works on the phone and the laptop the way it does today. These steps turn on two-way sync, so a change on one device shows up on the other within a few seconds (or as soon as you open it).

You need a free Cloudflare account. That is the only new account. Nothing you paste below goes into the public website.

## 1. Open Cloudflare and pick a subdomain

1. Go to [https://dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up) and create a free account (or sign in).
2. In the left sidebar, open **Workers & Pages**.
3. If it asks you to choose a workers.dev subdomain, set one and save it. Something like `taekwonmoh` is fine. The sync address will look like `https://moh-todos.taekwonmoh.workers.dev`.

## 2. Create an API token

1. Open [https://dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens).
2. Click **Create Token**.
3. Find the template **Edit Cloudflare Workers** and click **Use template**.
4. Under **Account Resources**, choose the account you just created.
5. Continue and click **Create Token**.
6. Copy the token somewhere temporary (a note you will delete). You only see it once.

If a later step says the token cannot create a Worker, edit the token and add **Account → Workers Scripts → Edit** (or **Workers Admin**), then run the workflow again.

## 3. Copy the Account ID

1. Open **Workers & Pages** again.
2. Copy the **Account ID** on the right side of that page.

## 4. Invent two secrets

- **Passphrase.** A short sentence you can type on the phone. Example: `moh does the dishes`. This is what you type once on the iPhone and once on the Mac. It is not your GitHub password.
- **Sync token.** On the Mac, open Terminal and paste this, then press Return:

  ```bash
  openssl rand -hex 24
  ```

  Copy the long string it prints. That one is only for GitHub. You never type it into the app.

## 5. Add four GitHub secrets

1. Open [https://github.com/taekwonmoh/lvlup-todos/settings/secrets/actions](https://github.com/taekwonmoh/lvlup-todos/settings/secrets/actions).
2. Click **New repository secret** four times. Use these names exactly:

| Secret name | What to paste |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | The token from step 2 |
| `CLOUDFLARE_ACCOUNT_ID` | The Account ID from step 3 |
| `SYNC_PASSPHRASE` | The sentence from step 4 |
| `SYNC_TOKEN` | The long string from step 4 |

## 6. Deploy

1. Open [https://github.com/taekwonmoh/lvlup-todos/actions](https://github.com/taekwonmoh/lvlup-todos/actions).
2. Click **Deploy sync worker** on the left.
3. Click **Run workflow**, leave the branch on `main`, and run it.
4. Wait until the run is green. The first run also writes the worker address into `sync-config.json` and publishes it with the site.

If the run is red and the log says you still need a workers.dev subdomain, do step 1 again and re-run this workflow.

Give GitHub Pages a minute, then reload the app.

## 7. Enter the passphrase on each device

1. On the iPhone, open the home-screen app. Type the passphrase and tap **Save**.
2. On the Mac, open the Dock app. Type the same passphrase and tap **Save**.

Each device remembers it. You should not have to type it again. The status line should say **Synced**.

Add a task on the phone. Within a few seconds it shows on the laptop, and the other way around. If a device is offline, the change stays there and syncs when it reconnects. The newest edit of a task wins.

The **Passphrase** button at the bottom is only there if you need to enter it again.

## What you do not do

- Do not put the API token, the sync token, or the passphrase in the website code or in `todos.json`.
- Do not rotate anything unless a secret leaks. If you change `SYNC_PASSPHRASE` or `SYNC_TOKEN`, update the GitHub secret and run **Deploy sync worker** again, then enter the new passphrase on both devices.
