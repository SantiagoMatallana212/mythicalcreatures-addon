import { world, system } from "@minecraft/server";

// Configuración
const CHECK_INTERVAL = 100;
const ALLY_RADIUS = 15;
const GROUP_RADIUS = 15;
const MIN_GROUP = 3;
const BIGGER_ALLIES = ["mythicalcreatures:orc"];

const goblinMemory = new Map();

// Función para formatear ubicación
function formatLocation(loc) {
    return `X:${loc.x.toFixed(1)} Y:${loc.y.toFixed(1)} Z:${loc.z.toFixed(1)}`;
}

function updateGoblinState(goblin) {
    try {
        /*console.warn(`[DEBUG] Evaluando goblin ${goblin.id} en ${formatLocation(goblin.location)}`);*/

        // 1. Buscar aliados grandes
        const bigAllies = goblin.dimension.getEntities({
            location: goblin.location,
            maxDistance: ALLY_RADIUS,
            type: "mythicalcreatures:orc"
        });
        const bigAlliesNearby = bigAllies.length > 0;

        /*console.warn(`[DEBUG] Aliados grandes cerca (${BIGGER_ALLIES.join(", ")}): ${bigAllies.length} encontrados`, 
            bigAllies.map(a => `${a.typeId} en ${formatLocation(a.location)}`));*/

        // 2. Buscar otros goblins
        const otherGoblins = goblin.dimension.getEntities({
            location: goblin.location,
            maxDistance: GROUP_RADIUS,
            type: "mythicalcreatures:goblin",
            excludeEntities: [goblin]
        });
        const goblinAllies = otherGoblins.length;

        /*console.warn(`[DEBUG] Goblins aliados cerca: ${goblinAllies} encontrados`,
            otherGoblins.map(g => `${g.id} en ${formatLocation(g.location)}`));*/

        // 3. Determinar estado
        const shouldBeBrave = bigAlliesNearby || goblinAllies >= MIN_GROUP;
        const previousState = goblinMemory.get(goblin.id)?.isBrave;

        /*console.warn(`[DEBUG] Estado anterior: ${previousState}, Nuevo estado calculado: ${shouldBeBrave}`);
        console.warn(`[DEBUG] Razón: ${bigAlliesNearby ? "Aliado grande cerca" : goblinAllies >= MIN_GROUP ? `Grupo de ${goblinAllies} goblins` : "Sin soporte"}`);*/

        // 4. Cambiar estado si es diferente
        if(previousState !== shouldBeBrave) {
            const eventToTrigger = shouldBeBrave ? "become_brave" : "become_coward";
            /*console.warn(`[DEBUG] Disparando evento: ${eventToTrigger} para goblin ${goblin.id}`);*/
            
            const triggerResult = goblin.triggerEvent(eventToTrigger);
            /*console.warn(`[DEBUG] Resultado de triggerEvent: ${triggerResult}`);*/

            goblinMemory.set(goblin.id, {
                isBrave: shouldBeBrave,
                lastCheck: Date.now(),
                alliesNearby: bigAlliesNearby ? "big_ally" : goblinAllies >= MIN_GROUP ? "goblin_group" : "none"
            });

            // Verificar propiedad después del cambio
            system.runTimeout(() => {
                const currentBraveState = goblin.getProperty("mythicalcreatures:goblin_is_brave");
                /*console.warn(`[DEBUG POST-EVENT] Propiedad goblin_is_brave actual: ${currentBraveState}`);*/
            }, 5);
        } else {
            /*console.warn(`[DEBUG] No se requiere cambio de estado`);*/
        }
    } catch (error) {
        /*console.warn(`[ERROR] Error actualizando estado de goblin ${goblin.id}:`, error);*/
    }
}

system.runInterval(() => {
    /*console.warn(`[DEBUG] --- Iniciando escaneo periódico ---`);*/
    const dimensions = [
        world.getDimension("overworld"),
        world.getDimension("nether"),
        world.getDimension("the end")
    ];

    dimensions.forEach(dimension => {
        try {
            /*console.warn(`[DEBUG] Escaneando dimensión ${dimension.id}`);*/
            const allGoblins = dimension.getEntities({
                type: "mythicalcreatures:goblin"
            });

            /*console.warn(`[DEBUG] Encontrados ${allGoblins.length} goblins en ${dimension.id}`);*/
            allGoblins.forEach(goblin => {
                const memory = goblinMemory.get(goblin.id);
                const needsUpdate = !memory || Date.now() - memory.lastCheck > CHECK_INTERVAL * 50;
                
                /*console.warn(`[DEBUG] Goblin ${goblin.id} - Memoria: ${memory ? `Última actualización hace ${(Date.now() - memory.lastCheck)/1000} seg` : 'Sin registro'}, Necesita actualización: ${needsUpdate}`);*/
                
                if (needsUpdate) {
                    updateGoblinState(goblin);
                }
            });
        } catch (error) {
            /*console.warn(`[ERROR] Error escaneando dimensión ${dimension.id}:`, error);*/
        }
    });
}, 20);

world.afterEvents.entitySpawn.subscribe(({ entity }) => {
    if (entity.typeId === "mythicalcreatures:goblin") {
        /*console.warn(`[DEBUG] Goblin spawn detectado: ${entity.id}`);*/
        system.runTimeout(() => {
            /*console.warn(`[DEBUG] Actualizando goblin recién spawn (${entity.id}) después de delay`);*/
            updateGoblinState(entity);
        }, 10);
    }
});

world.afterEvents.entityDie.subscribe(({ deadEntity }) => {
    if (deadEntity.typeId === "mythicalcreatures:goblin") {
        /*console.warn(`[DEBUG] Goblin eliminado: ${entity.id}`);*/
        goblinMemory.delete(deadEntity.id);
    }
});

// Debug inicial
/*console.warn("[DEBUG] Script de comportamiento goblin cargado correctamente");*/