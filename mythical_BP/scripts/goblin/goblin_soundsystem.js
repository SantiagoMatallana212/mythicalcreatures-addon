import { world, system } from "@minecraft/server";
import { debug } from "./goblin_debug.js";

const SOUND_SETTINGS = {
    drumhowla: { sound: "mob.goblin.drumhowla", interval: 40, maxLoops: 5 },
    hornshriek: { sound: "mob.goblin.hornshriek", interval: 240, maxLoops: 3 }
};

const MAX_SETUP_ATTEMPTS = 10;
const SETUP_RETRY_DELAY = 10;

// Un registro controla el monitor de estado y el otro exclusivamente la reproducción.
const monitoredGoblins = new Map();
const activeSoundLoops = new Map();
const pendingSetups = new Set();

function getEntityProperty(entity, propertyName) {
    try {
        return entity?.getProperty(propertyName) ?? null;
    } catch (error) {
        debug("SOUND", `No se pudo leer ${propertyName} de ${entity?.id}: ${error}`);
        return null;
    }
}

function canResolveEntity(entityId) {
    try {
        return Boolean(entityId && world.getEntity(entityId));
    } catch {
        return false;
    }
}

function isEntityValid(entity) {
    return canResolveEntity(entity?.id);
}

function stopSoundLoop(entityId, reason) {
    const soundData = activeSoundLoops.get(entityId);
    if (!soundData) return;

    system.clearRun(soundData.intervalId);
    activeSoundLoops.delete(entityId);
    debug("SOUND", `${entityId} detuvo ${soundData.variant}: ${reason}`);
}

function cleanupGoblin(entityId, reason) {
    pendingSetups.delete(entityId);
    stopSoundLoop(entityId, reason);

    const monitorData = monitoredGoblins.get(entityId);
    if (monitorData) {
        system.clearRun(monitorData.intervalId);
        monitoredGoblins.delete(entityId);
        debug("SOUND", `${entityId} liberó su monitor: ${reason}`);
    }
}

function startSoundLoop(entity, variant) {
    if (!isEntityValid(entity) || activeSoundLoops.has(entity.id)) return;

    const settings = SOUND_SETTINGS[variant];
    if (!settings) return;

    let loops = 0;
    const soundLoop = () => {
        if (!isEntityValid(entity)) {
            cleanupGoblin(entity.id, "entidad descargada o eliminada");
            return;
        }

        try {
            const isAlerting = getEntityProperty(entity, "mythicalcreatures:goblin_alert") === "alerting";
            if (!isAlerting || loops >= settings.maxLoops) {
                stopSoundLoop(entity.id, isAlerting ? "ciclo completado" : "estado calmado");
                return;
            }

            entity.dimension.playSound(settings.sound, entity.location, {
                volume: 1.0,
                pitch: 1.0
            });
            loops++;
        } catch (error) {
            debug("SOUND", `Error reproduciendo ${settings.sound} para ${entity.id}: ${error}`);
            stopSoundLoop(entity.id, "error de reproducción");
        }
    };

    const intervalId = system.runInterval(soundLoop, settings.interval);
    activeSoundLoops.set(entity.id, { intervalId, variant });
    debug("SOUND", `${entity.id} inició ${variant}`);
    soundLoop();
}

function setupGoblinSoundSystem(entity, initialVariant) {
    if (!isEntityValid(entity) || monitoredGoblins.has(entity.id)) {
        pendingSetups.delete(entity?.id);
        return;
    }

    const intervalId = system.runInterval(() => {
        if (!isEntityValid(entity)) {
            cleanupGoblin(entity.id, "entidad descargada o eliminada");
            return;
        }

        const currentVariant = getEntityProperty(entity, "mythicalcreatures:goblin_variant") ?? initialVariant;
        const isAlerting = getEntityProperty(entity, "mythicalcreatures:goblin_alert") === "alerting";
        const hasSound = Boolean(SOUND_SETTINGS[currentVariant]);
        const activeSound = activeSoundLoops.get(entity.id);

        if (isAlerting && hasSound) {
            if (activeSound && activeSound.variant !== currentVariant) {
                stopSoundLoop(entity.id, "cambio de variante");
            }
            startSoundLoop(entity, currentVariant);
        } else {
            stopSoundLoop(entity.id, hasSound ? "estado calmado" : "variante sin sonido");
        }
    }, 15);

    monitoredGoblins.set(entity.id, { intervalId });
    pendingSetups.delete(entity.id);
    debug("SOUND", `${entity.id} registrado como ${initialVariant}`);
}

function setupGoblinWithRetry(entity, attempt = 1) {
    const entityId = entity?.id;
    if (!entityId || monitoredGoblins.has(entityId)) return;

    if (attempt > MAX_SETUP_ATTEMPTS) {
        pendingSetups.delete(entityId);
        debug("SOUND", `${entityId} agotó los reintentos de configuración`);
        return;
    }

    pendingSetups.add(entityId);
    system.runTimeout(() => {
        if (monitoredGoblins.has(entityId)) {
            pendingSetups.delete(entityId);
            return;
        }
        if (!isEntityValid(entity)) {
            pendingSetups.delete(entityId);
            return;
        }

        const variant = getEntityProperty(entity, "mythicalcreatures:goblin_variant");
        if (variant !== null) {
            setupGoblinSoundSystem(entity, variant);
        } else {
            setupGoblinWithRetry(entity, attempt + 1);
        }
    }, SETUP_RETRY_DELAY);
}

function scanForExistingGoblins() {
    for (const dimensionId of ["overworld", "nether", "the end"]) {
        try {
            const dimension = world.getDimension(dimensionId);
            for (const goblin of dimension.getEntities({ type: "mythicalcreatures:goblin" })) {
                if (!monitoredGoblins.has(goblin.id) && !pendingSetups.has(goblin.id)) {
                    setupGoblinWithRetry(goblin);
                }
            }
        } catch (error) {
            debug("SOUND", `Error escaneando ${dimensionId}: ${error}`);
        }
    }
}

let worldFullyLoaded = false;
world.afterEvents.worldLoad.subscribe(() => {
    system.runTimeout(() => {
        worldFullyLoaded = true;
        scanForExistingGoblins();
    }, 60);
});

world.afterEvents.entitySpawn.subscribe(({ entity }) => {
    if (entity.typeId === "mythicalcreatures:goblin") setupGoblinWithRetry(entity);
});

world.afterEvents.entityDie.subscribe(({ deadEntity }) => {
    if (deadEntity.typeId === "mythicalcreatures:goblin") {
        cleanupGoblin(deadEntity.id, "muerte");
    }
});

system.runInterval(() => {
    if (worldFullyLoaded) scanForExistingGoblins();
}, 200);

system.runInterval(() => {
    for (const entityId of monitoredGoblins.keys()) {
        if (!canResolveEntity(entityId)) cleanupGoblin(entityId, "limpieza periódica");
    }
    for (const entityId of activeSoundLoops.keys()) {
        if (!monitoredGoblins.has(entityId) || !canResolveEntity(entityId)) {
            stopSoundLoop(entityId, "loop huérfano");
        }
    }
}, 200);
