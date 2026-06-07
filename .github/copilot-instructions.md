# Copilot Instructions

Follow the organization-level HoneyDrunk Copilot guidance from `HoneyDrunk.Architecture`.

Repo-specific additions:

- Preserve the local-first and no-subscription-auth boundaries.
- Keep the TypeScript session-contract types and Rust bridge contract aligned.
- Do not add editor or terminal features to the cockpit.
- Keep CI self-contained for this mixed TypeScript/Rust repo until a shared TypeScript-native reusable workflow exists.
