import { system, world } from "@minecraft/server";
import { hasFamily, isGreenskin, isValidEntity } from "../greenskin/friendly_fire.js";

const GOBLIN_TYPE = "mythicalcreatures:goblin";
const VARIANT_PROPERTY = "mythicalcreatures:goblin_variant";
const BRAVE_PROPERTY = "mythicalcreatures:goblin_is_brave";
const HAS_TARGET_PROPERTY = "mythicalcreatures:firebelcher_has_target";
const STATE_PROPERTY = "mythicalcreatures:firebelcher_state";

const UPDATE_INTERVAL = 2;
// Like Hexmaw, ranged_attack drives AI; this script owns the effect cadence.
// This interval is measured start-to-start, not added after the flame finishes.
const ATTACK_INTERVAL_TICKS = 20;
const TARGET_SEARCH_INTERVAL = 10;
const ATTACK_START_RANGE = 6.5;
const PRIMING_TICKS = 10;
const PULSE_INTERVAL = 3;

const HOSTILE_FAMILIES = ["irongolem", "wandering_trader", "dwarf", "villager"];
const PULSE_PATTERNS = [
    { range: 4.8, halfAngle: 34, damage: 2, fireSeconds: 2 },
    { range: 5.6, halfAngle: 42, damage: 2, fireSeconds: 2 },
    { range: 5.1, halfAngle: 29, damage: 2, fireSeconds: 3 }
];

const trackedFirebelchers = new Map();

function getProperty(entity, property) {
    try {
        return entity.getProperty(property);
    } catch {
        return undefined;
    }
}

function resolveEntity(entityId) {
    try {
        return entityId ? world.getEntity(entityId) : undefined;
    } catch {
        return undefined;
    }
}

function isHostileTarget(entity, firebelcher) {
    if (!isValidEntity(entity) || entity.id === firebelcher.id || isGreenskin(entity)) return false;
    if (entity.typeId === "minecraft:player") return true;
    return HOSTILE_FAMILIES.some(family => hasFamily(entity, family));
}

function vectorBetween(from, to) {
    return { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z };
}

function length(vector) {
    return Math.sqrt(vector.x * vector.x + vector.y * vector.y + vector.z * vector.z);
}

function normalize(vector) {
    const magnitude = length(vector) || 1;
    return { x: vector.x / magnitude, y: vector.y / magnitude, z: vector.z / magnitude };
}

function dot(a, b) {
    return a.x * b.x + a.y * b.y + a.z * b.z;
}

function targetPoint(entity) {
    try {
        return entity.getHeadLocation();
    } catch {
        return entity.location;
    }
}

function hasClearPath(dimension, origin, direction, distance) {
    try {
        return !dimension.getBlockFromRay(origin, direction, {
            maxDistance: Math.max(0, distance - 0.35),
            includeLiquidBlocks: false,
            includePassableBlocks: false
        });
    } catch {
        return true;
    }
}

function findAttackTarget(firebelcher) {
    let candidates;
    try {
        candidates = firebelcher.dimension.getEntities({
            location: firebelcher.location,
            maxDistance: ATTACK_START_RANGE
        });
    } catch {
        return undefined;
    }

    const origin = firebelcher.getHeadLocation();
    const view = normalize(firebelcher.getViewDirection());
    const minimumFacingDot = Math.cos(75 * Math.PI / 180);
    let closest;
    let closestDistance = Infinity;

    for (const candidate of candidates) {
        if (!isHostileTarget(candidate, firebelcher)) continue;
        const offset = vectorBetween(origin, targetPoint(candidate));
        const distance = length(offset);
        if (distance <= 0 || dot(normalize(offset), view) < minimumFacingDot) continue;
        if (!hasClearPath(firebelcher.dimension, origin, normalize(offset), distance)) continue;
        if (distance < closestDistance) {
            closest = candidate;
            closestDistance = distance;
        }
    }

    return closest;
}

