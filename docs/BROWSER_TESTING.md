# Synthetic owner journey

The browser fixture uses the real Fastify API, authentication service, worker and in-memory store. Only GitHub responses, the external authorization/install screens and database/queue infrastructure are synthetic. It never connects to GitHub or reads runtime secrets. Fixture endpoints exist only in the standalone script, not in the production API.

## Automated regression

After building workspace packages, run `pnpm test:journey`. CI runs this once after the package tests. It covers one-time handoff replay rejection, installation binding, authoritative inventory, repository selection, pending import, worker import completion, activity/context results, a temporary API outage, stop tracking and logout.

This regression uses HTTP injection; it does not claim browser, PostgreSQL, GitHub-provider or network deployment coverage. Web unit tests separately exercise the actual Next.js handoff route and page rendering.

## Local browser verification

1. Build with `pnpm build`.
2. In one terminal, run `node scripts/browser-fixture.mjs` from the repository root.
3. In another, run `API_ORIGIN=http://localhost:4100 WEB_ORIGIN=http://localhost:3100 pnpm --filter @devmemoir/web exec next dev -H 127.0.0.1 -p 3100`.
4. Open `http://localhost:3100` and continue with GitHub. The isolated fixture redirects through local synthetic authorization, while the real OAuth callback and one-time handoff exchange still execute.
5. Connect the synthetic installation, select `fixture-owner/browser-demo`, and start tracking. Confirm the pending import state.
6. Open `http://localhost:4100/__fixture` in a second tab. Use **Finish synthetic import**, then refresh activity in the product tab. Confirm the commit on 2026-09-07 and PR on 2026-09-06.
7. Select **Pull requests** and apply filters; verify the commit disappears. Expand **Activity details**. Select **Project activity**; the all-owner fixture correctly produces no matches. Reset filters to recover the overview.
8. Use **Toggle activity outage** on the fixture tab. Reload the product tab; verify retry is offered, login is not, and the selected filters remain in the retry URL. Toggle the outage off and retry.
9. Stop tracking in the connection page, return home, and confirm no repository is connected. Sign out and sign back in. Use **Expire synthetic sessions**, reload, and confirm the login prompt returns.
10. Stop both processes. In-memory fixture state is discarded.

The fixture binds only to 127.0.0.1 and refuses NODE_ENV=production. Do not expose it publicly. Use localhost in the browser so the existing secure host-only session cookie works on the browser's trusted loopback origin.

## Observed evidence — 2026-09-07

The sequence above was exercised in the Codex in-app browser using a built Next.js web app. Login, installation, inventory, pending/completed import, day grouping, PR filtering, details expansion, empty context results, outage/retry, stop tracking, sign-out, sign-in and session expiry passed. The desktop timeline was visually inspected. Mobile viewport verification and a repeat on dependencies matching the frozen lockfile are still outstanding.

This is synthetic application-flow evidence, not Gate A privacy, real GitHub authentication, database recovery, or production readiness evidence.


## Mobile and deletion verification (2026-09-07)

An independent Playwright Chromium session ran against the same local synthetic
API/worker fixture and the Next.js 15.5.25 production build at 390×844. Measured
`innerWidth` and document scroll width were both 390 on the timeline and expanded
account-deletion form; there was no horizontal overflow. The full-page timeline
screenshot was visually inspected (ephemeral artifact `/tmp/devmemoir-mobile-timeline.png`).

Login, installation, repository selection, completed import and pull-request-only
filtering worked at that width. An unchecked deletion confirmation blocked form
submission and kept `/connect`; checking it and submitting reached the accurate
`/account/deletion-requested` pending screen. Returning home showed the logged-out
view and the browser reported no cookies. The automated journey separately
verifies CSRF, session rejection, denied re-login, worker purge and repeatability.

These checks use synthetic data and Chromium viewport emulation, not a physical
phone or real GitHub authorization. The earlier in-app browser viewport attempt
remains invalid evidence; the independent Chromium measurements supersede it.
