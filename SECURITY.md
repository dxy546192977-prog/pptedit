# Security Policy

Please do not report security vulnerabilities in a public issue.

Use GitHub's private vulnerability reporting feature on this repository and include reproduction steps, affected files, and the expected impact. General bugs that do not expose private data or create a security boundary failure can use the public issue tracker.

PPTedit is designed for trusted local development environments. A host application's save endpoint must authenticate requests, restrict writable paths, validate revisions, and remain disabled in public production deployments unless it has an equivalent security boundary.

When a save fails or conflicts, PPTedit keeps the complete serialized HTML in that page origin's `localStorage` as a recovery draft. Do not edit sensitive documents on a shared or untrusted origin. Discard the draft from version history—or clear that origin's site data—when recovery is no longer needed.
