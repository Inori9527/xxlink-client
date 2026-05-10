# XXLink Design Language

This document is the shared product and visual baseline for XXLink desktop and mobile clients.

## Product Principles

- No manual config by default. Users should not need to understand protocols, ports, SNI, raw node URIs, or backend implementation details.
- The primary path is short: sign in, see account entitlement, choose a stable node preference, connect.
- The app should feel quiet, trustworthy, and professional rather than like a generic VPN skin.
- Account usage and entitlement are authoritative from the backend. Local traffic counters are only realtime/session indicators.
- Avoid sensitive or marketing-heavy language such as protocol anti-blocking details, censorship wording, airport jargon, raw VLESS/REALITY parameters, or server internals.

## Information Architecture

Use four primary surfaces:

- Connect: one-tap connection, selected node, mode, session metrics, plan usage summary.
- Nodes: preference only. Users choose city/line type; duplicate backend ports/speed variants must not appear as separate cards.
- Plan: current plan, remaining traffic, Trial public benefit claim if eligible, and a safe website entry for purchase/renewal.
- Mine: account, announcements, promo code, updates, settings, diagnostics, sign out.

Advanced pages should be moved behind Mine/Settings or hidden from the default navigation:

- Raw subscriptions/profiles.
- Connection list.
- Rules/logs/editor screens.
- API keys and developer utilities.
- Core/runtime internals.

## Visual Tokens

Core dark theme:

- App background: `#0B0C0F`
- Page background: `#0D0E11`
- Card/panel: `#191A1F`
- Soft panel: `#23242B`
- Primary text: `#F4F4F5`
- Secondary text: `#A1A1AA`
- Muted text: `#71717A`
- Primary action: `#8B5CF6`
- Primary soft: `#A78BFA`
- Success/connected: `#34D399`
- Warning: `#FCD34D`
- Error: `#F87171`
- Border: white at 6-10% opacity

Core light theme:

- App/page background: `#F4F7FB`
- Surface: `#FFFFFF`
- Border: `#D7DFEA`
- Primary text: `#172033`
- Secondary text: `#657084`
- Primary action: `#1D5FD1`
- Success: `#10A37F`
- Warning: `#D97706`
- Error: `#DC2626`

Layout rhythm:

- Desktop card radius: 18-30 px.
- Mobile card radius: 18-28 dp.
- Desktop page padding: 24-40 px.
- Mobile page padding: 16-20 dp.
- Card padding: 18-28 px/dp depending on density.
- Prefer soft borders and flat elevation; avoid heavy shadows.

## Component Patterns

### Connect Hero

- One primary action button.
- Show status in plain language: not connected, connecting, connected.
- Show selected node as city/line display name only.
- Show session counters separately from plan-cycle usage.
- Browser/global mode can be a compact segmented control.

### Node Preference List

- Filters: Auto, Free/Light, Paid.
- Rows should show display node name, short route type, state chip.
- Do not show duplicate entries for backend speed/port variants.
- Avoid protocol labels and raw endpoint details.

### Plan Dashboard

- Show current plan and remaining/used traffic from backend usage.
- Show Trial public benefit claim card only for eligible Trial users.
- Purchase/renewal opens the official dashboard instead of embedding checkout complexity.
- Data packs and future trial/experience codes should fit under the same entitlement language.

### Mine / Settings

Use grouped settings rows:

- Section heading, e.g. Professional Settings, Other.
- Row icon, title, short explanation.
- Right-side control: switch, arrow, or small entitlement label.
- Keep explanations concrete, not technical.
- Advanced settings are allowed but should be clearly labeled and not part of the main path.

Recommended setting groups:

- Professional Settings: global acceleration, launch at startup, bypass rules, diagnostics.
- Other: language, theme, update channel, change password/sign out.

### Announcements

- Startup may show only the latest important announcement.
- Users can dismiss a specific announcement permanently until a newer one is published.
- Provide an Announcement Center/history list from Mine or a top-level icon.
- Announcement detail should include title, date, body, optional safe action, and clear close action.

### Promo Codes

- Use generic entitlement wording: promo code, benefit code, redeem.
- Do not assume codes are only traffic codes. Future codes may grant traffic, plan trial, duration, or other entitlement.

## What Not To Copy

Avoid generic VPN-skin patterns:

- Large decorative world-map backgrounds.
- Anime/avatar decoration as a product identity.
- Swipe-to-connect as the main interaction.
- Aggressive plan-card marketing walls.
- Protocol badges or low-level configuration details in the default UI.

The useful patterns from competitors are:

- Clear grouped settings.
- Announcement detail plus history.
- Large, obvious primary action.
- Fewer default navigation items.

## Platform Notes

Windows desktop:

- Sidebar is acceptable, but default navigation should still map to the four primary surfaces.
- Keep refresh/rebuild as an icon action near the Connect header, not a separate subscriptions page.
- Settings can live under Mine or a compact secondary entry.

Android:

- Bottom navigation should remain Connect, Nodes, Plan, Mine.
- Avoid exposing manual config in default flows.
- Keep cards compact enough for one-hand use.

## Backend Alignment

- Plan and usage display must come from `GET /api/v1/user/usage`.
- Trial public benefit state comes from `GET /api/v1/user/public-benefit`.
- `POST /api/v1/traffic/report` is advisory heartbeat/limit check only.
- On `TRAFFIC_EXCEEDED`, disconnect and show: "今日公益流量已用完，请等待下次刷新或升级套餐".
