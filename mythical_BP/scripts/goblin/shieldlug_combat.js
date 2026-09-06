import { system, world } from "@minecraft/server";
import { hasFamily, isGreenskin, isValidEntity } from "../greenskin/friendly_fire.js";

const DEBUG = false;
const GOBLIN_TYPE = "mythicalcreatures:goblin";
const VARIANT_PROPERTY = "mythicalcreatures:goblin_variant";
const BRAVE_PROPERTY = "mythicalcreatures:goblin_is_brave";
const ALERT_PROPERTY = "mythicalcreatures:goblin_alert";
const REFERENCE_PROPERTY = "mythicalcreatures:shieldlug_has_reference";
const HAS_TARGET_PROPERTY = "mythicalcreatures:shieldlug_has_target";
const STATE_PROPERTY = "mythicalcreatures:shieldlug_state";

const UPDATE_INTERVAL = 10; // Sólo fallback/telemetría; el motor evalúa el lifecycle.
const TARGET_SEARCH_INTERVAL = 10;
const TARGET_RANGE = 16;
const RECENT_ATTACKER_TICKS = 200;

const BLOCK_HALF_ANGLE = 60;
const BASH_FRONT_DAMAGE_MULTIPLIER = 0.55; // 45% de reducción; laterales/espalda, 0%.
// La ventana guard_recovery dura 0.3 s en el controller del BP (no hay cooldown JS).

const TARGET_FAMILIES = ["irongolem", "wandering_trader", "dwarf", "villager"];
const trackedShieldlugs = new Map();

function debug(entityId, message) {
    if (!DEBUG) return;
    const formatted = `[GOBLIN:SHIELDLUG] ${entityId} ${message}`;
    console.warn(formatted);
    try { world.sendMessage(`§e${formatted}`); } catch {}
}

function debugChange(shieldlug, state, key, value, message) {
    if (!DEBUG || state.debugValues.get(key) === value) return;
    state.debugValues.set(key, value);
    if (message) debug(shieldlug.id, typeof message === "function" ? message() : message);
}

function targetDistance(shieldlug, target) {
    try {
        if (shieldlug.dimension.id !== target.dimension.id) return Infinity;
        const a = shieldlug.location;
        const b = target.location;
        return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    } catch {
        return Infinity;
    }
}

function combatContext(shieldlug, state) {
    const target = resolveEntity(state.combatTargetId);
    const distance = targetDistance(shieldlug, target);
    return `target=${state.combatTargetId ?? "ninguno"} origen=${state.targetSource ?? "ninguno"} ` +
        `distancia=${Number.isFinite(distance) ? distance.toFixed(2) : "n/a"} ` +
        `brave=${getProperty(shieldlug, BRAVE_PROPERTY)} alert=${getProperty(shieldlug, ALERT_PROPERTY)} ` +
        `target_IA_evento=${getProperty(shieldlug, HAS_TARGET_PROPERTY)}`;
}

function waiting(shieldlug, state, reason) {
    debugChange(shieldlug, state, "waiting", reason,
        reason ? () => `espera/cancelación: ${reason}; ${combatContext(shieldlug, state)}` : undefined);
}

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

function triggerState(entity, eventName, state) {
    try {
        entity.triggerEvent(eventName);
        if (state) debugChange(entity, state, "eventError", "", undefined);
        return true;
    } catch (error) {
        if (state) debugChange(entity, state, "eventError", eventName,
            `evento ${eventName} falló: ${error}`);
        else debug(entity.id, `evento ${eventName} falló: ${error}`);
        return false;
    }
}

function horizontalDirection(from, to) {
    const x = to.x - from.x;
    const z = to.z - from.z;
    const magnitude = Math.sqrt(x * x + z * z);
    if (magnitude < 0.001) return undefined;
    return { x: x / magnitude, z: z / magnitude };
}

function horizontalDot(a, b) {
    return a.x * b.x + a.z * b.z;
}

function getHorizontalView(entity) {
    try {
        const view = entity.getViewDirection();
        return horizontalDirection({ x: 0, z: 0 }, view);
    } catch {
        return undefined;
    }
}

function getProjectileOwner(projectile) {
    try {
        return projectile?.getComponent("minecraft:projectile")?.owner;
    } catch {
        return undefined;
    }
}

