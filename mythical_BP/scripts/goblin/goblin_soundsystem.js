import { world, system } from "@minecraft/server";

const SOUND_SETTINGS = {
    "drumhowla": { sound: "mob.goblin.drumhowla", interval: 40, maxLoops: 5 },
    "hornshriek": { sound: "mob.goblin.hornshriek", interval: 240, maxLoops: 3 }
};

const activeIntervals = new Map();

function getEntityProperty(entity, propertyName) {
    try {
        if (!entity || !entity.id) {
            /*console.warn(`[DEBUG] Entidad inválida al obtener propiedad ${propertyName}`);*/
            return null;
        }
        const value = entity.getProperty(propertyName);
        /*console.warn(`[DEBUG] Propiedad ${propertyName} obtenida:`, value);*/
        return value;
    } catch (error) {
        /*console.warn(`[ERROR] Error al obtener propiedad ${propertyName}:`, error);*/
        return null;
    }
}

function isEntityValid(entity) {
    try {
        const isValid = entity && entity.id && world.getEntity(entity.id) !== undefined;
        if (!isValid) {
            /*console.warn(`[DEBUG] Entidad ${entity?.id} no válida`);*/
        }
        return isValid;
    } catch (error) {
        /*console.warn(`[ERROR] Error validando entidad:`, error);*/
        return false;
    }
}

// Variable para controlar el estado de carga
let worldFullyLoaded = false;

// 1. Manejar la carga inicial del mundo con reintentos
world.afterEvents.worldLoad.subscribe(() => {
    /*console.warn("[DEBUG] Mundo cargado - Iniciando escaneo de entidades...");*/
    
    // Esperar 3 segundos (60 ticks) para asegurar la carga completa
    system.runTimeout(() => {
        worldFullyLoaded = true;
        scanForExistingGoblins();
    }, 60);
});

// 2. Escanear periódicamente por nuevas entidades (para chunks que se cargan después)
system.runInterval(() => {
    if (worldFullyLoaded) {
        scanForExistingGoblins();
    }
}, 200); // Cada 10 segundos (200 ticks)

// 3. Función mejorada para escanear goblins
function scanForExistingGoblins() {
    try {
        const dimensions = [
            world.getDimension("overworld"),
            world.getDimension("nether"),
            world.getDimension("the end")
        ];
        
        dimensions.forEach(dimension => {
            const goblins = dimension.getEntities({ 
                type: "mythicalcreatures:goblin" 
            });
            
            /*console.warn(`[DEBUG] Encontrados ${goblins.length} goblins en ${dimension.id}`);*/
            
            goblins.forEach(goblin => {
                if (!activeIntervals.has(goblin.id)) {
                    setupGoblinWithRetry(goblin);
                }
            });
        });
    } catch (error) {
        /*console.warn("[ERROR] Error escaneando goblins:", error);*/
    }
}

// 4. Función de configuración con reintentos inteligentes
function setupGoblinWithRetry(entity, attempt = 1) {
    if (attempt > 10) { // Máximo 10 intentos (5 segundos)
        /*console.warn(`[WARN] No se pudo configurar ${entity.id} después de ${attempt} intentos`);*/
        return;
    }

    system.runTimeout(() => {
        if (!isEntityValid(entity)) {
            /*console.warn(`[DEBUG] Entidad ${entity.id} no válida, reintentando...`);*/
            setupGoblinWithRetry(entity, attempt + 1);
            return;
        }

        const variant = getEntityProperty(entity, "mythicalcreatures:goblin_variant");
        if (variant) {
            /*console.warn(`[DEBUG] Configurando ${entity.id} (variante: ${variant})`);*/
            setupGoblinSoundSystem(entity, variant);
        } else {
            /*console.warn(`[DEBUG] Variante no disponible (intento ${attempt})`);*/
            setupGoblinWithRetry(entity, attempt + 1);
        }
    }, attempt * 10); // Backoff exponencial
}

// 5. Modificar el entitySpawn para usar la misma lógica
world.afterEvents.entitySpawn.subscribe(({ entity }) => {
    if (entity.typeId === "mythicalcreatures:goblin") {
        setupGoblinWithRetry(entity);
    }
});