function isAttackTargetStillValid(firebelcher, target) {
    if (!isHostileTarget(target, firebelcher)) return false;
    const origin = firebelcher.getHeadLocation();
    const offset = vectorBetween(origin, targetPoint(target));
    const distance = length(offset);
    if (distance <= 0 || distance > ATTACK_START_RANGE + 1.5) return false;
    const direction = normalize(offset);
    return dot(direction, normalize(firebelcher.getViewDirection())) >= 0 &&
        hasClearPath(firebelcher.dimension, origin, direction, distance);
}

function spawnFlameParticles(firebelcher, origin, direction, pattern) {
    const dimension = firebelcher.dimension;
    const side = normalize({ x: -direction.z, y: 0, z: direction.x });
    const ignition = {
        x: origin.x + direction.x * 0.65,
        y: origin.y + direction.y * 0.65 - 0.08,
        z: origin.z + direction.z * 0.65
    };

    try { dimension.spawnParticle("minecraft:basic_flame_particle", ignition); } catch {}
    try { dimension.spawnParticle("minecraft:basic_smoke_particle", ignition); } catch {}

    for (let i = 0; i < 8; i++) {
        const distance = 0.7 + Math.random() * (pattern.range - 0.7);
        const lateral = (Math.random() * 2 - 1) * (0.12 + distance * 0.13);
        const vertical = (Math.random() * 2 - 0.8) * (0.08 + distance * 0.055);
        const position = {
            x: origin.x + direction.x * distance + side.x * lateral,
            y: origin.y + direction.y * distance + vertical,
            z: origin.z + direction.z * distance + side.z * lateral
        };
        const particle = i % 4 === 0 ? "minecraft:basic_smoke_particle" : "minecraft:basic_flame_particle";
        try { dimension.spawnParticle(particle, position); } catch {}
    }
}

function applyFlamePulse(firebelcher, pattern) {
    const origin = firebelcher.getHeadLocation();
    const direction = normalize(firebelcher.getViewDirection());
    const angleCos = Math.cos(pattern.halfAngle * Math.PI / 180);
    spawnFlameParticles(firebelcher, origin, direction, pattern);

    let candidates;
    try {
        candidates = firebelcher.dimension.getEntities({
            location: firebelcher.location,
            maxDistance: pattern.range + 1
        });
    } catch {
        return;
    }

    for (const candidate of candidates) {
        if (!isHostileTarget(candidate, firebelcher)) continue;
        const offset = vectorBetween(origin, targetPoint(candidate));
        const distance = length(offset);
        if (distance <= 0 || distance > pattern.range) continue;

        const targetDirection = normalize(offset);
        if (dot(targetDirection, direction) < angleCos) continue;
        if (!hasClearPath(firebelcher.dimension, origin, targetDirection, distance)) continue;

        try {
            candidate.applyDamage(pattern.damage, { cause: "fire", damagingEntity: firebelcher });
            candidate.setOnFire(pattern.fireSeconds, true);
        } catch {}
    }
}

function triggerState(entity, eventName) {
    try { entity.triggerEvent(eventName); } catch {}
}

function resetAttack(entity, state) {
    state.phase = "idle";
    state.startedTick = 0;
    state.phaseUntil = 0;
    state.targetId = undefined;
    state.pulseIndex = 0;
    state.nextPulseTick = 0;
    triggerState(entity, "firebelcher_end_attack");
}

