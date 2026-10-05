# Standalone MCPB release contract

The portable release artifact is `chat-on-steroids-external-orchestrator-<version>.mcpb`. Version `0.1.0` targets MCPB manifest 0.3, Node.js 20 or newer, macOS, Windows and Linux, and Chat On Steroids Local Control API protocol 1.

Release packaging is plugin-local. Run `node scripts/package-mcpb.mjs` to build the deterministic unsigned bundle, `node scripts/verify-mcpb.mjs` to verify its checksum/metadata/manifest, and `node scripts/verify-reproducible.mjs` to prove two fresh builds have the same SHA-256. `release/SHA256SUMS` hashes the unsigned artifact and `release/RELEASE-METADATA.json` records its portable runtime contract.

The artifact is distributed to the external agent. It must not be copied into Chat On Steroids `extraResources`, `managed-plugins`, `distribution/lock.json`, PluginManager managed-origin state or the Chat On Steroids desktop updater. EO is built and verified independently of every native Electron package; the product release workflow may attach the already-verified standalone `.mcpb` beside the native assets and include it in the same release checksum file.
