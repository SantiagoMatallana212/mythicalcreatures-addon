# Scrapbelly

## Purpose

Scrapbelly is the Orc heavy ranged specialist.

Its combat identity is based on precision, direct impact and heavy physical force. It should feel dangerous because a successful shot is hard to avoid and strongly punishes the target, not because it creates large areas of effect.

It must remain clearly differentiated from:

- Ashgnaw: fire and terrain control.
- Bombchucker: explosive/AoE damage.
- Gobbow and other ranged units: lighter and faster ranged pressure.

## Weapon

Scrapbelly uses a custom hand cannon.

The cannon is currently an internal entity asset and is not available to players.

The custom projectile is named `cannonball` (`mythicalcreatures:cannonball`) and uses the existing `cannonball` assets.

## Ranged combat

Scrapbelly prefers ranged combat whenever its target is more than approximately 2 blocks away.

The cannon fires a custom physical projectile.

Initial design targets:

- direct impact only;
- initial damage: `8`;
- very high projectile velocity;
- very low inaccuracy;
- high horizontal knockback;
- slow firing cadence;
- visible preparation before firing;
- clear recoil/recovery after firing.

The projectile must not behave as hitscan.

The initial knockback value is a tuning parameter and should be adjusted through playtesting until the hit feels appropriately heavy.

Scrapbelly should avoid unnecessarily advancing toward a target once it has a useful firing position.

## Melee combat

At approximately 2 blocks or less, Scrapbelly switches to melee.

Its melee attack represents striking the target with the hand cannon itself.

The attack should:

- deal meaningful damage;
- apply moderate physical knockback;
- feel heavier and slower than a normal Orc melee attack.

Initial melee damage target: approximately `7`.

Exact timing and knockback remain tuning parameters.

## Combat rhythm

The intended ranged rhythm is:

target acquired  
→ cannon preparation  
→ shot  
→ recoil/recovery  
→ next preparation

The cannon should not fire rapidly.

An initial target is roughly one complete firing cycle every 4 seconds, subject to playtesting.

## Presentation

Scrapbelly requires:

- hand cannon attached correctly to the Orc;
- aiming/preparation feedback;
- firing feedback;
- recoil/recovery feedback;
- cannon-bash feedback for melee;
- visible `cannonball` projectile.

Presentation can initially reuse existing Orc locomotion where appropriate. Full audiovisual polish belongs to the later presentation phase of The Horde Awakens.

## Behavior expectations

Scrapbelly should:

- strongly prefer the cannon outside melee distance;
- use melee only when the enemy gets very close;
- remain dangerous at range through accuracy and impact rather than rate of fire;
- avoid damaging Greenskin allies through its own attack mechanics;
- integrate with the existing Orc variant system rather than becoming a separate Orc entity.

Projectile friendly fire must reuse the existing Greenskin projectile mechanism. Add infrastructure only if a test demonstrates that the existing mechanism is insufficient.

## Out of scope

This feature does not include:

- player access to the hand cannon;
- ammunition or crafting systems;
- explosive or incendiary cannonballs;
- large splash damage;
- final sound design;
- final custom Orc locomotion;
- broader Greenskin balance work.

## Done when

Scrapbelly is considered functionally complete when:

1. the hand cannon renders correctly on the Orc;
2. the `cannonball` projectile renders and travels correctly;
3. Scrapbelly reliably uses ranged combat beyond melee distance;
4. cannon shots deal direct damage and strong knockback;
5. firing has a readable preparation and recovery;
6. targets within approximately 2 blocks trigger the cannon-bash melee behavior;
7. ranged/melee transitions work reliably;
8. Greenskin friendly-fire rules remain respected;
9. the behavior works correctly after entity load/reload;
10. an in-game playtest confirms the unit feels distinct from Ashgnaw, Bombchucker and lighter ranged mobs.
