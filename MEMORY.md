# MEMORY.md

Keep this file focused on the current operational state (approximately 50 lines or fewer).

## Current objective

- The Horde Awakens is currently completing the Greenskin roster.
- Scrapbelly T1 complete per user. T2 cannonball BP/RP implemented, schemas/references checked (official filter oneOf overlap validated directly); playtest pending. Damage 8, power 3, enemy horizontal knockback 4, Greenskin knockback 0, timeout 5 s; no vanilla runtime. Orc shooter/modes unchanged; T3–T7 pending, reuse existing projectile friendly fire.
- After the Orc roster, perform the transversal Greenskin review before moving to the Spawn Manager.

## Recently completed

- Goblin roster is functionally complete.
- Warchief is functionally complete.
- Warlord is functionally complete.
- Ashgnaw is functionally complete.

## Important current decisions

- Warlord ram uses a temporary `0.9 × 1.3` collision box because the normal Orc collision prevents reliable native `ram_attack`.
- Normal Orc collision must be restored outside the ram state.
- Ashgnaw melee knockback is currently `3`; the previous `1.5` expectation is obsolete after playtesting.
- Do not treat either value as a regression without new evidence.

## Repository state

- Latest audit found local uncommitted changes and automated expectations stale relative to validated gameplay.
- `tests/`, `diagnostics/` and `docs/` contain untracked work and should be reviewed before establishing a clean baseline.

## Technical baseline

Main BP/RP manifests now target Bedrock 26.50 (`min_engine_version: [1,26,50]`).
Stable dependencies: `@minecraft/server` 2.10.0 and `@minecraft/server-ui` 2.2.0.
Content `format_version` values remain unchanged; no schema migrations performed.
Manifest JSON, required fields, UUIDs, script entry and BP/RP dependency verified.
In-game loading and gameplay on 26.50/26.52 remain unverified.
Entity format upgrades require separate ranged-attack/projectile schema review.
Diagnostic packs retain their independent baseline.
Do not adopt 26.60 Preview/Beta APIs unless explicitly decided.

## Next

1. Review local diff and untracked files.
2. Reconcile stale tests/documentation.
3. Verify loading and gameplay on Bedrock 26.50/26.52.
4. Establish a clean working baseline.
5. Playtest cannonball render/flight/impact/timeout and Greenskin knockback/friendly fire before closing T2; Scrapbelly firing integration remains pending.

- RP declares capability `pbr`; no PBR texture/material work performed, visual validation pending.
- Herobrine remains a future feature candidate, not current roadmap work.
