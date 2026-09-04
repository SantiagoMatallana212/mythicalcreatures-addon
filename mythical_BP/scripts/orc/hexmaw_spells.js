import { world, system } from "@minecraft/server";

const DEBUG = false;
function debug(msg) {
    if (!DEBUG) return;
    try { world.sendMessage(`§6[HEXMAW]§r ${msg}`); } catch {}
}

const SCAN_INTERVAL = 10; // 0.5s

// Cooldown individual por hechizo (ticks)
const SPELL_COOLDOWNS = {
    vile_flame: 160,
    call_of_the_ancestors: 240,
    thorns_of_the_underworld: 200,
    broken_bone_curse: 300,
    pestilent_breath: 200,
    spiritual_summoning: 700
};

// Tiempo de CANALIZACIÓN por hechizo (ticks): durante este lapso el script
// NO elige otro hechizo, dejando que el cast se complete.
const SPELL_CHANNEL = {
    vile_flame: 50,                 // 2.5s exhalando
    call_of_the_ancestors: 25,      // 1.25s
    thorns_of_the_underworld: 45,   // 2.25s
    broken_bone_curse: 20,          // 1s
    pestilent_breath: 50,           // 2.5s
    spiritual_summoning: 45        // 5.5s (cast_duration 5s + margen)
};

// Para los ataques de efecto puro vía script: cada cuántos ticks aplican efecto
// durante su canalización, y sus parámetros.
const VILE_FLAME = { range: 5, angleCos: Math.cos(35 * Math.PI / 180), fire: 1, dmg: 3 };
const PESTILENT = { range: 12, angleCos: Math.cos(40 * Math.PI / 180) };

const hexmawState = new Map();