function getDamageAttacker(damageSource) {
    const projectileOwner = getProjectileOwner(damageSource.damagingProjectile);
    if (isValidEntity(projectileOwner)) return projectileOwner;

    const direct = damageSource.damagingEntity;
    const directOwner = getProjectileOwner(direct);
    if (isValidEntity(directOwner)) return directOwner;
    return isValidEntity(direct) ? direct : undefined;
}

function directionToDamageOrigin(shieldlug, damageSource) {
    let shieldLocation;
    try {
        shieldLocation = shieldlug.location;
    } catch {
        return undefined;
    }

    const projectile = damageSource.damagingProjectile;
    if (isValidEntity(projectile)) {
        try {
            const fromProjectile = horizontalDirection(shieldLocation, projectile.location);
            if (fromProjectile) return fromProjectile;
        } catch {}

        try {
            const velocity = projectile.getVelocity();
            const againstVelocity = horizontalDirection(
                { x: 0, z: 0 },
                { x: -velocity.x, z: -velocity.z }
            );
            if (againstVelocity) return againstVelocity;
        } catch {}
    }

    const direct = damageSource.damagingEntity;
    if (isValidEntity(direct) && direct.id !== shieldlug.id) {
        try {
            return horizontalDirection(shieldLocation, direct.location);
        } catch {}
    }

    return undefined;
}

function isDamageableEnemy(entity, shieldlug, state, now, isNativeTarget = false) {
    if (!isValidEntity(entity) || entity.id === shieldlug.id || isGreenskin(entity)) return false;

    try {
        const health = entity.getComponent("minecraft:health");
        if (!health || health.currentValue <= 0 || entity.getComponent("minecraft:projectile")) return false;
        if (entity.typeId === "minecraft:armor_stand" || hasFamily(entity, "inanimate") || hasFamily(entity, "egg")) return false;
        if (entity.typeId === "minecraft:player") {
            const mode = entity.getGameMode();
            return mode !== "Creative" && mode !== "Spectator" && mode !== "creative" && mode !== "spectator";
        }
    } catch {
        return false;
    }

    if (TARGET_FAMILIES.some(family => hasFamily(entity, family))) return true;
    // Igual que hurt_by_target: permite represalias, pero no contra auxiliares.
    // No exigir familia "mob": centauros y otros atacantes reales del addon
    // tienen familias distintas. Los auxiliares sin familia no son candidatos.
    let hasFamilies = false;
    try { hasFamilies = entity.getComponent("minecraft:type_family")?.getTypeFamilies().length > 0; } catch {}
    return hasFamilies && (isNativeTarget ||
        (state.recentAttackerId === entity.id && now <= state.recentAttackerUntil));
}

function hasClearPath(shieldlug, target) {
    try {
        const origin = shieldlug.getHeadLocation();
        const destination = target.getHeadLocation();
        const offset = {
            x: destination.x - origin.x,
            y: destination.y - origin.y,
            z: destination.z - origin.z
        };
        const distance = Math.sqrt(offset.x * offset.x + offset.y * offset.y + offset.z * offset.z);
        if (distance < 0.001) return true;
        const direction = {
            x: offset.x / distance,
            y: offset.y / distance,
            z: offset.z / distance
        };
        return !shieldlug.dimension.getBlockFromRay(origin, direction, {
            maxDistance: Math.max(0, distance - 0.35),
            includeLiquidBlocks: false,
            includePassableBlocks: false
        });
    } catch {
        return false;
    }
}

function selectCombatTarget(shieldlug, state, target, source, reason) {
    const previousId = state.combatTargetId;
    if (previousId !== target?.id) {
        if (previousId) debug(shieldlug.id,
            `target perdido=${previousId} origen=${state.targetSource} ` +
            `última_distancia=${state.lastTargetDistance?.toFixed(2) ?? "n/a"}; ${reason}`);
        state.combatTargetId = target?.id;
        state.targetSource = source;
        if (target) debug(shieldlug.id, `target adquirido; ${combatContext(shieldlug, state)}`);
    } else if (target && state.targetSource !== source) {
        state.targetSource = source;
        debug(shieldlug.id, `cambio de origen del target; ${combatContext(shieldlug, state)}`);
    }
    if (target) state.lastTargetDistance = targetDistance(shieldlug, target);
    return target;
}

