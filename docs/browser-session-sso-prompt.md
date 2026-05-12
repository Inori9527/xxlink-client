# Backend prompt: Browser session handoff

You are Codex in the XXLink backend/web worktree, not the Windows client worktree.

Task: add a safe client-to-browser login handoff for XXLink dashboard links.

Requirements:

- Add an authenticated endpoint such as `POST /api/v1/auth/browser-session`.
- The Windows client calls it with its normal `Authorization: Bearer <accessToken>` header.
- The endpoint returns an envelope with a short-lived, one-time `loginUrl`.
- `loginUrl` must be scoped to `https://xxlink.net` and expire quickly.
- Opening `loginUrl` in a browser should set the normal dashboard session cookie using `HttpOnly`, `Secure`, and `SameSite` protections, then redirect to the requested dashboard path.
- Do not include long-lived access tokens, refresh tokens, email addresses, or other sensitive user data in the URL.
- Reject unknown redirect targets; allow only dashboard paths such as `/dashboard`, `/dashboard/recharge`, and `/dashboard/orders`.
- Add tests for success, expired token, one-time reuse, invalid redirect, and unauthenticated requests.

Client integration expectation:

- The Windows client will keep opening checkout URLs through `POST /api/v1/payment/checkout`.
- Once this endpoint is deployed, the client can call it before opening generic dashboard pages.
- The client will keep a host allowlist and refuse non-HTTPS or untrusted URLs.
