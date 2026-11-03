# EduPath Ai — Cloudflare Worker AI proxy (owner setup)

This Worker is the professional way EduPath's AI works live: the app never
holds the Meta API key. The app calls this Worker, the Worker checks the
signed-in user and their school, builds the fixed school prompt itself,
and calls Meta with the key from its secret store.

Cost: Cloudflare Workers free tier — $0, no card is asked for the free
tier. If Cloudflare ever asks for a card, STOP and tell Vesper — nothing
is spent without the owner's say-so.

## Owner steps (do these yourself — the key never goes in chat or code)

1. Create a free Cloudflare account with your own email at
   https://dash.cloudflare.com/sign-up (free tier, no card).
2. In the dashboard, go to **Workers & Pages -> Create Worker**.
   Give it a name (for example `edupath-ai-proxy`).
3. Open the Worker, choose **Edit code**, delete the starter code, and
   paste the ENTIRE contents of `ai-proxy.js` from this folder.
   Press **Deploy**.
4. Still in the Worker, go to **Settings -> Variables -> Add variable**
   and add a **secret** (not a plain variable) named exactly
   `META_API_KEY`. Paste the Meta API key you created on dev.meta.ai
   as its value and save. Nobody else sees this value — not Vesper,
   not the app, not any school user.
5. Send the Worker URL back to Vesper (it looks like
   `https://edupath-ai-proxy.<your-name>.workers.dev`). Send ONLY the
   URL — never the key.
6. Vesper then wires that URL into the app (one setting, `VITE_AI_PROXY_URL`)
   and ships the website, desktop app and phone app together. Until that
   wiring step, the app keeps its current safe behaviour: AI features say
   they are not set up, and manual marking still works.

## Optional, recommended later: daily cap storage

The Worker enforces a per-school daily cap of 300 AI calls, but only when
a KV binding is present. To enable it, create a KV namespace in the
dashboard (Workers & Pages -> KV) and bind it to this Worker under the
variable name `AI_CAPS` (Settings -> Variables -> KV namespace
bindings). Without the binding the Worker still works and only logs
counts — it never breaks AI for a school if the binding is missing.

## If AI spending ever looks wrong

Delete or rotate the Meta key on dev.meta.ai and update the Worker
secret in step 4. That stops all AI spending at once — no app update
or reship is needed.

## Later migration note

If a billing card ever becomes available, this same handler can move
into a Firebase Cloud Function in the `scholarmanagementapp` project
with minimal changes (same routes, same checks, same prompts). The app
side does not change: it still just calls a URL with its sign-in token.