function resolveCombatTarget(shieldlug, state, now) {
    // target no está garantizado en la API estable. Nunca se le asigna un valor.
    let nativeTarget;
    let nativeStatus = "sin target legible";
    try {
        nativeTarget = shieldlug.target;
        if (nativeTarget) nativeStatus = "target legible";
    } catch {
        nativeStatus = "entity.target no disponible";
    }
    debugChange(shieldlug, state, "nativeStatus", nativeStatus, `IA: ${nativeStatus}`);
    if (isDamageableEnemy(nativeTarget, shieldlug, state, now, true) &&
        targetDistance(shieldlug, nativeTarget) <= TARGET_RANGE) {
        return selectCombatTarget(shieldlug, state, nativeTarget, "IA", "nuevo target de IA");
    }

    // Conserva el fallback válido. Sólo consulta entidades cuando hace falta;
    // distancia/vida se comprueban cada actualización y visión cada 10 ticks.
    const cached = resolveEntity(state.combatTargetId);
    const cachedValid = isDamageableEnemy(cached, shieldlug, state, now) &&
        targetDistance(shieldlug, cached) <= TARGET_RANGE;
    if (cachedValid && now < state.nextTargetSearchTick) {
        return selectCombatTarget(shieldlug, state, cached, "fallback", "IA no disponible");
    }
    if (!cachedValid) selectCombatTarget(shieldlug, state, undefined, undefined,
        "objetivo inválido, muerto, fuera de rango/dimensión o no enemigo");
    if (now < state.nextTargetSearchTick) return undefined;
    state.nextTargetSearchTick = now + TARGET_SEARCH_INTERVAL;
    if (cachedValid && hasClearPath(shieldlug, cached)) {
        return selectCombatTarget(shieldlug, state, cached, "fallback", "IA no disponible");
    }

    let nearest;
    let nearestDistance = Infinity;
    try {
        for (const candidate of shieldlug.dimension.getEntities({
            location: shieldlug.location,
            maxDistance: TARGET_RANGE
        })) {
            if (!isDamageableEnemy(candidate, shieldlug, state, now)) continue;
            const distance = targetDistance(shieldlug, candidate);
            if (distance >= nearestDistance || !hasClearPath(shieldlug, candidate)) continue;
            nearest = candidate;
            nearestDistance = distance;
        }
        debugChange(shieldlug, state, "searchError", "", undefined);
    } catch (error) {
        debugChange(shieldlug, state, "searchError", "failed", `búsqueda fallback falló: ${error}`);
    }
    return selectCombatTarget(shieldlug, state, nearest, nearest ? "fallback" : undefined,
        "sin visión u otro enemigo más adecuado");
}

function faceTarget(shieldlug, target, state) {
    // El pathfinding sigue siendo vanilla. Sólo se corrige orientación; no se
    // teletransporta ni se sustituye el target interno de la IA.
    if (state.targetSource !== "fallback") return;
    try {
        const direction = horizontalDirection(shieldlug.location, target.location);
        if (!direction) return;
        const rotation = shieldlug.getRotation();
        const yaw = Math.atan2(-direction.x, direction.z) * 180 / Math.PI;
        const delta = ((yaw - rotation.y + 540) % 360) - 180;
        if (Math.abs(delta) > 1) shieldlug.setRotation({ x: rotation.x, y: yaw });
        debugChange(shieldlug, state, "orientationError", "", undefined);
    } catch (error) {
        debugChange(shieldlug, state, "orientationError", "failed", `orientación falló: ${error}`);
    }
}

function observePhase(shieldlug, state, phase, reason) {
    if (!phase || state.lastLoggedPhase === phase) return;
    debug(shieldlug.id, `${state.lastLoggedPhase ?? "normal"} → ${phase}; ${reason}; ${combatContext(shieldlug, state)}`);
    state.lastLoggedPhase = phase;
}

function setReference(shieldlug, state, valid) {
    if (getProperty(shieldlug, REFERENCE_PROPERTY) === valid) return;
    try {
        shieldlug.setProperty(REFERENCE_PROPERTY, valid);
        debugChange(shieldlug, state, "referenceError", "", undefined);
    } catch (error) {
        debugChange(shieldlug, state, "referenceError", "failed", `error de referencia: ${error}`);
    }
}

