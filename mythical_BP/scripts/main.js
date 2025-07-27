import { world } from "@minecraft/server";

world.afterEvents.playerSpawn.subscribe(({ player }) => {
    if (!player.getDynamicProperty("addon_welcomed")) {
        player.onScreenDisplay.setTitle('Mythical Creatures Add-on', {
            subtitle: `Welcome §l§d${player.name}!`,  // ¡Usa comillas invertidas!
            fadeInDuration: 10,    // Obligatorio (número)
            stayDuration: 80,      // Obligatorio (número)
            fadeOutDuration: 10    // Obligatorio (número)
        });

        player.playSound("random.orb");
        player.setDynamicProperty("addon_welcomed", true);
    }
});