function setupGoblinSoundSystem(entity, initialVariant) {
    if (activeIntervals.has(entity.id)) {
        /*console.warn(`[DEBUG] El sistema de sonido ya está configurado para ${entity.id}`);*/
        return;
    }

    /*console.warn(`[DEBUG] Configurando sistema de sonido para goblin ${entity.id}, variante: ${initialVariant}`);*/

    const intervalId = system.runInterval(() => {
        if (!isEntityValid(entity)) {
            /*console.warn(`[DEBUG] Entidad no válida en intervalo de sonido`);*/
            system.clearRun(intervalId);
            return;
        }

        try {
            const currentVariant = getEntityProperty(entity, "mythicalcreatures:goblin_variant") || initialVariant;
            const isAlerting = getEntityProperty(entity, "mythicalcreatures:goblin_alert") === "alerting";

            /*console.warn(`[DEBUG] Estado actual - Variante: ${currentVariant}, Alerta: ${isAlerting}`);*/

            if (!currentVariant || !SOUND_SETTINGS[currentVariant]) {
                /*console.warn(`[DEBUG] Variante no válida o sin configuración de sonido`);*/
                return;
            }

            if (isAlerting && !activeIntervals.has(entity.id)) {
                /*console.warn(`[DEBUG] Iniciando loop de sonido para ${entity.id}`);*/
                // Ejecutar inmediatamente el primer sonido antes de que pase el intervalo largo
                startSoundLoop(entity, currentVariant);
            } else if (!isAlerting && activeIntervals.has(entity.id)) {
                /*console.warn(`[DEBUG] Deteniendo loop de sonido para ${entity.id}`);*/
                stopSoundLoop(entity);
            }
        } catch (error) {
            /*console.warn("[ERROR] Error en el sistema de sonido:", error);*/
        }
    }, 15);
}

function startSoundLoop(entity, variant) {
    if (deadEntities.has(entity.id)) {
        /*console.warn(`[DEBUG] No iniciar sonido para goblin muerto ${entity.id}`);*/
        return;
    }

    /*console.warn(`[DEBUG] Iniciando loop de sonido para ${entity.id}, variante ${variant}`);*/

    const settings = SOUND_SETTINGS[variant];
    if (!settings) {
        /*console.warn(`[DEBUG] Configuración de sonido no encontrada para variante ${variant}`);*/
        return;
    }

    let loops = 0;

    const soundLoop = () => {
        if (!isEntityValid(entity) || deadEntities.has(entity.id)) {
            /*console.warn(`[DEBUG] Entidad no válida o muerta en soundLoop`);*/
            stopSoundLoop(entity);
            return;
        }

        try {
            const currentAlert = getEntityProperty(entity, "mythicalcreatures:goblin_alert") === "alerting";

            /*console.warn(`[DEBUG] SoundLoop - Alerta: ${currentAlert}, Loop: ${loops}/${settings.maxLoops}`);*/

            if (!currentAlert || (settings.maxLoops && loops >= settings.maxLoops)) {
                /*console.warn(`[DEBUG] Condiciones para detener sonido cumplidas`);*/
                stopSoundLoop(entity);
                return;
            }

            /*console.warn(`[DEBUG] Intentando reproducir sonido ${settings.sound} en posición:`, {
                x: entity.location.x,
                y: entity.location.y,
                z: entity.location.z
            });*/

            const result = entity.dimension.playSound(settings.sound, {
                x: entity.location.x,
                y: entity.location.y,
                z: entity.location.z,
                volume: 1.0,
                pitch: 1.0
            });

            /*console.warn(`[DEBUG] Resultado de playSound:`, result);*/
            loops++;
        } catch (error) {
            /*console.warn("[ERROR] Error en soundLoop:", error);*/
            stopSoundLoop(entity);
        }
    };

    // 🔥 Ejecutar una vez inmediatamente
    soundLoop();

    // 🕒 Y luego cada intervalo
    const intervalId = system.runInterval(soundLoop, settings.interval);
    activeIntervals.set(entity.id, { intervalId, variant });
    /*console.warn(`[DEBUG] Loop de sonido iniciado con ID: ${intervalId}`);*/
}

function stopSoundLoop(entity) {
    if (!entity?.id) {
        /*console.warn(`[DEBUG] Intento de detener sonido para entidad inválida`);*/
        return;
    }

    if (deadEntities.has(entity.id)) {
        deadEntities.delete(entity.id)
    }

    const soundData = activeIntervals.get(entity.id);
    if (soundData) {
        /*console.warn(`[DEBUG] Deteniendo loop de sonido para ${entity.id}, ID intervalo: ${soundData.intervalId}`);*/
        system.clearRun(soundData.intervalId);
        activeIntervals.delete(entity.id);
    } else {
        /*console.warn(`[DEBUG] No se encontró data de sonido para ${entity.id}`);*/
    }
}

const deadEntities = new Set();

world.afterEvents.entityDie.subscribe(({ deadEntity }) => {
    /*console.warn(`[DEBUG] Entidad muerta: ${deadEntity.typeId}`);*/
    if (deadEntity.typeId === "mythicalcreatures:goblin") {
        deadEntities.add(deadEntity.id);
        stopSoundLoop(deadEntity);
    }
});

system.runInterval(() => {
    /*console.warn(`[DEBUG] Limpieza de intervalos activos, total: ${activeIntervals.size}`);*/
    activeIntervals.forEach((data, entityId) => {
        if (!world.getEntity(entityId)) {
            /*console.warn(`[DEBUG] Limpiando intervalo huérfano para entidad ${entityId}`);*/
            system.clearRun(data.intervalId);
            activeIntervals.delete(entityId);
        }
    });
    deadEntities.forEach(entityId => {
        if(!world.getEntity(entityId)) {
            deadEntities.delete(entityId)
        }
    })
}, 200);