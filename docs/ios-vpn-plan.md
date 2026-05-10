# XXLink iOS VPN Plan

## Product Principle

The iOS app should stay intentionally simple. The first version is a VPN client, not a desktop feature mirror.

Primary goal:

- Open the app.
- Pick a node.
- Connect or disconnect.
- Reach account, plan, and payment flows from a compact function bar.

Avoid in v1:

- Desktop-style dashboards.
- Tray/system-proxy concepts.
- Advanced profile editors on the home screen.
- Exposing core/runtime implementation details to users.

## Information Architecture

### Home

The home screen contains only the daily-use VPN controls:

- Connection button: one primary button for connect/disconnect.
- Connection status: disconnected, connecting, connected, reconnecting, error.
- Current node selector: selected node name, region, latency if available.
- Minimal traffic summary: optional, only if it does not crowd the main action.

Home should not contain plan cards, account details, payment forms, logs, profile editing, or long settings lists.

### Function Bar

Use a bottom function bar with a small number of clear destinations:

- Home: connection and node selection.
- Plans: package selection and renewal.
- Payment: checkout, payment status, payment history if needed.
- Account: user info, subscription status, device/session state.
- Settings: VPN permissions, diagnostics, logs, legal/privacy.

If space is tight, merge Payment into Plans for v1:

- Home
- Plans
- Account
- Settings

### Node Selection

Node selection should be a focused sheet, not a full dashboard:

- Search.
- Region/group filter.
- Latency badge.
- Current selection marker.
- Disabled state for unavailable nodes.

The selection action should close the sheet and return to Home.

## iOS Project Layout

```text
apps/ios/
  XXLinkApp/
    App/
    Features/
      Home/
      Nodes/
      Plans/
      Payment/
      Account/
      Settings/
    Services/
      Vpn/
      Api/
      Storage/
  PacketTunnel/
    PacketTunnelProvider.swift
  Shared/
    Models/
    AppGroup/
    Keychain/
    RuntimeConfig/
    Diagnostics/
```

Recommended identifiers:

- Main app: `com.xxlink.ios`
- Packet tunnel extension: `com.xxlink.ios.PacketTunnel`
- App Group: `group.com.xxlink.ios`

## Shared Core Boundary

Move cross-platform data and pure logic into Rust crates before binding them to iOS:

```text
crates/xxlink-core-model
crates/xxlink-core-config
crates/xxlink-core-runtime
```

Good shared candidates:

- Profile list and profile item model.
- Subscription and node API models.
- Subscription URL normalization.
- Runtime config generation.
- Log record format.
- Runtime status model.

Keep platform-specific:

- Desktop sidecar/service startup.
- System proxy/PAC.
- Tray, autostart, updater, desktop windows.
- iOS `NETunnelProviderManager`.
- iOS `NEPacketTunnelProvider`.
- App Group and Keychain access.

## Phase Plan

### Phase 0: Current Account Blocker

Apple Developer verification is not required for product planning, UI, shared models, mock VPN state, or normal API work.

It is required for full Network Extension signing, provisioning, real VPN startup on device, TestFlight, and App Store distribution.

### Phase 1: Minimal iOS Shell

Build a native iOS app shell with:

- Home screen with connect button.
- Mock VPN status.
- Node picker sheet.
- Bottom function bar.
- Plans, Payment, Account, Settings placeholder screens.
- API client using existing backend contracts.

Acceptance:

- The app can be demoed without real VPN entitlement.
- The home screen has no extra desktop concepts.

### Phase 2: Shared Models

Extract and stabilize:

- `Profile`
- `ProfileItem`
- `ProfileOption`
- `Subscription`
- `Plan`
- `Node`
- `RuntimeConfig`
- `RuntimeStatus`

Acceptance:

- Desktop keeps compiling against the old behavior.
- iOS can consume the same model shape through Swift or generated bindings.

### Phase 3: App Group Contract

Define the main app to packet tunnel storage contract:

- Selected profile.
- Selected node.
- Runtime config.
- Auth/session material location.
- Last known VPN status.
- Diagnostics/log file paths.

Acceptance:

- Main app writes a complete mock runtime config.
- Packet tunnel target can read and validate it.

### Phase 4: Packet Tunnel Skeleton

Add a minimal `NEPacketTunnelProvider` implementation:

- Read App Group config.
- Build `NEPacketTunnelNetworkSettings`.
- Report startup failure clearly if config is incomplete.
- Keep real packet forwarding behind an internal runtime interface.

Acceptance:

- Code structure is ready for entitlement-based real device testing.
- No dependency on Tauri, sidecar, desktop service, or system proxy code.

### Phase 5: Real VPN Runtime

After Apple account, App ID, App Group, and Network Extension entitlement are ready:

- Configure signing and provisioning.
- Test `saveToPreferences`.
- Test `startVPNTunnel`.
- Validate packet flow on a real device.
- Validate Wi-Fi/cellular switching.
- Measure memory and background behavior.

Acceptance:

- A real iPhone can connect, route traffic, disconnect cleanly, and recover from app relaunch.

## First Implementation Tasks

1. Create `apps/ios` skeleton.
2. Create minimal SwiftUI navigation with bottom function bar.
3. Add Home screen with connect button and node selector.
4. Add mock `VpnService`.
5. Add Shared model structs matching current API and profile concepts.
6. Draft App Group config JSON schema.
7. Start extracting Rust model crate only after the iOS screen contract is stable.
