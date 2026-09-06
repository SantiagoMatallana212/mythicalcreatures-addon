import { system, world } from "@minecraft/server";

const GREEN_SKIN_FAMILY = "greenskin";
const GREEN_SKIN_PROJECTILE_TAG = "mythicalcreatures:greenskin_projectile";
const EXPLOSION_FALLBACK_TICKS = 2;
const EXPLOSION_FALLBACK_RADIUS_SQUARED = 36;

const recentGreenskinExplosions = [];

export function isValidEntity(entity) {
    try {
        const validity = entity?.isValid;
        return typeof validity === "function" ? Boolean(validity.call(entity)) : Boolean(validity);
    } catch {
        return false;
    }
}

export function hasFamily(entity, family) {
    try {
        return Boolean(entity?.getComponent("minecraft:type_family")?.hasTypeFamily(family));
    } catch {
        return false;
    }
}

export function isGreenskin(entity) {
    return hasFamily(entity, GREEN_SKIN_FAMILY);
}

function getProjectileOwner(entity) {
    try {
        return entity?.getComponent("minecraft:projectile")?.owner;
    } catch {
        return undefined;
    }
}

function isMarkedGreenskinProjectile(entity) {
    try {
        return Boolean(entity?.hasTag(GREEN_SKIN_PROJECTILE_TAG));
    } catch {
        return false;
    }
}

function comesFromGreenskin(entity) {
    if (!entity) return false;
    if (isGreenskin(entity) || isMarkedGreenskinProjectile(entity)) return true;
    return isGreenskin(getProjectileOwner(entity));
}

function markProjectileOwner(projectile, attemptsRemaining = 2) {
    if (!isValidEntity(projectile)) return;

    const owner = getProjectileOwner(projectile);
    if (isGreenskin(owner)) {
        try {
            projectile.addTag(GREEN_SKIN_PROJECTILE_TAG);
        } catch {}
        return;
    }

    if (!owner && attemptsRemaining > 0) {
        system.runTimeout(() => markProjectileOwner(projectile, attemptsRemaining - 1), 1);
    }
}

function pruneExplosionFallbacks(now) {
    while (
        recentGreenskinExplosions.length > 0 &&
        now - recentGreenskinExplosions[0].tick > EXPLOSION_FALLBACK_TICKS
    ) {
        recentGreenskinExplosions.shift();
    }
}

function isNearRecentGreenskinExplosion(entity, now) {
    pruneExplosionFallbacks(now);

    let location;
    let dimensionId;
    try {
        location = entity.location;
        dimensionId = entity.dimension.id;
    } catch {
        return false;
    }

    return recentGreenskinExplosions.some(explosion => {
        if (explosion.dimensionId !== dimensionId) return false;
        const dx = location.x - explosion.location.x;
        const dy = location.y - explosion.location.y;
        const dz = location.z - explosion.location.z;
        return dx * dx + dy * dy + dz * dz <= EXPLOSION_FALLBACK_RADIUS_SQUARED;
    });
}

function getExplosionLocation(event, source) {
    try {
        const blocks = event.getImpactedBlocks();
        if (blocks.length > 0) {
            const total = blocks.reduce((position, block) => ({
                x: position.x + block.location.x + 0.5,
                y: position.y + block.location.y + 0.5,
                z: position.z + block.location.z + 0.5
            }), { x: 0, y: 0, z: 0 });

            return {
                x: total.x / blocks.length,
                y: total.y / blocks.length,
                z: total.z / blocks.length
            };
        }
    } catch {}

    try {
        return { ...source.location };
    } catch {
        return undefined;
    }
}

world.afterEvents.entitySpawn.subscribe(({ entity }) => {
    try {
        if (entity.getComponent("minecraft:projectile")) markProjectileOwner(entity);
    } catch {}
});

world.afterEvents.entityLoad.subscribe(({ entity }) => {
    try {
        if (entity.getComponent("minecraft:projectile")) markProjectileOwner(entity);
    } catch {}
});

world.beforeEvents.explosion.subscribe(event => {
    const source = event.source;
    if (!comesFromGreenskin(source)) return;

    try {
        const location = getExplosionLocation(event, source);
        if (!location) return;
        const now = system.currentTick;
        pruneExplosionFallbacks(now);
        recentGreenskinExplosions.push({
            tick: now,
            dimensionId: event.dimension.id,
            location
        });
    } catch {}
});

world.beforeEvents.entityHurt.subscribe(event => {
    if (!isGreenskin(event.hurtEntity)) return;

    const source = event.damageSource;
    if (comesFromGreenskin(source.damagingEntity) || comesFromGreenskin(source.damagingProjectile)) {
        event.cancel = true;
        return;
    }

    const hasIdentifiableSource = Boolean(source.damagingEntity || source.damagingProjectile);
    if (
        !hasIdentifiableSource &&
        source.cause === "entityExplosion" &&
        isNearRecentGreenskinExplosion(event.hurtEntity, system.currentTick)
    ) {
        event.cancel = true;
    }
});
