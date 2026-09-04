import { world, system } from "@minecraft/server";
import { debug } from "./goblin_debug.js";

const CHECK_INTERVAL = 100;
const ALLY_RADIUS = 15;
const GROUP_RADIUS = 15;
const MIN_GROUP = 3;

const goblinMemory = new Map();

function canResolveEntity(entityId) {
    try {
        return Boolean(entityId && world.getEntity(entityId));
    } catch {
        return false;
    }
}

function formatLocation(location) {
    return `X:${location.x.toFixed(1)} Y:${location.y.toFixed(1)} Z:${location.z.toFixed(1)}`;
}

function updateGoblinState(goblin) {
    try {
        const bigAllies = goblin.dimension.getEntities({
            location: goblin.location,
            maxDistance: ALLY_RADIUS,
            type: "mythicalcreatures:orc"
        });
        const bigAlliesNearby = bigAllies.length > 0;

        const otherGoblins = goblin.dimension.getEntities({
            location: goblin.location,
            maxDistance: GROUP_RADIUS,
            type: "mythicalcreatures:goblin",
            excludeEntities: [goblin]
        });
        const goblinAllies = otherGoblins.length;
        const shouldBeBrave = bigAlliesNearby || goblinAllies >= MIN_GROUP;
        const previousState = goblinMemory.get(goblin.id)?.isBrave;
        const support = bigAlliesNearby ? "big_ally" : goblinAllies >= MIN_GROUP ? "goblin_group" : "none";

        if (previousState !== shouldBeBrave) {
            goblin.triggerEvent(shouldBeBrave ? "become_brave" : "become_coward");
            debug(
                "BRAVERY",
                `${goblin.id} ${shouldBeBrave ? "valiente" : "cobarde"} en ${formatLocation(goblin.location)} ` +
                `(orcos=${bigAllies.length}, goblins=${goblinAllies})`
            );
        }

        // La marca de tiempo se refresca incluso cuando no cambia el estado.
        goblinMemory.set(goblin.id, {
            isBrave: shouldBeBrave,
            lastCheckTick: system.currentTick,
            alliesNearby: support
        });
    } catch (error) {
        debug("BRAVERY", `Error actualizando ${goblin?.id}: ${error}`);
    }
}

system.runInterval(() => {
    for (const dimensionId of ["overworld", "nether", "the end"]) {
        try {
            const dimension = world.getDimension(dimensionId);
            const goblins = dimension.getEntities({ type: "mythicalcreatures:goblin" });
            for (const goblin of goblins) {
                const memory = goblinMemory.get(goblin.id);
                if (!memory || system.currentTick - memory.lastCheckTick >= CHECK_INTERVAL) {
                    updateGoblinState(goblin);
                }
            }
        } catch (error) {
            debug("BRAVERY", `Error escaneando ${dimensionId}: ${error}`);
        }
    }
}, 20);

world.afterEvents.entitySpawn.subscribe(({ entity }) => {
    if (entity.typeId === "mythicalcreatures:goblin") {
        system.runTimeout(() => updateGoblinState(entity), 10);
    }
});

world.afterEvents.entityDie.subscribe(({ deadEntity }) => {
    if (deadEntity.typeId === "mythicalcreatures:goblin") {
        goblinMemory.delete(deadEntity.id);
    }
});

system.runInterval(() => {
    for (const entityId of goblinMemory.keys()) {
        if (!canResolveEntity(entityId)) goblinMemory.delete(entityId);
    }
}, 200);
