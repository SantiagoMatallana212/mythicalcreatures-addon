import { world } from "@minecraft/server";

export const DEBUG = false;

export function debug(scope, message) {
    if (!DEBUG) return;

    const formatted = `[GOBLIN:${scope}] ${message}`;
    console.warn(formatted);
    try {
        world.sendMessage(`§e${formatted}`);
    } catch {}
}
