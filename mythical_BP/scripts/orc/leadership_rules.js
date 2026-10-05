// Provisional balance values. Native attack values are in orc.json.
export const RULES = Object.freeze({
    updateTicks: 5,
    selectionRange: 24,
    shareRange: 15,
    abandonRange: 32,
    maxHeightDifference: 4,
    orderPoseTicks: 20,
    acquisitionTimeoutTicks: 60,
    markCooldownTicks: 300,
    inaccessibleTicks: 160,
    recentDamageTicks: 200,
    ramCooldownTicks: 200,
    ramMinDistance: 3,
    ramMaxDistance: 5,
    ramRetryTicks: 20,
    roarCooldownTicks: 160,
    roarRecentHurtTicks: 50,
    roarMeleeLockTicks: 50,
    roarPressureEnemies: 2,
    roarRange: 4,
});

export const CANDIDATE_TAG = 'mythicalcreatures:order_candidate';
export const ENEMY_FAMILIES = ['player', 'irongolem', 'wandering_trader', 'dwarf', 'villager', 'monster'];

export function mobileContextAllowed(variant, context) {
    return variant === 'warlord' && ['patrol', 'horde', 'advanced_horde'].includes(context)
        || variant === 'warchief' && context === 'advanced_horde';
}

export function followerEligible({ follower, mobile, sameDimension, distance, context, leaderContext, isLeader }) {
    return follower && mobile && !isLeader && sameDimension && distance <= RULES.shareRange
        && context !== 'none' && context === leaderContext;
}

export function scoreThreat({ distance, recentDamage = 0, currentAttacker = false, player = false, golem = false }) {
    return (currentAttacker ? 120 : 0) + Math.min(recentDamage, 40) * 3
        + (golem ? 55 : 0) + (player ? 40 : 0) - distance * 2;
}

export function orderInvalidReason({ alive, sameDimension, distance, inaccessibleFor }) {
    if (!alive) return 'target muerto/no válido';
    if (!sameDimension) return 'target cambió de dimensión';
    if (distance > RULES.abandonRange) return 'target fuera de 32 bloques';
    if (inaccessibleFor >= RULES.inaccessibleTicks) return 'target inaccesible durante 8 s';
    return null;
}
