import { world, system } from '@minecraft/server';
import { isValidEntity, isGreenskin, hasFamily } from '../greenskin/friendly_fire.js';
import { RULES, CANDIDATE_TAG, ENEMY_FAMILIES, mobileContextAllowed, followerEligible, scoreThreat, orderInvalidReason } from './leadership_rules.js';

const DEBUG = true;
const ORC = 'mythicalcreatures:orc';
const PREFIX = 'mythicalcreatures:';

// Kept injectable so lifecycle tests can run without Minecraft or entity.target.
export function createLeadershipController(worldApi, clock, helpers = { isValidEntity, isGreenskin, hasFamily }) {
    const states = new Map();
    const assignments = new Map();
    const recentDamage = new Map();
    let bridge = null;
    const queue = [];

    const prop = (entity, name) => { try { return entity.getProperty(PREFIX + name); } catch { return undefined; } };
    const setProp = (entity, name, value) => { if (prop(entity, name) !== value) entity.setProperty(PREFIX + name, value); };
    const variant = entity => prop(entity, 'orc_variant');
    const resolve = id => { try { return id ? worldApi.getEntity(id) : undefined; } catch { return undefined; } };
    const alive = entity => { try { return helpers.isValidEntity(entity) && entity.getComponent('minecraft:health')?.currentValue > 0; } catch { return false; } };
    const distance = (a, b) => { try { return a.dimension.id === b.dimension.id ? Math.hypot(a.location.x - b.location.x, a.location.y - b.location.y, a.location.z - b.location.z) : Infinity; } catch { return Infinity; } };
    const debug = (entity, text) => { if (DEBUG) console.warn(`[ORC LEADERSHIP] ${entity?.id ?? 'lifecycle'} ${text}`); };
    const event = (entity, name) => { try { entity.triggerEvent(name); return true; } catch (error) { debug(entity, `${name}: ${error}`); return false; } };
    const isLeader = entity => ['warchief', 'warlord'].includes(variant(entity));
    const phase = (entity, next) => {
        const previous = prop(entity, 'leadership_state');
        if (previous === next) return;
        setProp(entity, 'leadership_state', next);
        debug(entity, `${previous} → ${next}`);
    };

    function enemy(candidate, observer, allowRetaliation = false) {
        if (!alive(candidate) || candidate.id === observer.id || helpers.isGreenskin(candidate)) return false;
        try {
            if (candidate.getComponent('minecraft:projectile') || helpers.hasFamily(candidate, 'inanimate')) return false;
            if (candidate.typeId === 'minecraft:player') {
                return !['creative', 'spectator'].includes(String(candidate.getGameMode()).toLowerCase());
            }
            return allowRetaliation || ENEMY_FAMILIES.some(family => helpers.hasFamily(candidate, family));
        } catch { return false; }
    }

    function visible(observer, target) {
        try {
            const origin = observer.getHeadLocation(), end = target.getHeadLocation();
            if (Math.abs(target.location.y - observer.location.y) > RULES.maxHeightDifference) return false;
            const length = Math.hypot(end.x - origin.x, end.y - origin.y, end.z - origin.z);
            if (length < 0.1) return true;
            const hit = observer.dimension.getBlockFromRay(origin,
                { x: (end.x - origin.x) / length, y: (end.y - origin.y) / length, z: (end.z - origin.z) / length },
                { maxDistance: Math.max(0.1, length - 0.3), includeLiquidBlocks: false, includePassableBlocks: false });
            return !hit;
        } catch { return false; } // Unloaded/unknown terrain is not treated as accessible.
    }

    function candidates(entity, range) {
        try { return entity.dimension.getEntities({ location: entity.location, maxDistance: range }); }
        catch { return []; }
    }

    function selectTarget(entity) {
        let best = null, bestScore = -Infinity;
        const memory = recentDamage.get(entity.id);
        for (const candidate of candidates(entity, RULES.selectionRange)) {
            const hurt = memory?.get(candidate.id);
            const recent = hurt && clock.currentTick - hurt.tick <= RULES.recentDamageTicks;
            if (!enemy(candidate, entity, recent) || !visible(entity, candidate)) continue;
            const score = scoreThreat({ distance: distance(entity, candidate), recentDamage: recent ? hurt.damage : 0,
                currentAttacker: Boolean(recent && hurt.direct), player: candidate.typeId === 'minecraft:player', golem: helpers.hasFamily(candidate, 'irongolem') });
            if (score > bestScore || score === bestScore && candidate.id < best.id) { best = candidate; bestScore = score; }
        }
        return best;
    }

    function register(entity) {
        if (!alive(entity) || entity.typeId !== ORC || !isLeader(entity) && !prop(entity, 'follow_orc_leader')) return;
        if (states.has(entity.id)) return;
        const staleOrder = prop(entity, 'order_active') || prop(entity, 'order_acquiring') || prop(entity, 'leadership_state') === 'ordering';
        const state = { entity, order: null, nextMark: staleOrder ? clock.currentTick + RULES.markCooldownTicks : 0,
            nextRam: 0, ramRetryUntil: 0, ramPhase: 'melee', ramSelectedAt: 0,
            nextRoar: 0, roarStarted: null, lastHurtTick: -Infinity, meleeUntil: 0, combatDecision: null,
            nativeTarget: null, nativeBand: null, commandDecision: null, roarNativeStarted: false };
        states.set(entity.id, state);
        if (isLeader(entity)) event(entity, 'leadership_reset');
        else if (staleOrder) event(entity, 'leadership_release_order');
        debug(entity, `registrado ${variant(entity)} contexto=${prop(entity, 'leadership_context')}; mobile=${prop(entity, 'mobile_leader')}`);
    }

    function eligible(leader, follower) {
        return follower.typeId === ORC && follower.id !== leader.id && alive(follower) && followerEligible({
            follower: prop(follower, 'follow_orc_leader'), mobile: prop(leader, 'mobile_leader'), isLeader: isLeader(follower),
            sameDimension: follower.dimension.id === leader.dimension.id, distance: distance(leader, follower),
            context: prop(follower, 'leadership_context'), leaderContext: prop(leader, 'leadership_context'),
        });
        // Cohort/patrol ownership can be added here; no patrol_id/horde_id is manufactured.
    }

    function canCommand(entity) {
        return prop(entity, 'mobile_leader') === true
            && mobileContextAllowed(variant(entity), prop(entity, 'leadership_context'));
    }

    function cleanupBridge() {
        if (!bridge) return;
        try { resolve(bridge.targetId)?.removeTag(CANDIDATE_TAG); } catch {}
        bridge = null;
    }

    function releaseFollower(id) {
        const follower = resolve(id);
        if (alive(follower) && (assignments.has(id) || prop(follower, 'order_active'))) event(follower, 'leadership_release_order');
        assignments.delete(id);
    }

    function endOrder(state, reason) {
        if (!state.order) return;
        const entity = state.entity;
        debug(entity, `target marcado invalidado=${state.order.targetId}: ${reason}`);
        if (bridge?.leaderId === entity.id) cleanupBridge();
        for (const [id, assignment] of assignments) if (assignment.leaderId === entity.id) releaseFollower(id);
        for (const id of state.order.pending ?? []) {
            const follower = resolve(id);
            if (alive(follower) && prop(follower, 'order_acquiring')) event(follower, 'leadership_release_order');
        }
        event(entity, 'leadership_release_order');
        state.order = null;
        state.nextMark = clock.currentTick + RULES.markCooldownTicks;
        debug(entity, 'fin de orden; comienza cooldown de marcaje de 15 s');
    }

    function startOrder(state, target) {
        state.order = { targetId: target.id, stage: 'queued', since: clock.currentTick, inaccessibleSince: null, pending: [] };
        queue.push(state.entity.id);
        debug(state.entity, `target marcado=${target.typeId}#${target.id} distancia=${distance(state.entity, target).toFixed(1)}`);
    }

    function updateBridge() {
        if (!bridge) {
            while (queue.length) {
                const leaderId = queue.shift(), state = states.get(leaderId);
                const target = resolve(state?.order?.targetId);
                if (!state?.order || state.order.stage !== 'queued' || !alive(target)) continue;
                if (!canCommand(state.entity)) { endOrder(state, 'ya no es líder móvil contextual'); continue; }
                // An order queued behind another leader must not dismantle a
                // ram that started while waiting for the command bridge.
                if (state.ramPhase === 'ram_active') { queue.push(leaderId); return; }
                try { target.addTag(CANDIDATE_TAG); } catch { endOrder(state, 'no se pudo marcar la entidad'); continue; }
                bridge = { leaderId, targetId: target.id };
                state.order.stage = 'pose'; state.order.since = clock.currentTick;
                clearRam(state, 'marcaje');
                event(state.entity, 'leadership_begin_order');
                debug(state.entity, 'marking iniciado: mobile=true, contexto válido y tropas; NO reasigna el target propio');
                break;
            }
            return;
        }
        const state = states.get(bridge.leaderId), order = state?.order;
        if (!order || !alive(state.entity)) { cleanupBridge(); return; }
        const entity = state.entity, target = resolve(order.targetId), elapsed = clock.currentTick - order.since;
        if (!alive(target)) { endOrder(state, 'target perdido durante la señal'); return; }
        if (order.stage === 'pose' && elapsed >= RULES.orderPoseTicks) {
            // Only the brief signal pauses combat. Follower acknowledgements
            // run afterwards and can never gate the leader's own attacks.
            event(entity, 'leadership_end_order_pose');
            order.stage = 'sharing'; order.since = clock.currentTick;
            for (const follower of candidates(entity, RULES.shareRange)) {
                if (!eligible(entity, follower)) continue;
                register(follower);
                event(follower, 'leadership_probe'); order.pending.push(follower.id);
            }
        } else if (order.stage === 'sharing' && elapsed >= 5) {
            order.pending = order.pending.filter(id => {
                const follower = resolve(id);
                if (!alive(follower) || !eligible(entity, follower)) return false;
                if (prop(follower, 'leadership_has_target') || assignments.has(id)) {
                    debug(follower, `ignora orden de ${entity.id}: ya tiene target válido`); return false;
                }
                event(follower, 'leadership_accept_order'); return true;
            });
            order.stage = 'confirming'; order.since = clock.currentTick;
        } else if (order.stage === 'confirming' && elapsed >= 5) {
            order.pending = order.pending.filter(id => {
                const follower = resolve(id);
                if (!alive(follower)) return false;
                if (!eligible(entity, follower)) { event(follower, 'leadership_release_order'); return false; }
                if (!prop(follower, 'order_acquiring')) {
                    debug(follower, `ignora orden de ${entity.id}: adquirió otro target antes de procesarla`); return false;
                }
                if (prop(follower, 'order_probe_match')) {
                    event(follower, 'leadership_keep_order');
                    assignments.set(id, { leaderId: entity.id, targetId: target.id });
                    debug(follower, `adopta target EXACTO ${target.typeId}#${target.id} de ${entity.id}`); return false;
                }
                if (elapsed >= RULES.acquisitionTimeoutTicks) {
                    event(follower, 'leadership_release_order'); debug(follower, 'orden no adoptada: sin ruta/adquisición nativa'); return false;
                }
                event(follower, 'leadership_probe'); return true;
            });
            if (!order.pending.length) {
                order.stage = 'settling'; order.since = clock.currentTick;
            }
        } else if (order.stage === 'settling' && elapsed >= 5) {
            // Give keep_order a complete native tick before removing its acquisition tag.
            order.stage = 'active';
            cleanupBridge(); debug(entity, 'orden activa para followers, sin duración fija; combate propio independiente');
        }
    }

    function invalidReason(state, target) {
        const order = state.order, entity = state.entity, now = clock.currentTick;
        if (alive(target)) {
            if (visible(entity, target)) order.inaccessibleSince = null;
            else if (order.inaccessibleSince === null) order.inaccessibleSince = now;
        }
        return orderInvalidReason({ alive: alive(target) && enemy(target, entity, true), sameDimension: distance(entity, target) !== Infinity,
            // The leader may be fighting a different enemy; its movement is
            // not used to judge accessibility of the followers' marked enemy.
            distance: distance(entity, target), inaccessibleFor: order.inaccessibleSince === null ? 0 : now - order.inaccessibleSince });
    }

    function clearRam(state, reason, groupsAlreadyRestored = false) {
        const previous = state.ramPhase;
        if (previous === 'melee') return;
        // Keep the phase retriable if the entity rejects the restore event.
        // JSON removes ram/impact before re-adding melee and its normal box.
        state.ramRestoreReason = reason;
        if (!groupsAlreadyRestored && !event(state.entity, 'leadership_disable_ram')) return;
        state.ramRestoreReason = null;
        state.ramPhase = 'melee';
        if (previous === 'ram_active') state.nextRam = clock.currentTick + RULES.ramCooldownTicks;
        else state.ramRetryUntil = clock.currentTick + RULES.ramRetryTicks;
        state.combatDecision = null;
        debug(state.entity, `${previous} → melee: ${reason}${previous === 'ram_pending' ? '; ' + ramPendingWait(state) : ''}; ${previous === 'ram_active' ? 'comienza cooldown de 10 s' : 'retry lock de 1 s, sin cooldown completo'}`);
    }

    function ramPendingWait(state) {
        const ticks = clock.currentTick - state.ramSelectedAt;
        return `espera en ram_pending: ${ticks} ticks (${(ticks / 20).toFixed(2)} s)`;
    }

    function reportRamCollision(state, reduced) {
        if (state.ramCollisionReduced === reduced) return;
        state.ramCollisionReduced = reduced;
        debug(state.entity, reduced ? 'ram collision box active: 0.9 x 1.3' : 'orc collision box restored: 1.2 x 2.7');
    }

    function updateWarlord(state) {
        const entity = state.entity, now = clock.currentTick;
        const commanding = canCommand(entity);
        const commandDecision = !prop(entity, 'mobile_leader') ? 'mobile=false' : !commanding ? 'contexto inválido' : 'líder móvil';
        if (state.commandDecision !== commandDecision) {
            state.commandDecision = commandDecision;
            debug(entity, commanding ? 'mando habilitado: líder móvil contextual' : `marking omitido porque ${commandDecision}`);
        }
        if (state.order && !commanding) endOrder(state, 'liderazgo móvil desactivado');
        else if (state.order) {
            const reason = invalidReason(state, resolve(state.order.targetId));
            if (reason) endOrder(state, reason);
        } else if (commanding && now >= state.nextMark && state.ramPhase !== 'ram_active') {
            if (candidates(entity, RULES.shareRange).some(follower => eligible(entity, follower))) {
                const target = selectTarget(entity);
                if (target) startOrder(state, target);
            }
        }
        selectWarlordAttack(state);
    }

    function combatDecision(state, key, message) {
        if (state.combatDecision === key) return;
        state.combatDecision = key;
        debug(state.entity, message);
    }

    function selectWarlordAttack(state) {
        const entity = state.entity, now = clock.currentTick;
        if (state.ramRestoreReason) {
            clearRam(state, state.ramRestoreReason);
            return;
        }
        if (state.order?.stage === 'pose' || prop(entity, 'leadership_state') === 'ordering') {
            clearRam(state, 'marcaje');
            combatDecision(state, 'marking', 'marking bloquea selección de combate');
            return;
        }
        // The native ram can release its AI target after on_start. Once active,
        // only its native query end (or an explicit reset/failure) ends the ram.
        if (state.ramPhase === 'ram_active') {
            if (!prop(entity, 'leadership_has_target')) {
                combatDecision(state, 'ram_active_no_target', 'native target absent durante ram_active: NO cancela la carga; esperando fin nativo de query.is_ram_attacking');
            }
            return;
        }
        if (!prop(entity, 'leadership_has_target')) {
            clearRam(state, 'pérdida/invalidez del target nativo (native target absent)');
            combatDecision(state, 'absent', 'modo ofensivo=melee; melee seleccionado, native target absent');
            return;
        }
        // Distance is an entry gate ONLY. Neither preparation nor a running
        // ram is interrupted when the target crosses either selection bound.
        // Only on_start confirms active; only the BP query edge confirms end.
        // Keep the same goal and reduced collision box throughout native
        // preparation. Elapsed time alone never aborts/reinstalls this goal.
        if (state.ramPhase === 'ram_pending') return;
        if (now < state.nextRam) {
            combatDecision(state, 'cooldown', 'ram no disponible por cooldown activo: intento rechazado antes de pending; melee/persecución');
            return;
        }
        if (now < state.ramRetryUntil) {
            combatDecision(state, 'retry', 'ram retry lock activo: intento rechazado antes de pending; melee/persecución');
            return;
        }
        const band = prop(entity, 'leadership_target_band');
        if (band !== 'ram') {
            combatDecision(state, band, `modo ofensivo=melee; intento rechazado antes de pending por rango nativo=${band === 'near' ? '<' + RULES.ramMinDistance : band === 'far' ? '>' + RULES.ramMaxDistance : 'sin muestra'}; melee seleccionado`);
            return;
        }
        if (event(entity, 'leadership_enable_ram')) {
            state.ramPhase = 'ram_pending'; state.ramSelectedAt = now;
            combatDecision(state, 'ram_pending', `melee → ram_pending: distancia inicial nativa=${RULES.ramMinDistance}–${RULES.ramMaxDistance}; esperando native on_start, sin timeout scripted ni reevaluación de distancia`);
        }
    }

    function finishRoar(state, reason) {
        if (state.roarStarted === null) return;
        state.roarStarted = null;
        state.roarNativeStarted = false;
        state.nextRoar = clock.currentTick + RULES.roarCooldownTicks;
        state.meleeUntil = clock.currentTick + RULES.roarMeleeLockTicks;
        debug(state.entity, `roar → melee: ${reason}; bloqueo post-roar de ${RULES.roarMeleeLockTicks / 20} s`);
    }

    function updateWarchief(state) {
        const entity = state.entity, now = clock.currentTick;
        if (state.roarStarted !== null) {
            if (now - state.roarStarted > 60) {
                event(entity, 'leadership_roar_finished'); finishRoar(state, 'watchdog: roar no terminó');
            }
            return;
        }
        // Melee is the installed/default offensive goal. Range alone never
        // selects roar: it must also have recent damage or multiple enemies.
        if (prop(entity, 'leadership_has_target') && now >= state.nextRoar && now >= state.meleeUntil) {
            const nearby = candidates(entity, RULES.roarRange).filter(candidate => enemy(candidate, entity));
            const recentHurt = now - state.lastHurtTick <= RULES.roarRecentHurtTicks;
            const surrounded = nearby.length >= RULES.roarPressureEnemies;
            if (nearby.length && (recentHurt || surrounded) && event(entity, 'leadership_start_roar')) {
                state.roarStarted = now;
                debug(entity, `roar candidato: ${recentHurt ? 'daño reciente' : 'múltiples enemigos'}; enemigos=${nearby.length}`);
                combatDecision(state, 'roar', 'melee → roar; modo ofensivo=roar (esperando inicio nativo)');
                return;
            }
        }
        combatDecision(state, 'melee', 'modo ofensivo=melee; melee seleccionado por defecto');
        phase(entity, 'normal');
    }

    function tick() {
        for (const [id, state] of states) {
            try {
                if (!alive(state.entity)) { endOrder(state, 'líder muerto/descargado'); states.delete(id); recentDamage.delete(id); continue; }
                if (isLeader(state.entity)) {
                    const present = prop(state.entity, 'leadership_has_target') === true;
                    const band = prop(state.entity, 'leadership_target_band');
                    if (state.nativeTarget !== present) {
                        state.nativeTarget = present; debug(state.entity, `native target ${present ? 'present' : 'absent'}`);
                    }
                    if (variant(state.entity) === 'warlord' && state.ramPhase === 'melee' && state.nativeBand !== band) {
                        state.nativeBand = band;
                        debug(state.entity, `distancia usada por selector (nativa): ${band === 'ram' ? RULES.ramMinDistance + '–' + RULES.ramMaxDistance : band === 'near' ? '<' + RULES.ramMinDistance : band === 'far' ? '>' + RULES.ramMaxDistance : 'sin target'}`);
                    }
                }
                const context = prop(state.entity, 'leadership_context');
                if (prop(state.entity, 'mobile_leader') && !mobileContextAllowed(variant(state.entity), context)) event(state.entity, 'leadership_disable_mobile');
                if (variant(state.entity) === 'warlord') updateWarlord(state);
                else if (variant(state.entity) === 'warchief') updateWarchief(state);
                else if (!prop(state.entity, 'follow_orc_leader')) { releaseFollower(id); states.delete(id); }
            } catch (error) {
                debug(state.entity, `error de lifecycle: ${error}`);
                if (variant(state.entity) === 'warlord') clearRam(state, 'error de lifecycle');
                endOrder(state, 'error de lifecycle');
            }
        }
        try { updateBridge(); }
        catch (error) {
            const state = states.get(bridge?.leaderId);
            debug(state?.entity, `error de adquisición/compartición: ${error}`);
            if (state) endOrder(state, 'error de adquisición/compartición');
            else cleanupBridge();
        }
        for (const [id, assignment] of assignments) {
            const follower = resolve(id), target = resolve(assignment.targetId), leader = resolve(assignment.leaderId);
            if (!alive(follower) || !alive(target) || !alive(leader) || !prop(follower, 'follow_orc_leader')
                || !prop(leader, 'mobile_leader') || prop(follower, 'leadership_context') !== prop(leader, 'leadership_context')
                || distance(follower, target) > RULES.abandonRange) releaseFollower(id);
        }
        for (const [id, records] of recentDamage) {
            for (const [attacker, record] of records) if (clock.currentTick - record.tick > RULES.recentDamageTicks) records.delete(attacker);
            if (!records.size) recentDamage.delete(id);
        }
    }

    function nativeEvent(entity, eventId) {
        if (entity.typeId !== ORC) return;
        register(entity);
        const state = states.get(entity.id);
        if (!state) return;
        if (variant(entity) === 'warlord') {
            // These notifications arrive after the JSON group swap, not when
            // the selector merely requests it. No probe polling/properties.
            const mode = prop(entity, 'leadership_state');
            if (eventId === 'leadership_enable_ram' && mode === 'ram') reportRamCollision(state, true);
            else if (['leadership_disable_ram', 'leadership_reset', 'leadership_begin_order', 'leadership_end_order_pose'].includes(eventId)
                && mode !== 'ram') {
                // An external reset/abort must not leave the selector active
                // after the native goal and its reduced box were removed.
                clearRam(state, eventId === 'leadership_reset' ? 'reset ofensivo' : 'restauración nativa de grupos', true);
                reportRamCollision(state, false);
            }
        }
        if (eventId === 'leadership_ram_started' && variant(entity) === 'warlord' && state.ramPhase === 'ram_pending') {
            debug(entity, `ram native on_start; ${ramPendingWait(state)}`);
            state.ramPhase = 'ram_active';
            combatDecision(state, 'ram_active', 'ram_pending → ram_active: inicio confirmado por el behavior nativo');
        } else if (eventId === 'leadership_ram_finished' && variant(entity) === 'warlord' && state.ramPhase === 'ram_active') {
            clearRam(state, 'fin nativo: query.is_ram_attacking dejó de estar activo');
        } else if (eventId === 'leadership_roar_started' && state.roarStarted !== null && !state.roarNativeStarted) {
            state.roarNativeStarted = true; debug(entity, 'roar iniciado: query.is_roaring');
        } else if (eventId === 'leadership_roar_finished') finishRoar(state, 'roar finalizado (fin nativo)');
    }

    function hurt(hurtEntity, source, damage) {
        const direct = source.damagingEntity;
        let attacker = direct;
        try { attacker = source.damagingProjectile?.getComponent('minecraft:projectile')?.owner ?? direct; } catch {}
        if (alive(hurtEntity) && hurtEntity.typeId === ORC && variant(hurtEntity) === 'warchief'
            && damage > 0 && !helpers.isGreenskin(attacker)) {
            register(hurtEntity);
            states.get(hurtEntity.id).lastHurtTick = clock.currentTick;
        }
        if (!alive(hurtEntity) || !alive(attacker) || helpers.isGreenskin(attacker)) return;
        for (const state of states.values()) {
            if (variant(state.entity) !== 'warlord') continue;
            if (hurtEntity.id !== state.entity.id && !eligible(state.entity, hurtEntity)) continue;
            let records = recentDamage.get(state.entity.id);
            if (!records) recentDamage.set(state.entity.id, records = new Map());
            const prior = records.get(attacker.id);
            records.set(attacker.id, { tick: clock.currentTick, damage: (prior?.damage ?? 0) + damage, direct: hurtEntity.id === state.entity.id });
        }
    }

    function load(entity) {
        try { if (entity.hasTag(CANDIDATE_TAG) && bridge?.targetId !== entity.id) entity.removeTag(CANDIDATE_TAG); } catch {}
        register(entity);
    }

    return { register, load, tick, nativeEvent, hurt, states, assignments, selectTarget,
        inspect: () => ({ bridge, queue: [...queue] }) };
}

const leadership = createLeadershipController(world, system);
system.run(() => {
    for (const name of ['overworld', 'nether', 'the end']) {
        const dimension = world.getDimension(name);
        for (const entity of dimension.getEntities({ tags: [CANDIDATE_TAG] })) leadership.load(entity);
        for (const entity of dimension.getEntities({ type: ORC })) leadership.load(entity);
    }
});
world.afterEvents.entitySpawn.subscribe(({ entity }) => system.run(() => leadership.load(entity)));
world.afterEvents.entityLoad.subscribe(({ entity }) => system.run(() => leadership.load(entity)));
world.afterEvents.playerSpawn.subscribe(({ player }) => leadership.load(player));
world.afterEvents.dataDrivenEntityTrigger.subscribe(({ entity, eventId }) => {
    if (entity.typeId === ORC && eventId.startsWith('leadership_')) leadership.nativeEvent(entity, eventId);
});
world.afterEvents.entityHurt.subscribe(({ hurtEntity, damageSource, damage }) => leadership.hurt(hurtEntity, damageSource, damage));
system.runInterval(() => leadership.tick(), RULES.updateTicks);