function isValid(e) {
    try { return e && e.id && world.getEntity(e.id) !== undefined; }
    catch { return false; }
}
function getProp(e, p) { try { return e.getProperty(p); } catch { return null; } }
function distance(a, b) {
    const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
function getState(id) {
    let s = hexmawState.get(id);
    if (!s) { s = { lastGlobal: 0, channelUntil: 0, activeSpell: null, spells: {} }; hexmawState.set(id, s); }
    return s;
}
function spellReady(s, spell, now) { return now >= (s.spells[spell] ?? 0); }

function isEnemy(e, orc) {
    if (e.id === orc.id) return false;
    if (e.typeId === "minecraft:player") return true;
    try {
        const fam = e.getComponent("minecraft:type_family");
        if (fam?.hasTypeFamily?.("greenskin")) return false;
    } catch {}
    return true;
}

function findEnemies(orc) {
    const out = [];
    try {
        const ents = orc.dimension.getEntities({ location: orc.location, maxDistance: 25 });
        for (const e of ents) { if (isValid(e) && isEnemy(e, orc)) out.push(e); }
        const players = orc.dimension.getPlayers({ location: orc.location, maxDistance: 25 });
        for (const p of players) out.push(p);
    } catch (e) { debug(`Error enemigos: ${e}`); }
    return out;
}

// ===== ATAQUES VÍA SCRIPT (efecto puro) =====
// Genera dos vectores perpendiculares a la dirección dada (para dibujar discos)
function perpVectors(dir) {
    // elige un vector de referencia no paralelo a dir
    const ref = Math.abs(dir.y) < 0.99 ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
    // u = dir × ref (normalizado)
    let ux = dir.y * ref.z - dir.z * ref.y;
    let uy = dir.z * ref.x - dir.x * ref.z;
    let uz = dir.x * ref.y - dir.y * ref.x;
    const ulen = Math.sqrt(ux*ux + uy*uy + uz*uz) || 1;
    ux/=ulen; uy/=ulen; uz/=ulen;
    // v = dir × u
    const vx = dir.y * uz - dir.z * uy;
    const vy = dir.z * ux - dir.x * uz;
    const vz = dir.x * uy - dir.y * ux;
    return { u: {x:ux,y:uy,z:uz}, v: {x:vx,y:vy,z:vz} };
}

// Dibuja un cono de partículas que se abre con la distancia
function spawnConeParticles(dim, origin, dir, range, halfAngleDeg, particleIds) {
    const { u, v } = perpVectors(dir);
    const tanA = Math.tan(halfAngleDeg * Math.PI / 180);
    for (let d = 1; d <= range; d += 1) {
        const radius = d * tanA;              // el radio crece con la distancia
        const cx = origin.x + dir.x * d;
        const cy = origin.y + dir.y * d;
        const cz = origin.z + dir.z * d;
        // número de puntos en el anillo proporcional al radio
        const points = Math.max(1, Math.floor(radius * 8));
        for (let i = 0; i < points; i++) {
            // distribuir en el disco (no solo el borde): radio aleatorio
            const ang = (i / points) * Math.PI * 2 + Math.random();
            const r = radius * Math.sqrt(Math.random()); // relleno uniforme del disco
            const px = cx + (u.x * Math.cos(ang) + v.x * Math.sin(ang)) * r;
            const py = cy + (u.y * Math.cos(ang) + v.y * Math.sin(ang)) * r;
            const pz = cz + (u.z * Math.cos(ang) + v.z * Math.sin(ang)) * r;
            const pid = particleIds[Math.floor(Math.random() * particleIds.length)];
            try { dim.spawnParticle(pid, { x: px, y: py, z: pz }); } catch {}
        }
    }
}

function doVileFlame(orc) {
    const origin = orc.getHeadLocation();
    const dir = orc.getViewDirection();
    const dim = orc.dimension;
    const RANGE = 12;
    const ANGLE_COS = Math.cos(40 * Math.PI / 180);

    spawnConeParticles(dim, origin, dir, RANGE, 40, [
        "mythicalcreatures:soul_drift_particle",
        "minecraft:blue_flame_particle"
    ]);
    let cantidades;
    try {
        cantidades = dim.getEntities({ location: orc.location, maxDistance: RANGE + 1});
    } catch { return; }

    for (const t of cantidades) {
        /*debug(`candidato: ${t?.typeId}`); */
        if ( !isValid(t) || !isEnemy(t, orc)) continue;
        /*debug(`paso isEnemy: ${t.typeId}`);*/
        const to = {
            x: t.location.x - origin.x,
            y: t.location.y - origin.y,
            z: t.location.z - origin.z
        };
        const len = Math.sqrt(to.x ** 2 + to.y ** 2 + to.z ** 2);
        if (len === 0 || len > RANGE) continue;
        const dot = (to.x * dir.x + to.y * dir.y + to.z * dir.z) / len;
        if (dot < ANGLE_COS) continue;
        debug(`en cono: ${t.typeId} dot=${dot.toFixed(2)}`);
        try {
            t.setOnFire(1, true);
            t.applyDamage(3, { cause: "fire", damagingEntity: orc});
            /*debug(`EFECTO aplicado: ${t.typeId}`);*/
        } catch {
            /*debug(`FALLO efecto en ${t.typeId}: ${e}`);*/
        }
    }
}

function doPestilentBreath(orc) {
    const origin = orc.getHeadLocation();
    const dir = orc.getViewDirection();
    const dim = orc.dimension;
    const RANGE = 12;                                  // más largo que vile (magia de wyvern, más refinada)
    const ANGLE_COS = Math.cos(40 * Math.PI / 180);    // un poco más amplio

    // Partículas verdosas a lo largo del cono
    spawnConeParticles(dim, origin, dir, RANGE, 40, [
        "mythicalcreatures:soul_drift_particle",
        "mythicalcreatures:pestilent_breath_particle",
        "minecraft:basic_smoke_particle"
    ]);

    let candidates;
    try {
        candidates = dim.getEntities({ location: orc.location, maxDistance: RANGE + 1 });
    } catch { return; }

    for (const t of candidates) {
        if (!isValid(t) || !isEnemy(t, orc)) continue;
        const to = {
            x: t.location.x - origin.x,
            y: t.location.y - origin.y,
            z: t.location.z - origin.z
        };
        const len = Math.sqrt(to.x ** 2 + to.y ** 2 + to.z ** 2);
        if (len === 0 || len > RANGE) continue;
        const dot = (to.x * dir.x + to.y * dir.y + to.z * dir.z) / len;
        if (dot < ANGLE_COS) continue;

        // Efecto: veneno + náusea + debilidad (aliento tóxico)
        try {
            t.addEffect("poison", 100, { amplifier: 0, showParticles: true });
            t.addEffect("nausea", 80, { amplifier: 0, showParticles: true });
            t.addEffect("weakness", 100, { amplifier: 0, showParticles: true });
        } catch {}
    }
}

function doBrokenBoneCurse(orc, target) {
    // Explosión visual de la maldición, independiente de las víctimas
    const dim = orc.dimension;
    const cx = target.location.x, cy = target.location.y, cz = target.location.z;
    const curseParticles = [
        "mythicalcreatures:soul_drift_particle",
        "minecraft:basic_smoke_particle",
        "minecraft:blue_flame_particle"
    ];
    // columna/explosión que sube desde el suelo en un radio de ~3 bloques
    for (let i = 0; i < 60; i++) {
        const ang = Math.random() * Math.PI * 2;
        const r = 3 * Math.sqrt(Math.random());      // relleno del área
        const px = cx + Math.cos(ang) * r;
        const pz = cz + Math.sin(ang) * r;
        const py = cy + Math.random() * 2.5;          // sube desde el suelo
        const pid = curseParticles[Math.floor(Math.random() * curseParticles.length)];
        try { dim.spawnParticle(pid, { x: px, y: py, z: pz }); } catch {}
    }
    // aplica 2-3 efectos al objetivo y enemigos cercanos a él
    const pool = ["weakness", "slowness", "mining_fatigue", "blindness"];
    let victims = [];
    try { victims = dim.getEntities({ location: target.location, maxDistance: 4 }); } catch {}
    victims = victims.filter(v => isValid(v) && isEnemy(v, orc));
    if (!victims.includes(target)) victims.push(target);
    for (const v of victims) {
        // elegir 2-3 efectos distintos
        const shuffled = [...pool].sort(() => Math.random() - 0.5);
        const count = 2 + Math.floor(Math.random() * 2); // 2 o 3
        for (let i = 0; i < count; i++) {
            try { v.addEffect(shuffled[i], 140, { amplifier: 0, showParticles: true }); } catch {}
        }
    }
}

// ===== PESOS =====
function buildWeights(orc, target, dist, enemies, now, state) {
    const w = {};
    let near5 = 0, near8 = 0;
    for (const e of enemies) {
        const d = distance(orc.location, e.location);
        if (d <= 5) near5++;
        if (d <= 8) near8++;
    }
    let hpFrac = 1.0;
    try { const h = orc.getComponent("minecraft:health"); if (h) hpFrac = h.currentValue / h.effectiveMax; } catch {}

    if (dist >= 4 && dist <= 12) { w.vile_flame = 10; if (near8 >= 2) w.vile_flame += 8; }
    if (near5 >= 2) w.call_of_the_ancestors = 14;
    if (near5 >= 3) w.call_of_the_ancestors = 40;
    if (dist < 3 && !w.call_of_the_ancestors) w.call_of_the_ancestors = 12;
    if (dist >= 5 && dist <= 12) w.thorns_of_the_underworld = 10;
    if (dist >= 5 && dist <= 15) {
        w.broken_bone_curse = 8;
        if (enemies.length >= 2) w.broken_bone_curse += 6;
        try { const th = target.getComponent("minecraft:health"); if (th && th.effectiveMax >= 40) w.broken_bone_curse += 6; } catch {}
    }
    if (dist >= 4 && dist <= 12) w.pestilent_breath = 11;
    {
        let s = 6;
        if (hpFrac < 0.5) s += 18;
        if (near8 === 0) s += 8;
        if (dist > 15) s += 10;
        w.spiritual_summoning = s;
    }
    for (const spell of Object.keys(w)) { if (!spellReady(state, spell, now)) delete w[spell]; }
    return w;
}

function pickWeighted(w) {
    const e = Object.entries(w);
    if (e.length === 0) return null;
    let total = 0; for (const [, x] of e) total += x;
    let r = Math.random() * total;
    for (const [s, x] of e) { r -= x; if (r <= 0) return s; }
    return e[e.length - 1][0];
}

// ===== CICLO PRINCIPAL =====
system.runInterval(() => {
    const dims = [world.getDimension("overworld"), world.getDimension("nether"), world.getDimension("the end")];
    const now = system.currentTick;

    for (const dim of dims) {
        let orcs = [];
        try { orcs = dim.getEntities({ type: "mythicalcreatures:orc" }); } catch { continue; }

        for (const orc of orcs) {
            if (!isValid(orc)) continue;
            if (getProp(orc, "mythicalcreatures:orc_variant") !== "hexmaw") continue;
            if (getProp(orc, "mythicalcreatures:orc_alert") !== "alerting") continue;

            const state = getState(orc.id);
            const enemies = findEnemies(orc);
            if (enemies.length === 0) continue;

            let target = null, best = Infinity;
            for (const e of enemies) { const d = distance(orc.location, e.location); if (d < best) { best = d; target = e; } }
            if (!target) continue;
            const dist = best;

            // --- CANALIZACIÓN EN CURSO: aplicar efecto del hechizo activo, NO elegir otro ---
            if (now < state.channelUntil && state.activeSpell) {
                if (state.activeSpell === "vile_flame") doVileFlame(orc);
                else if (state.activeSpell === "pestilent_breath") doPestilentBreath(orc);
                // broken_bone_curse, call, thorns, summoning: efecto puntual ya disparado, solo esperar
                continue;
            }
            if (state.activeSpell) {
                state.activeSpell = null
            }

            // cooldown global entre casts
            if (now - state.lastGlobal < 30) continue;

            const weights = buildWeights(orc, target, dist, enemies, now, state);
            /*debug(`pesos: ${JSON.stringify(weights)}`);
            debug(`cooldown: ${JSON.stringify(state.spells)}`);

            debug(`activeSpell=${state.activeSpell}`);
            debug(`channelUntil=${state.channelUntil}`);
            debug(`now=${now}`);*/
            const spell = pickWeighted(weights);
            if (!spell) continue;

            try {
                orc.triggerEvent(`cast_${spell}`);
                state.lastGlobal = now;
                state.spells[spell] = now + (SPELL_COOLDOWNS[spell] ?? 200);
                state.channelUntil = now + (SPELL_CHANNEL[spell] ?? 20);
                state.activeSpell = spell;

                // Ataques puntuales por script (no canalizados continuamente):
                if (spell === "broken_bone_curse") doBrokenBoneCurse(orc, target);

                debug(`${orc.id} -> ${spell} (dist ${dist.toFixed(1)})`);
            } catch (e) { debug(`Error cast_${spell}: ${e}`); }
        }
    }
}, SCAN_INTERVAL);

// limpieza
system.runInterval(() => {
    for (const id of hexmawState.keys()) { if (!world.getEntity(id)) hexmawState.delete(id); }
}, 200);

world.afterEvents.entityDie.subscribe(({ deadEntity }) => {
    if (deadEntity.typeId === "mythicalcreatures:orc") hexmawState.delete(deadEntity.id);
});