function updateFirebelcher(firebelcher, state, now) {
    if (getProperty(firebelcher, VARIANT_PROPERTY) !== "firebelcher") {
        resetAttack(firebelcher, state);
        trackedFirebelchers.delete(firebelcher.id);
        return;
    }

    if (
        getProperty(firebelcher, BRAVE_PROPERTY) !== true ||
        getProperty(firebelcher, HAS_TARGET_PROPERTY) !== true ||
        // target_lost resets the entity state. Event properties commit on the
        // following tick, so don't mistake the pre-cast idle value for a cancel.
        (state.phase !== "idle" && now > state.startedTick &&
            getProperty(firebelcher, STATE_PROPERTY) === "idle")
    ) {
        if (state.phase !== "idle") resetAttack(firebelcher, state);
        return;
    }

    if (state.phase === "priming") {
        const target = resolveEntity(state.targetId);
        if (!isAttackTargetStillValid(firebelcher, target)) {
            resetAttack(firebelcher, state);
            return;
        }
        if (now >= state.phaseUntil) {
            state.phase = "belching";
            state.pulseIndex = 0;
            state.nextPulseTick = now;
            triggerState(firebelcher, "firebelcher_start_belching");
        }
    }

    if (state.phase === "belching" && now >= state.nextPulseTick) {
        applyFlamePulse(firebelcher, PULSE_PATTERNS[state.pulseIndex]);
        state.pulseIndex++;

        if (state.pulseIndex >= PULSE_PATTERNS.length) {
            resetAttack(firebelcher, state);
        } else {
            state.nextPulseTick = now + PULSE_INTERVAL;
        }
        return;
    }

    if (state.phase !== "idle" || now < state.nextAttackTick || now < state.nextSearchTick) return;
    state.nextSearchTick = now + TARGET_SEARCH_INTERVAL;

    const target = findAttackTarget(firebelcher);
    if (!target) return;

    state.phase = "priming";
    state.startedTick = now;
    state.phaseUntil = now + PRIMING_TICKS;
    state.nextAttackTick = now + ATTACK_INTERVAL_TICKS;
    state.targetId = target.id;
    triggerState(firebelcher, "firebelcher_start_priming");
}

function registerFirebelcher(entity, attemptsRemaining = 10) {
    if (!isValidEntity(entity) || trackedFirebelchers.has(entity.id)) return;

    const variant = getProperty(entity, VARIANT_PROPERTY);
    if (variant === "firebelcher") {
        trackedFirebelchers.set(entity.id, {
            phase: "idle",
            startedTick: 0,
            phaseUntil: 0,
            nextAttackTick: system.currentTick + UPDATE_INTERVAL,
            nextSearchTick: 0,
            nextPulseTick: 0,
            pulseIndex: 0,
            targetId: undefined
        });
        // Migrate loaded Firebelchers out of goblin_angry, then restore only
        // their acquisition hook and actual target flag. Do not re-add ranged AI.
        triggerState(entity, "firebelcher_initialize");
        return;
    }

    if ((variant === "none" || variant === undefined) && attemptsRemaining > 0) {
        system.runTimeout(() => registerFirebelcher(entity, attemptsRemaining - 1), 2);
    }
}

function scanLoadedFirebelchers() {
    for (const dimensionId of ["overworld", "nether", "the end"]) {
        try {
            const dimension = world.getDimension(dimensionId);
            for (const goblin of dimension.getEntities({ type: GOBLIN_TYPE })) registerFirebelcher(goblin);
        } catch {}
    }
}

world.afterEvents.worldLoad.subscribe(() => system.runTimeout(scanLoadedFirebelchers, 60));
world.afterEvents.entitySpawn.subscribe(({ entity }) => {
    if (entity.typeId === GOBLIN_TYPE) registerFirebelcher(entity);
});
world.afterEvents.entityLoad.subscribe(({ entity }) => {
    if (entity.typeId === GOBLIN_TYPE) {
        trackedFirebelchers.delete(entity.id);
        registerFirebelcher(entity);
    }
});
world.afterEvents.entityDie.subscribe(({ deadEntity }) => {
    if (deadEntity.typeId === GOBLIN_TYPE) trackedFirebelchers.delete(deadEntity.id);
});

system.runInterval(() => {
    const now = system.currentTick;
    for (const [entityId, state] of trackedFirebelchers) {
        const firebelcher = resolveEntity(entityId);
        if (!isValidEntity(firebelcher)) {
            trackedFirebelchers.delete(entityId);
            continue;
        }
        updateFirebelcher(firebelcher, state, now);
    }
}, UPDATE_INTERVAL);