function updateShieldlug(shieldlug, state, now) {
    if (getProperty(shieldlug, VARIANT_PROPERTY) !== "shieldlug") {
        trackedShieldlugs.delete(shieldlug.id);
        return;
    }
    if (now < state.readyTick) return;
    observePhase(shieldlug, state, getProperty(shieldlug, STATE_PROPERTY), "estado confirmado");
    const brave = getProperty(shieldlug, BRAVE_PROPERTY) === true;
    const nativeFlag = getProperty(shieldlug, HAS_TARGET_PROPERTY) === true;
    debugChange(shieldlug, state, "signals", `${brave}/${nativeFlag}`,
        () => `señales de combate; ${combatContext(shieldlug, state)}`);

    if (!brave) {
        selectCombatTarget(shieldlug, state, undefined, undefined, "bravery perdido");
        setReference(shieldlug, state, false);
        waiting(shieldlug, state, "sin bravery; huida vanilla");
        return;
    }
    const target = resolveCombatTarget(shieldlug, state, now);
    setReference(shieldlug, state, Boolean(target));
    if (!target) {
        waiting(shieldlug, state, "sin referencia enemiga válida/visible");
        return;
    }
    faceTarget(shieldlug, target, state);
    // El fallback puede levantar la guardia sin target legible. El sensor y
    // delayed_attack necesitan un target INTERNO del motor: no lo falsificamos.
    waiting(shieldlug, state, !nativeFlag && state.targetSource === "fallback" ?
        "fallback de referencia; esperando adquisición vanilla para bash" : undefined);
}

function registerShieldlug(entity, attemptsRemaining = 10) {
    if (!isValidEntity(entity) || trackedShieldlugs.has(entity.id)) return;

    const variant = getProperty(entity, VARIANT_PROPERTY);
    if (variant === "shieldlug") {
        const state = {
            lastLoggedPhase: "normal",
            readyTick: system.currentTick + 2,
            debugValues: new Map(),
            combatTargetId: undefined,
            targetSource: undefined,
            lastTargetDistance: undefined,
            guardPending: false,
            nextTargetSearchTick: system.currentTick + Math.floor(Math.random() * TARGET_SEARCH_INTERVAL),
            recentAttackerId: undefined,
            recentAttackerUntil: 0
        };
        trackedShieldlugs.set(entity.id, state);
        // Repara también entidades guardadas con el antiguo hook sobrescrito o
        // movimiento eliminado. No vuelve a aplicar equipment ni brave_behavior.
        triggerState(entity, "shieldlug_initialize", state);
        debug(entity.id, `registrado; inicializando normal y hooks de IA; ${combatContext(entity, state)}`);
        return;
    }

    if ((variant === "none" || variant === undefined) && attemptsRemaining > 0) {
        system.runTimeout(() => registerShieldlug(entity, attemptsRemaining - 1), 2);
    }
}

function scanLoadedShieldlugs() {
    for (const dimensionId of ["overworld", "nether", "the end"]) {
        try {
            const dimension = world.getDimension(dimensionId);
            for (const goblin of dimension.getEntities({ type: GOBLIN_TYPE })) registerShieldlug(goblin);
        } catch {}
    }
}

function rememberAttacker(shieldlug, state, source) {
    const attacker = getDamageAttacker(source);
    if (!isValidEntity(attacker) || attacker.id === shieldlug.id || isGreenskin(attacker)) return;
    state.recentAttackerId = attacker.id;
    state.recentAttackerUntil = system.currentTick + RECENT_ATTACKER_TICKS;
}

world.beforeEvents.entityHurt.subscribe(event => {
    const shieldlug = event.hurtEntity;
    if (event.cancel || event.damage <= 0 || shieldlug.typeId !== GOBLIN_TYPE ||
        getProperty(shieldlug, VARIANT_PROPERTY) !== "shieldlug") return;

    const state = trackedShieldlugs.get(shieldlug.id);
    const phase = getProperty(shieldlug, STATE_PROPERTY);
    // El latch sólo cubre el evento diferido: dos golpes en el mismo tick no
    // pueden aprovechar la propiedad defending aún pendiente de actualizar.
    if (state?.guardPending || (phase !== "defending" && phase !== "bashing")) return;
    const sourceDirection = directionToDamageOrigin(shieldlug, event.damageSource);
    const view = getHorizontalView(shieldlug);
    if (!sourceDirection || !view || horizontalDot(view, sourceDirection) <
        Math.cos(BLOCK_HALF_ANGLE * Math.PI / 180)) return;

    const originalDamage = event.damage;
    if (phase === "bashing") {
        event.damage *= BASH_FRONT_DAMAGE_MULTIPLIER;
        const reduced = event.damage;
        if (DEBUG) system.run(() => debug(shieldlug.id,
            `protección frontal de bash: original=${originalDamage.toFixed(2)} recibido=${reduced.toFixed(2)}`));
        return;
    }

    // Si aún no fue registrado (spawn/carga), registrarlo en contexto de escritura
    // antes de permitir bloquear. Nunca bloquear sin poder abrir la ventana.
    if (!state) {
        system.run(() => registerShieldlug(shieldlug));
        return;
    }
    event.damage = 0;
    event.cancel = true;
    state.guardPending = true;
    rememberAttacker(shieldlug, state, event.damageSource);
    const entityId = shieldlug.id;
    system.run(() => {
        const entity = resolveEntity(entityId);
        if (!isValidEntity(entity) || trackedShieldlugs.get(entityId) !== state) return;
        debug(entityId, `bloqueo frontal: original=${originalDamage.toFixed(2)} bloqueado=${originalDamage.toFixed(2)} recibido=0`);
        const phaseNow = getProperty(entity, STATE_PROPERTY);
        if (getProperty(entity, BRAVE_PROPERTY) !== true || phaseNow === "normal") {
            state.guardPending = false;
            debug(entityId, "guard_recovery cancelado: combate terminado");
            return;
        }
        triggerState(entity, "shieldlug_start_guard_recovery", state);
        // No mide recuperación ni programa su salida: eso pertenece al controller.
        // Sólo espera a que se aplique el evento, fuera de beforeEvents.
        system.runTimeout(() => { state.guardPending = false; }, 2);
    });
});

