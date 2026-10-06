# MEMORY.md

Keep this file focused on the current operational state (approximately 50 lines or fewer).

## Current objective

- The Horde Awakens is currently completing the Greenskin roster.
- Scrapbelly is functionally closed; T1–T7 complete. User confirmed all T7 in-game checks: unload/reload, /reload, world restart, identity/equipment/modes, targeting/leadership and Warlord/Ashgnaw/Shieldlug regressions, standard/Vibrant Visuals and direct-impact artillery identity. T6 friendly fire also confirmed; existing friendly_fire.js sufficed, only its regression test was added. Main automated suite: 94/94 pass; no further gameplay changes or migrations.
- T5 remains closed with its accepted limitation: recoil animation exists, but no reliable native signal currently synchronizes its entry exactly to the shot; no additional infrastructure. In-game evidence is the user's confirmation, not agent-run gameplay tests.

## Recently completed

- Goblin roster is functionally complete.
- Warchief is functionally complete.
- Warlord is functionally complete.
- Ashgnaw is functionally complete.
- Scrapbelly is functionally complete.

## Important current decisions

- Warlord ram uses a temporary `0.9 × 1.3` collision box because the normal Orc collision prevents reliable native `ram_attack`.
- Normal Orc collision must be restored outside the ram state.
- Ashgnaw melee knockback is currently `3`; the previous `1.5` expectation is obsolete after playtesting.
- Do not treat either value as a regression without new evidence.

## Repository state

- Preserve existing local Scrapbelly BP/RP changes. Ashgnaw test expectations now match horizontal knockback 3/cap 0.4 and Scrapbelly's separate bash group. Standalone ram diagnostic remains 13/14: stale expected collision 1.2×2.7 vs current probe 0.9×1.3; separate from productive Warlord tests.

## Technical baseline

Main BP/RP manifests now target Bedrock 26.50 (`min_engine_version: [1,26,50]`).
Stable dependencies: `@minecraft/server` 2.10.0 and `@minecraft/server-ui` 2.2.0.
Content `format_version` values remain unchanged; no schema migrations performed.
Manifest JSON, required fields, UUIDs, script entry and BP/RP dependency verified.
Scrapbelly persistence/reload/graphics acceptance and T6 friendly fire confirmed in-game by user.
Entity format upgrades require separate ranged-attack/projectile schema review.
Diagnostic packs retain their independent baseline.
Do not adopt 26.60 Preview/Beta APIs unless explicitly decided.

## Next

1. Review local diff and untracked files.
2. Reconcile stale tests/documentation.
3. Review any remaining addon-wide loading/gameplay coverage beyond Scrapbelly's completed acceptance.
4. Establish a clean working baseline.
5. Continue remaining Orc roster work, then perform the transversal Greenskin review before the Spawn Manager. Scrapbelly has no open tasks; its accepted recoil limitation and independent diagnostic mismatch remain recorded.

- RP declares capability `pbr`; Scrapbelly visuals in standard/Vibrant Visuals validated in-game by user.
- Herobrine remains a future feature candidate, not current roadmap work.
