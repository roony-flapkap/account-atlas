# Account Atlas

A map of a HubSpot CRM, drawn as a network: every record once, and a record on two accounts as one node joining two clusters. HubSpot is only ever read.

- `src/` is the page: its modules and HTML/CSS template. It's a static site on GitHub Pages, served under `#/` routes. It holds no data. Everything comes from the Worker, after a Google sign-in limited to one Workspace domain.
- `worker/` is the API on Cloudflare Workers:
  - sign-in and sessions;
  - a read-only SQL copy of the CRM in D1, kept current by HubSpot webhooks, a 15-minute read and a nightly re-read;
  - the walk, segments, and a live change feed;
  - a read-only SQL console.

Build:

```sh
./build.sh                  # the page
```

Secrets (HubSpot token, webhook secret, session key, account id) live in Worker secrets, never in this repo.