world.afterEvents.entityHurt.subscribe(event => {
    const attacker = event.damageSource.damagingEntity;
    if (isValidEntity(attacker) && attacker.typeId === GOBLIN_TYPE &&
        getProperty(attacker, VARIANT_PROPERTY) === "shieldlug" &&
        getProperty(attacker, STATE_PROPERTY) === "bashing" &&
        !event.damageSource.damagingProjectile && !isGreenskin(event.hurtEntity)) {
        debug(attacker.id, `impacto bash NATIVO target=${event.hurtEntity.id} daño=${event.damage}; knockback del component group`);
    }

    const shieldlug = event.hurtEntity;
    if (shieldlug.typeId !== GOBLIN_TYPE || getProperty(shieldlug, VARIANT_PROPERTY) !== "shieldlug") return;
    const state = trackedShieldlugs.get(shieldlug.id);
    if (state) rememberAttacker(shieldlug, state, event.damageSource);
});

// Telemetría de eventos del motor, no una segunda máquina de combate en JS.
const PHASE_EVENTS = {
    shieldlug_reset: "normal",
    shieldlug_start_defending: "defending",
    shieldlug_start_bashing: "bashing",
    shieldlug_start_guard_recovery: "guard_recovery",
    shieldlug_bash_aborted: "defending"
};
if (DEBUG) world.afterEvents.dataDrivenEntityTrigger.subscribe(({ entity, eventId }) => {
    const state = trackedShieldlugs.get(entity.id);
    if (!state) return;
    const phase = PHASE_EVENTS[eventId];
    if (phase) observePhase(entity, state, phase, eventId);
    if (eventId === "shieldlug_bash_aborted") debug(entity.id,
        "bash cancelado: delayed_attack no inició en 2 s (path/target/obstáculo)");
}, { entityTypes: [GOBLIN_TYPE], eventTypes: Object.keys(PHASE_EVENTS) });

world.afterEvents.worldLoad.subscribe(() => system.runTimeout(scanLoadedShieldlugs, 60));
world.afterEvents.entitySpawn.subscribe(({ entity }) => {
    if (entity.typeId === GOBLIN_TYPE) registerShieldlug(entity);
});
world.afterEvents.entityLoad.subscribe(({ entity }) => {
    if (entity.typeId === GOBLIN_TYPE) {
        // Un bash interrumpido por descarga no se reanuda aplicando un golpe viejo.
        trackedShieldlugs.delete(entity.id);
        registerShieldlug(entity);
    }
});
world.afterEvents.entityDie.subscribe(({ deadEntity }) => {
    if (deadEntity.typeId === GOBLIN_TYPE && trackedShieldlugs.delete(deadEntity.id)) {
        debug(deadEntity.id, "muerte; lifecycle y bash pendiente cancelados");
    }
});

system.runInterval(() => {
    const now = system.currentTick;
    for (const [entityId, state] of trackedShieldlugs) {
        const shieldlug = resolveEntity(entityId);
        if (!isValidEntity(shieldlug)) {
            trackedShieldlugs.delete(entityId);
            continue;
        }
        updateShieldlug(shieldlug, state, now);
    }
}, UPDATE_INTERVAL);
