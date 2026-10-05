# External Orchestrator provenance

External Orchestrator is a standalone MCPB intended to run in an external coding agent. It does not embed Chat On Steroids Core and is not a managed Chat On Steroids plugin. Chat On Steroids remains the sole owner of sessions, recorded events, input delivery and cancellation through its opt-in loopback Local Control API.

The bundle exposes exactly `cos_orchestrate` and `cos_evidence`. It discovers Local Control API endpoint and token material from the local Chat On Steroids user-data directory at runtime; release artifacts do not contain a bearer token, endpoint, user-data path, session identifier or other installation-specific secret.

The initial bundle targets Local Control API protocol 1 and Node.js 20 or newer on macOS, Windows and Linux. The unsigned `.mcpb` is assembled deterministically from the committed package lock: production dependencies are installed with lifecycle scripts disabled, build-only TypeScript outputs are omitted, native `.node` modules and symlinks are rejected, and ZIP entry order, timestamp, attributes and storage method are canonicalized. `release/SHA256SUMS` and `release/RELEASE-METADATA.json` identify the exact unsigned payload.

Trusted publisher signing, when used by a release pipeline, must operate on that already-verified unsigned payload and preserve its recorded unsigned SHA-256 as provenance. Signing credentials are never part of this repository or MCPB.
