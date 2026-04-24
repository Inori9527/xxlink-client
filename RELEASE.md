# Release Notes

## Version Bumps

- Small changes: `pnpm release:small`
- Medium changes: `pnpm release:medium`
- Large changes: `pnpm release:large`
- Or set an exact version: `pnpm release-version 1.2.3`

## Windows Release Flow

1. Build the installers.
2. Sign the installers:

```powershell
pnpm sign:windows-installers
```

3. Upload both `setup.exe` and matching `.sig` files to the GitHub release.
4. Publish or refresh the updater metadata release so `update.json` points at the new assets.

## Local Signing Setup

This machine uses the following user-scoped environment variables:

- `TAURI_SIGNING_PRIVATE_KEY_PATH`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

The private key should stay outside the repository.
