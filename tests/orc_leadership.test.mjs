import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as rules from '../mythical_BP/scripts/orc/leadership_rules.js';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const orc = JSON.parse(read('mythical_BP/entities/orc.json'))['minecraft:entity'];
const script = read('mythical_BP/scripts/orc/orc_leadership.js');
const ramController = JSON.parse(read('mythical_BP/animation_controllers/orc_leadership.json'))
    .animation_controllers['controller.animation.orc.leadership_ram'];
// Execute the production controller, excluding only imports and runtime subscriptions.
const core = script.replace(/^import .*;\n/gm, '').split('\nconst leadership = createLeadershipController(world, system);')[0]
    .replace('export function createLeadershipController', 'function createLeadershipController');
const logs = [];
const createController = new Function(...Object.keys(rules), 'console', core + '\nreturn createLeadershipController;')
    (...Object.values(rules), { warn: text => logs.push(text) });
const P = 'mythicalcreatures:';
const get = (entity, key) => entity.getProperty(P + key);
const set = (entity, key, value) => entity.setProperty(P + key, value);
const live = entity => Boolean(entity?.isValid && entity.health > 0);
const family = (entity, value) => Boolean(entity?.families.includes(value));
const meleeGoal = 'minecraft:behavior.melee_box_attack';
const ramGoal = 'minecraft:behavior.ram_attack';
const roarGoal = 'minecraft:behavior.knockback_roar';
const offensiveGoals = entity => [meleeGoal, ramGoal, roarGoal].filter(goal => entity.components.has(goal));
const collision = 'minecraft:collision_box';
const normalBox = { width: 1.2, height: 2.7 };
const ramBox = { width: 0.9, height: 1.3 };
const collisionGroups = ['warlord_melee_mode', 'warlord_ram', 'warlord_order_pose'];

function filter(node, self, other) {
    if (!node) return true;
    if (Array.isArray(node)) return node.every(item => filter(item, self, other));
    if (node.all_of) return node.all_of.every(item => filter(item, self, other));
    if (node.any_of) return node.any_of.some(item => filter(item, self, other));
    if (node.none_of) return !node.none_of.some(item => filter(item, self, other));
    const subject = node.subject === 'other' ? other : node.subject === 'target' ? self.nativeTarget : self;
    let actual;
    switch (node.test) {
        case 'enum_property': case 'bool_property': actual = subject?.getProperty(node.domain); break;
        case 'is_family': actual = family(subject, node.value); break;
        case 'has_target': actual = live(subject?.nativeTarget); break;
        case 'has_tag': actual = Boolean(subject?.hasTag(node.value)); break;
        case 'is_target': actual = Boolean(subject && self.nativeTarget === subject); break;
        case 'target_distance': actual = live(self.nativeTarget) ? Math.hypot(self.location.x - self.nativeTarget.location.x, self.location.y - self.nativeTarget.location.y, self.location.z - self.nativeTarget.location.z) : Infinity; break;
        default: throw new Error('Unmodelled filter: ' + JSON.stringify(node));
    }
    const expected = ['is_family', 'has_tag'].includes(node.test) ? true : node.value;
    if (node.operator === '<') return actual < expected;
    if (node.operator === '<=') return actual <= expected;
    if (node.operator === '>') return actual > expected;
    if (node.operator === '>=') return actual >= expected;
    return ['!=', 'not'].includes(node.operator) ? actual !== expected : actual === expected;
}

// Delayed JSON events, native sensors and basic native targeting are modelled.
// Not a Minecraft emulator: movement, general AI arbitration and Molang require in-game tests.
function harness() {
    const entities = new Map(), pending = [], clock = { currentTick: 1 };
    let controller;
    const dimension = {
        id: 'overworld', blocked: false,
        getBlockFromRay() { return this.blocked ? {} : undefined; },
        getEntities({ location, maxDistance = Infinity } = {}) {
            return [...entities.values()].filter(entity => live(entity) && entity.dimension === this
                && (!location || Math.hypot(entity.location.x - location.x, entity.location.y - location.y, entity.location.z - location.z) <= maxDistance));
        },
    };
    function apply(entity, node) {
        if (!filter(node.filters, entity)) return;
        for (const child of node.sequence ?? []) apply(entity, child);
        for (const group of node.remove?.component_groups ?? []) {
            entity.groupHistory.push(['remove', group]);
            // Removing an override does not restore a previous component automatically.
            entity.groups.delete(group);
            // Conservative removal: no implicit restoration of base/overridden
            // targeting, even for a group absent from the mock's saved set.
            for (const name of Object.keys(orc.component_groups[group])) entity.components.delete(name);
        }
        for (const group of node.add?.component_groups ?? []) {
            entity.groupHistory.push(['add', group]);
            entity.groups.add(group);
            for (const [name, value] of Object.entries(orc.component_groups[group])) entity.components.set(name, value);
            assert.ok(collisionGroups.filter(name => entity.groups.has(name)).length <= 1,
                `${entity.id}: collision overrides must never overlap, including inside a sequence`);
        }
        for (const [name, value] of Object.entries(node.set_property ?? {})) entity.setProperty(name, value);
        if (node.trigger) entity.triggerEvent(node.trigger);
    }
    function add(id, variant = 'warlord', x = 0, z = 0, families) {
        const isOrc = !families;
        const entity = {
            id, typeId: isOrc ? P + 'orc' : families.includes('player') ? 'minecraft:player' : 'minecraft:' + id,
            isValid: true, health: 100, families: families ?? ['orc', 'greenskin', variant],
            location: { x, y: 0, z }, dimension, tags: new Set(), groups: new Set(), components: new Map(), groupHistory: [],
            properties: Object.fromEntries(Object.entries(orc.description.properties).map(([name, def]) => [name, def.default])),
            nativeTarget: null, canAcquire: true, canAcquireNative: true, bpHadTarget: null, bpEnabled: true, gameMode: 'survival',
            nativeRamAttacking: false, bpRamState: ramController.initial_state,
            get target() { throw new Error('Stable API has no entity.target'); },
            getProperty(name) { return this.properties[name]; },
            setProperty(name, value) { this.properties[name] = value; },
            getComponent(name) {
                if (name === 'minecraft:health') return { currentValue: this.health };
                if (name === 'minecraft:type_family') return { hasTypeFamily: name => family(this, name) };
                if (name === 'minecraft:projectile' && this.projectile) return this.projectile;
            },
            getGameMode() { return this.gameMode; },
            getHeadLocation() { return { ...this.location, y: this.location.y + 1 }; },
            hasTag(name) { return this.tags.has(name); }, addTag(name) { this.tags.add(name); }, removeTag(name) { this.tags.delete(name); },
            triggerEvent(name) { assert.ok(orc.events[name], name); pending.push({ entity: this, name }); },
        };
        set(entity, 'orc_variant', variant);
        if (isOrc) {
            entity.components = new Map(Object.entries(orc.components));
            apply(entity, orc.events['spawn_as_' + variant] ?? { add: { component_groups: [variant] } });
        }
        entities.set(id, entity);
        return entity;
    }
    controller = createController({ getEntity: id => entities.get(id) }, clock,
        { isValidEntity: live, isGreenskin: entity => family(entity, 'greenskin'), hasFamily: family });
    function step(ticks = 5) {
        for (let index = 0; index < ticks; index++) {
            clock.currentTick++;
            for (const { entity, name } of pending.splice(0)) if (live(entity)) {
                apply(entity, orc.events[name]);
                if (['warchief', 'warlord'].includes(get(entity, 'orc_variant'))) {
                    assert.ok(offensiveGoals(entity).length <= 1, `${name}: incompatible offensive goals must not coexist`);
                    if (get(entity, 'leadership_state') === 'ordering') assert.equal(offensiveGoals(entity).length, 0, name);
                }
                if (get(entity, 'orc_variant') === 'warlord') {
                    const ramming = entity.groups.has('warlord_ram');
                    assert.deepEqual(entity.components.get(collision), ramming ? ramBox : normalBox, `${name}: explicit collision restoration`);
                    if (ramming) assert.equal(entity.components.has('minecraft:behavior.hold_ground'), false, `${name}: no hold during ram`);
                }
                if (name.startsWith('leadership_')) controller.nativeEvent(entity, name);
            }
            for (const entity of entities.values()) {
                if (!live(entity)) continue;
                if (!live(entity.nativeTarget)) entity.nativeTarget = null;
                const exactOrder = entity.groups.has('leadership_order_target');
                const nativeLeader = ['warlord', 'warchief'].includes(get(entity, 'orc_variant')) && entity.typeId === P + 'orc';
                if (clock.currentTick % 10 === 0 && (exactOrder ? entity.canAcquire : nativeLeader && entity.canAcquireNative && !live(entity.nativeTarget))) {
                    const goal = entity.components.get('minecraft:behavior.nearest_attackable_target');
                    const candidates = !goal ? [] : dimension.getEntities({ location: entity.location, maxDistance: goal.within_radius ?? 32 })
                        .filter(candidate => candidate !== entity && filter(goal.entity_types[0].filters, entity, candidate)
                            && !['creative', 'spectator'].includes(candidate.gameMode))
                        .sort((a, b) => Math.hypot(a.location.x - entity.location.x, a.location.z - entity.location.z) - Math.hypot(b.location.x - entity.location.x, b.location.z - entity.location.z));
                    const previous = entity.nativeTarget;
                    entity.nativeTarget = candidates[0] ?? null;
                    const hook = entity.components.get('minecraft:on_target_acquired')?.event;
                    if (entity.nativeTarget && entity.nativeTarget !== previous && hook) entity.triggerEvent(hook);
                }
                if (entity.bpEnabled && entity.typeId === P + 'orc' && (nativeLeader || get(entity, 'follow_orc_leader'))) {
                    const present = live(entity.nativeTarget);
                    if (entity.bpHadTarget !== present) {
                        entity.bpHadTarget = present;
                        entity.triggerEvent(present ? 'leadership_target_present' : 'leadership_target_absent');
                    }
                }
                for (const trigger of entity.components.get('minecraft:environment_sensor')?.triggers ?? []) {
                    if (filter(trigger.filters, entity)) entity.triggerEvent(trigger.event);
                }
                // Drive the actual BP ram controller from a simulated native
                // query edge; merely installing its group never starts it.
                if (entity.bpEnabled && entity.typeId === P + 'orc' && get(entity, 'orc_variant') === 'warlord') {
                    const state = ramController.states[entity.bpRamState];
                    for (const transition of state.transitions ?? []) {
                        const [destination, query] = Object.entries(transition)[0];
                        assert.ok(['query.is_ram_attacking', '!query.is_ram_attacking'].includes(query), query);
                        if (query.startsWith('!') ? entity.nativeRamAttacking : !entity.nativeRamAttacking) continue;
                        for (const command of state.on_exit ?? []) entity.triggerEvent(command.slice(3));
                        entity.bpRamState = destination;
                        for (const command of ramController.states[destination].on_entry ?? []) entity.triggerEvent(command.slice(3));
                        break;
                    }
                }
            }
            if (clock.currentTick % rules.RULES.updateTicks === 0) controller.tick();
            assert.ok([...entities.values()].filter(entity => entity.hasTag(rules.CANDIDATE_TAG)).length <= 1, 'one bridge tag globally');
        }
    }
    function until(predicate, limit = 240) {
        for (let count = 0; count < limit && !predicate(); count++) step(1);
        assert.ok(predicate(), 'condition reached before timeout');
    }
    function leader(id = 'leader', context = 'patrol', x = 0) {
        const entity = add(id, 'warlord', x);
        entity.triggerEvent('leadership_mobile_' + context); controller.register(entity); step(2); return entity;
    }
    function follower(id = 'follower', context = 'patrol', x = 0, z = 4) {
        const entity = add(id, 'bludgeonhand', x, z);
        entity.triggerEvent('leadership_follow_' + context); step(2); return entity;
    }
    function nativeRamStart(entity) {
        const goal = entity.components.get(ramGoal);
        assert.ok(goal, 'the native ram goal must be installed');
        for (const trigger of goal.on_start) {
            assert.equal(trigger.target, 'self'); entity.triggerEvent(trigger.event);
        }
        entity.nativeRamAttacking = true;
    }
    return { controller, entities, clock, dimension, pending, add, apply, step, until, leader, follower, nativeRamStart };
}

test('contextual leadership is opt-in and never subordinates another leader', () => {
    const h = harness(), warchief = h.add('chief', 'warchief');
    assert.equal(get(warchief, 'mobile_leader'), false);
    h.apply(warchief, orc.events.leadership_mobile_patrol);
    assert.equal(get(warchief, 'mobile_leader'), false);
    h.apply(warchief, orc.events.leadership_mobile_advanced_horde);
    assert.equal(get(warchief, 'mobile_leader'), true);
    h.apply(warchief, orc.events.leadership_follow_advanced_horde);
    assert.equal(get(warchief, 'follow_orc_leader'), false);
    assert.equal(rules.mobileContextAllowed('warchief', 'horde'), false);
});

test('native follow filters require mobile leader, same context and no combat target', () => {
    const h = harness(), leader = h.leader(), follower = h.follower();
    const filters = orc.component_groups.follow_orc_leader['minecraft:behavior.follow_target_leader'].leader_filters;
    assert.equal(filter(filters, follower, leader), true);
    set(leader, 'leadership_context', 'horde'); assert.equal(filter(filters, follower, leader), false);
    set(leader, 'leadership_context', 'patrol'); set(leader, 'mobile_leader', false);
    assert.equal(filter(filters, follower, leader), false);
    set(leader, 'mobile_leader', true); follower.nativeTarget = h.add('player', '', 3, 0, ['player']);
    assert.equal(filter(filters, follower, leader), false);
});

test('threat choice prioritizes recent attacker / damage and golem, not simply nearest', () => {
    const h = harness(), leader = h.leader();
    h.add('near', '', 1, 0, ['monster']);
    h.add('player', '', 4, 0, ['player']);
    const golem = h.add('golem', '', 5, 0, ['irongolem']);
    const attacker = h.add('attacker', '', 10, 0, ['monster']);
    assert.equal(h.controller.selectTarget(leader), golem);
    h.controller.hurt(leader, { damagingEntity: attacker }, 4);
    assert.equal(h.controller.selectTarget(leader), attacker);
    h.step(205); assert.equal(h.controller.selectTarget(leader), golem);
});

test('target choice rejects Greenskins, auxiliaries, creative, distant and blocked candidates', () => {
    const h = harness(), leader = h.leader();
    h.add('spirit', '', 2, 0, ['monster', 'greenskin']);
    h.add('aux', '', 2, 0, ['monster', 'inanimate']);
    h.add('projectile', '', 2, 0, ['monster']).projectile = {};
    h.add('creative', '', 2, 0, ['player']).gameMode = 'creative';
    h.add('far', '', 25, 0, ['irongolem']);
    assert.equal(h.controller.selectTarget(leader), null);
    const valid = h.add('valid', '', 6, 0, ['player']);
    assert.equal(h.controller.selectTarget(leader), valid);
    h.dimension.blocked = true; assert.equal(h.controller.selectTarget(leader), null);
});

test('idle eligible follower gets exact marked enemy; busy, wrong-context and ordinary Orcs keep theirs', () => {
    const h = harness(), leader = h.leader(), idle = h.follower();
    const busy = h.follower('busy'), wrong = h.follower('wrong', 'horde');
    const ordinary = h.add('ordinary', 'bludgeonhand', 1, 5);
    const nearest = h.add('near', '', 2, 0, ['monster']);
    const marked = h.add('golem', '', 6, 0, ['irongolem']); busy.nativeTarget = nearest;
    h.until(() => h.controller.states.get(leader.id).order?.stage === 'active');
    assert.equal(leader.nativeTarget, marked); assert.equal(idle.nativeTarget, marked);
    assert.equal(busy.nativeTarget, nearest); assert.equal(wrong.nativeTarget, null); assert.equal(ordinary.nativeTarget, null);
    assert.equal(get(busy, 'order_active'), false); assert.equal(get(idle, 'order_acquiring'), false);
    assert.equal(marked.hasTag(rules.CANDIDATE_TAG), false);
    assert.equal(h.controller.assignments.get(idle.id).targetId, marked.id);
});

test('Scrapbelly receives and releases leader orders without losing its mode or equipment, including fresh script registration', () => {
    for (const mode of ['ranged', 'melee']) {
        const h = harness(), leader = h.leader();
        const scrap = h.add('scrap-' + mode, 'scrapbelly', 0, 4);
        h.apply(scrap, orc.events.leadership_follow_patrol);
        if (mode === 'melee') h.apply(scrap, orc.events.scrapbelly_switch_to_melee);
        const equipment = scrap.components.get('minecraft:equipment');
        const sensor = scrap.components.get('minecraft:target_nearby_sensor');
        const checkMode = () => {
            assert.equal(scrap.groups.has('scrapbelly_ranged_mode'), mode === 'ranged');
            assert.equal(scrap.groups.has('scrapbelly_melee_mode'), mode === 'melee');
            assert.equal(scrap.components.get('minecraft:equipment'), equipment);
            assert.equal(scrap.components.get('minecraft:target_nearby_sensor'), sensor);
            assert.equal(get(scrap, 'orc_variant'), 'scrapbelly');
            assert.equal(get(scrap, 'follow_orc_leader'), true);
            assert.equal(get(scrap, 'leadership_context'), 'patrol');
        };
        const target = h.add('target', '', 6, 0, ['irongolem']);
        h.until(() => h.controller.states.get(leader.id).order?.stage === 'active');
        assert.equal(scrap.nativeTarget, target);
        assert.equal(h.controller.assignments.get(scrap.id).targetId, target.id);
        checkMode();
        // Tests the production load path against saved entity data in this
        // harness, not Minecraft serialization, /reload or a world restart.
        const fresh = createController({ getEntity: id => h.entities.get(id) }, h.clock,
            { isValidEntity: live, isGreenskin: entity => family(entity, 'greenskin'), hasFamily: family });
        fresh.load(scrap);
        h.step(2);
        checkMode();
        assert.equal(get(scrap, 'order_active'), false);
        assert.equal(scrap.components.get('minecraft:behavior.nearest_attackable_target'),
            orc.component_groups.leadership_default_targeting['minecraft:behavior.nearest_attackable_target']);
    }
});

test('native event rechecks a follower who acquires an enemy between probe and adoption', () => {
    const h = harness(), leader = h.leader(), follower = h.follower();
    const marked = h.add('golem', '', 6, 0, ['irongolem']);
    const other = h.add('other', '', 2, 0, ['monster']);
    h.until(() => h.pending.some(event => event.entity === follower && event.name === 'leadership_accept_order'));
    follower.nativeTarget = other;
    h.until(() => h.controller.states.get(leader.id).order?.stage === 'active');
    assert.equal(leader.nativeTarget, marked); assert.equal(follower.nativeTarget, other);
    assert.equal(h.controller.assignments.has(follower.id), false);
});

test('simultaneous Warlords serialize acquisition without crossing targets', () => {
    const h = harness(), a = h.leader('a'), b = h.leader('b', 'horde', 40);
    const fa = h.follower('fa'), fb = h.follower('fb', 'horde', 40);
    const ta = h.add('ta', '', 3, 0, ['player']), tb = h.add('tb', '', 43, 0, ['player']);
    h.until(() => [a, b].every(entity => h.controller.states.get(entity.id).order?.stage === 'active'));
    assert.equal(a.nativeTarget, ta); assert.equal(fa.nativeTarget, ta);
    assert.equal(b.nativeTarget, tb); assert.equal(fb.nativeTarget, tb);
    assert.equal(h.controller.inspect().bridge, null);
});

test('order has no fixed duration; 15-second cooldown begins only after target dies', () => {
    const h = harness(), leader = h.leader(), follower = h.follower();
    const target = h.add('player', '', 3, 0, ['player']);
    h.until(() => h.controller.states.get(leader.id).order?.stage === 'active');
    const order = h.controller.states.get(leader.id).order;
    h.step(700); assert.equal(h.controller.states.get(leader.id).order, order);
    target.health = 0; h.step(5);
    const state = h.controller.states.get(leader.id), nextMark = state.nextMark;
    assert.equal(state.order, null); assert.ok(nextMark - h.clock.currentTick >= 295);
    h.step(2); assert.equal(get(follower, 'order_active'), false);
    h.add('replacement', '', 3, 0, ['player']);
    h.step(nextMark - h.clock.currentTick - 1); assert.equal(state.order, null);
    h.step(6); assert.ok(state.order);
});

test('dead leader releases acquired followers and removes acquisition tag', () => {
    const h = harness(), leader = h.leader(), follower = h.follower();
    const target = h.add('target', '', 6, 0, ['player']);
    h.until(() => get(follower, 'order_acquiring'));
    leader.health = 0; h.step(15);
    assert.equal(target.hasTag(rules.CANDIDATE_TAG), false);
    assert.equal(get(follower, 'order_active'), false);
    assert.equal(h.controller.assignments.size, 0);
});

test('losing a native combat target does not recover or replace the followers order', () => {
    const h = harness(), leader = h.leader(); h.follower();
    const target = h.add('target', '', 3, 0, ['player']);
    h.until(() => h.controller.states.get(leader.id).order?.stage === 'active');
    const state = h.controller.states.get(leader.id), order = state.order;
    leader.nativeTarget = null; h.step(25);
    h.until(() => state.order?.stage === 'active' && leader.nativeTarget === target);
    assert.equal(state.order, order); assert.equal(state.nextMark, 0);
    assert.equal(target.hasTag(rules.CANDIDATE_TAG), false);
});

test('inaccessible and distant marked targets invalidate without depending on leader movement', () => {
    const h = harness(), leader = h.leader(); h.follower(); h.add('target', '', 10, 0, ['player']);
    h.until(() => h.controller.states.get(leader.id).order?.stage === 'active');
    h.dimension.blocked = true; h.step(165);
    assert.equal(h.controller.states.get(leader.id).order, null);
    const valid = { alive: true, sameDimension: true, distance: 10, inaccessibleFor: 0, stalledFor: 0 };
    assert.equal(rules.orderInvalidReason(valid), null);
    assert.equal(rules.orderInvalidReason({ ...valid, stalledFor: 240 }), null);
    assert.match(rules.orderInvalidReason({ ...valid, distance: 33 }), /32 bloques/);
});

test('external native retarget is never overwritten by the followers marked identity', () => {
    const h = harness(), leader = h.leader(); h.follower();
    const marked = h.add('marked', '', 3, 0, ['player']);
    h.until(() => h.controller.states.get(leader.id).order?.stage === 'active');
    const order = h.controller.states.get(leader.id).order;
    const intruder = h.add('intruder', '', 2, 0, ['monster']); leader.nativeTarget = intruder;
    leader.triggerEvent('leadership_order_target_acquired'); h.step(1);
    h.step(30);
    assert.equal(leader.nativeTarget, intruder); assert.equal(h.controller.states.get(leader.id).order, order);
    assert.equal(order.targetId, marked.id);
});

test('follower acquisition failure leaves native combat independent; reload restores base targeting', () => {
    const h = harness(), leader = h.leader(); h.follower().canAcquire = false;
    const target = h.add('target', '', 6, 0, ['player']);
    h.step(130); assert.equal(h.controller.states.get(leader.id).order.stage, 'active');
    assert.equal(leader.nativeTarget, target);
    assert.equal(leader.groups.has('leadership_order_target'), false);
    assert.equal(target.hasTag(rules.CANDIDATE_TAG), false);
    const fresh = harness(), loaded = fresh.add('loaded');
    fresh.apply(loaded, { add: { component_groups: ['leadership_order_target'] } });
    set(loaded, 'order_active', true);
    fresh.controller.load(loaded); fresh.step(2);
    assert.equal(get(loaded, 'order_active'), false);
    assert.deepEqual(loaded.components.get('minecraft:behavior.nearest_attackable_target'), orc.components['minecraft:behavior.nearest_attackable_target']);
    assert.ok(loaded.components.has('minecraft:behavior.hurt_by_target'));
    assert.ok(fresh.controller.states.get(loaded.id).nextMark > fresh.clock.currentTick);
});

test('native ram keeps its impact values without scripted corridor gating and restores melee on native end', () => {
    const h = harness(), leader = h.leader(); h.add('target', '', 5, 0, ['player']);
    h.until(() => h.controller.states.get(leader.id).ramPhase === 'ram_pending'); h.step(2);
    leader.triggerEvent('leadership_ram_started'); h.step(1);
    assert.equal(leader.components.get('minecraft:attack').damage, 16);
    h.add('ally', '', 4, 0, ['greenskin', 'monster']); h.step(2);
    assert.equal(leader.components.get('minecraft:attack').damage, 16);
    assert.deepEqual(offensiveGoals(leader), [ramGoal]);
    leader.triggerEvent('leadership_ram_finished'); h.step(2);
    assert.equal(leader.components.get('minecraft:attack').damage, 10);
    assert.equal(h.controller.states.get(leader.id).ramPhase, 'melee');
    assert.equal(leader.groups.has('warlord_ram'), false);
    assert.doesNotMatch(script, /\.(?:applyImpulse|teleport|applyKnockback|applyDamage)\(/);
});

test('roar excludes Greenskins from damage and knockback and has clean native completion', () => {
    const h = harness(), chief = h.add('chief', 'warchief'); h.controller.register(chief);
    const ally = h.add('spirit', '', 2, 0, ['greenskin', 'monster']);
    h.step(10); assert.equal(h.controller.states.get(chief.id).roarStarted, null);
    const target = h.add('target', '', 3, 0, ['player']); chief.nativeTarget = target;
    h.controller.hurt(chief, { damagingEntity: target }, 1); h.step(5);
    assert.notEqual(h.controller.states.get(chief.id).roarStarted, null);
    const roar = orc.component_groups.warchief_roar['minecraft:behavior.knockback_roar'];
    assert.equal(filter(roar.damage_filters, chief, ally), false);
    assert.equal(filter(roar.knockback_filters, chief, ally), false);
    assert.equal(filter(roar.damage_filters, chief, target), true);
    chief.triggerEvent('leadership_roar_finished'); h.step(2);
    assert.equal(h.controller.states.get(chief.id).roarStarted, null);
    assert.ok(h.controller.states.get(chief.id).nextRoar - h.clock.currentTick >= 159);
});

test('native ram completion explicitly removes ram and restores melee during cooldown', () => {
    const h = harness(), leader = h.leader(); h.add('target', '', 5, 0, ['player']);
    h.until(() => h.controller.states.get(leader.id).ramPhase === 'ram_pending'); h.step(2);
    leader.triggerEvent('leadership_ram_started'); h.step(2);
    leader.triggerEvent('leadership_ram_finished'); h.step(10);
    assert.equal(leader.components.get('minecraft:attack').damage, 10);
    assert.equal(leader.groups.has('warlord_ram'), false);
    assert.deepEqual(offensiveGoals(leader), [meleeGoal]);
    assert.equal(h.controller.states.get(leader.id).ramPhase, 'melee');
});

test('both leaders spawn in melee-only mode; Warchief retains territorial hold', () => {
    const h = harness();
    for (const name of ['warchief', 'warlord']) {
        const entity = h.add(name, name);
        assert.deepEqual(offensiveGoals(entity), [meleeGoal]);
        assert.ok(entity.groups.has(name + '_melee_mode'));
    }
    assert.ok(h.entities.get('warchief').components.has('minecraft:behavior.hold_ground'));
});

test('Warchief stays melee against one close enemy without pressure, however long it stays close', () => {
    const h = harness(), chief = h.add('chief', 'warchief'); h.controller.register(chief);
    chief.nativeTarget = h.add('enemy', '', 3, 0, ['player']);
    h.step(500);
    assert.deepEqual(offensiveGoals(chief), [meleeGoal]);
    assert.equal(h.controller.states.get(chief.id).roarStarted, null);
});

test('Warchief recent damage permits roar only with an enemy in range and expires after 2.5 seconds', () => {
    const h = harness(), chief = h.add('chief', 'warchief'); h.controller.register(chief);
    const target = h.add('enemy', '', 8, 0, ['player']); chief.nativeTarget = target;
    h.controller.hurt(chief, { damagingEntity: target }, 2); h.step(55);
    target.location.x = 3; h.step(10);
    assert.deepEqual(offensiveGoals(chief), [meleeGoal]);
    h.controller.hurt(chief, { damagingEntity: target }, 2); h.step(10);
    assert.deepEqual(offensiveGoals(chief), [roarGoal]);
    assert.equal(chief.components.get('minecraft:attack').damage, 12);
});

test('Warchief pressure counts two valid enemies, not Greenskins or auxiliaries', () => {
    const h = harness(), chief = h.add('chief', 'warchief'); h.controller.register(chief);
    chief.nativeTarget = h.add('enemy', '', 3, 0, ['player']);
    h.add('greenskin', '', 2, 0, ['greenskin', 'monster']);
    h.add('auxiliary', '', 2, 0, ['inanimate', 'monster']);
    h.add('creative', '', 2, 0, ['player']).gameMode = 'creative';
    h.step(10); assert.deepEqual(offensiveGoals(chief), [meleeGoal]);
    h.add('second_enemy', '', 0, 3, ['irongolem']);
    h.step(10); assert.deepEqual(offensiveGoals(chief), [roarGoal]);
});

test('Warchief returns to melee with independent 2.5-second lock and 8-second roar cooldown', () => {
    const h = harness(), chief = h.add('chief', 'warchief'); h.controller.register(chief);
    chief.nativeTarget = h.add('enemy', '', 3, 0, ['player']);
    h.add('second', '', 0, 3, ['monster']); h.step(10);
    chief.triggerEvent('leadership_roar_finished'); h.step(1);
    const state = h.controller.states.get(chief.id);
    assert.equal(state.meleeUntil - h.clock.currentTick, 50);
    assert.equal(state.nextRoar - h.clock.currentTick, 160);
    assert.deepEqual(offensiveGoals(chief), [meleeGoal]);
    h.step(150); assert.deepEqual(offensiveGoals(chief), [meleeGoal]);
    h.step(15); assert.deepEqual(offensiveGoals(chief), [roarGoal]);
    chief.triggerEvent('leadership_roar_finished'); h.step(1);
    state.nextRoar = h.clock.currentTick; // Isolate the post-roar lock from the longer cooldown.
    h.step(45); assert.deepEqual(offensiveGoals(chief), [meleeGoal]);
    h.step(10); assert.deepEqual(offensiveGoals(chief), [roarGoal]);
});

test('Warchief ignores zero/allied damage; pressure still requires native combat presence', () => {
    const h = harness(), chief = h.add('chief', 'warchief'); h.controller.register(chief);
    const target = h.add('enemy', '', 3, 0, ['player']); chief.nativeTarget = target;
    h.controller.hurt(chief, { damagingEntity: target }, 0);
    h.controller.hurt(chief, { damagingEntity: h.add('ally', 'bludgeonhand') }, 1);
    h.step(10); assert.deepEqual(offensiveGoals(chief), [meleeGoal]);
    chief.nativeTarget = null; chief.canAcquireNative = false; h.step(5);
    h.controller.hurt(chief, { damagingEntity: target }, 2);
    h.step(10); assert.deepEqual(offensiveGoals(chief), [meleeGoal]);
});

for (const d of [2.99, 3, 4, 5, 5.01, 7]) {
    test(`Warlord selects ram only in the inclusive 3–5 band: distance ${d}`, () => {
        const h = harness(), leader = h.add('manual', 'warlord'); h.controller.register(leader);
        h.add('target', '', d, 0, ['player']);
        h.until(() => get(leader, 'leadership_has_target')); h.step(10);
        assert.deepEqual(offensiveGoals(leader), [d >= 3 && d <= 5 ? ramGoal : meleeGoal]);
        assert.equal(h.controller.states.get(leader.id).order, null);
        assert.equal(get(leader, 'mobile_leader'), false);
    });
}

test('native sensor uses 3–5 only for Warlord and preserves the existing Warchief bands', () => {
    const triggers = orc.component_groups.leadership_combat_sensor['minecraft:environment_sensor'].triggers;
    for (const variant of ['warlord', 'warchief']) for (const d of [2.99, 3, 3.99, 4, 5, 5.01, 7, 7.01]) {
        const h = harness(), leader = h.add('sensor_' + variant, variant);
        leader.nativeTarget = h.add('target', '', d, 0, ['player']);
        const min = variant === 'warlord' ? rules.RULES.ramMinDistance : 4;
        const max = variant === 'warlord' ? rules.RULES.ramMaxDistance : 7;
        const band = d < min ? 'near' : d > max ? 'far' : 'ram';
        const matches = triggers.filter(trigger => filter(trigger.filters, leader));
        assert.deepEqual(matches.map(trigger => trigger.event), ['leadership_target_' + band], `${variant} at ${d}`);
        h.apply(leader, orc.events[matches[0].event]);
        assert.equal(get(leader, 'leadership_target_band'), band);
        assert.equal(get(leader, 'leadership_has_target'), true);
    }
});

test('selector debug reports <3, >5 and 3–5 without old range labels or repeated entries', () => {
    const h = harness(), leader = h.add('new_range'); h.controller.register(leader);
    const target = h.add('target', '', 2, 0, ['player']), mark = logs.length;
    h.step(20); target.location.x = 6; h.step(20); target.location.x = 4; h.step(100);
    const messages = logs.slice(mark).filter(line => line.includes('new_range'));
    for (const band of ['<3', '>5', '3–5']) {
        assert.equal(messages.filter(line => line.endsWith('distancia usada por selector (nativa): ' + band)).length, 1);
    }
    assert.equal(messages.filter(line => line.includes('melee → ram_pending: distancia inicial nativa=3–5')).length, 1);
    assert.ok(messages.every(line => !/4–7|<4|>7/.test(line)));
});

test('Warlord keeps pending across both range bounds, then keeps active until the native query ends', () => {
    const h = harness(), leader = h.leader(), target = h.add('target', '', 5, 0, ['player']);
    h.until(() => h.controller.states.get(leader.id).ramPhase === 'ram_pending'); h.step(2);
    const state = h.controller.states.get(leader.id), selectedAt = state.ramSelectedAt;
    assert.equal(state.nextRam, 0, 'pending does not start successful-ram cooldown');
    const mark = logs.length;
    for (const x of [2, 6]) {
        target.location.x = x; h.step(10);
        assert.equal(state.ramPhase, 'ram_pending');
        assert.equal(state.ramSelectedAt, selectedAt, 'range changes neither cancel nor restart the pending attempt');
        assert.deepEqual(offensiveGoals(leader), [ramGoal]);
        assert.equal(leader.components.get('minecraft:attack').damage, 10, 'no impact damage before on_start');
    }
    h.nativeRamStart(leader); h.step(2);
    assert.equal(state.ramPhase, 'ram_active');
    assert.equal(state.nextRam, 0, 'cooldown waits for the end, not on_start');
    for (const x of [2, 12, 3, 9]) {
        target.location.x = x; h.step(50);
        assert.deepEqual(offensiveGoals(leader), [ramGoal]);
        assert.equal(state.ramPhase, 'ram_active', 'no active watchdog or range cancellation');
    }
    assert.ok(!logs.slice(mark).some(line => line.includes('distancia usada por selector')));
    leader.nativeRamAttacking = false; h.step(3);
    assert.equal(state.ramPhase, 'melee');
    assert.deepEqual(offensiveGoals(leader), [meleeGoal]);
    assert.ok(state.nextRam > h.clock.currentTick);
    const messages = logs.slice(mark);
    for (const text of ['ram native on_start', 'ram_pending → ram_active', 'ram_active → melee']) {
        assert.equal(messages.filter(line => line.includes(text)).length, 1, text);
    }
});

test('Warlord cannot reselect ram during cooldown; reports the same unavailable reason only once', () => {
    const h = harness(), leader = h.leader(); h.add('target', '', 5, 0, ['player']);
    h.until(() => h.controller.states.get(leader.id).ramPhase === 'ram_pending'); h.step(2);
    leader.triggerEvent('leadership_ram_started'); h.step(2);
    const mark = logs.length;
    leader.triggerEvent('leadership_ram_finished'); h.step(1);
    const state = h.controller.states.get(leader.id);
    assert.equal(state.nextRam - h.clock.currentTick, 200);
    h.step(190);
    assert.deepEqual(offensiveGoals(leader), [meleeGoal]);
    assert.equal(logs.slice(mark).filter(line => line.includes('ram no disponible por cooldown')).length, 1);
    h.step(15); assert.deepEqual(offensiveGoals(leader), [ramGoal]);
});

test('pending keeps one native goal and small collision box for two minutes, then accepts a delayed on_start', () => {
    const h = harness(), leader = h.add('patient_lord'); h.controller.register(leader);
    const target = h.add('target', '', 5, 0, ['player']);
    h.until(() => h.controller.states.get(leader.id).ramPhase === 'ram_pending'); h.step(2);
    const state = h.controller.states.get(leader.id), selectedAt = state.ramSelectedAt, mark = logs.length;
    const historyStart = leader.groupHistory.length;
    const installedGoal = leader.components.get(ramGoal);
    for (const x of [3, 9, 5, 2]) {
        target.location.x = x; h.step(600);
        assert.equal(state.ramPhase, 'ram_pending');
        assert.equal(state.ramSelectedAt, selectedAt);
        assert.deepEqual(offensiveGoals(leader), [ramGoal]);
        assert.deepEqual(leader.components.get(collision), ramBox);
        assert.equal(leader.components.get(ramGoal), installedGoal);
        assert.equal(state.nextRam, 0); assert.equal(state.ramRetryUntil, 0);
    }
    assert.equal(leader.groupHistory.filter(([op, name]) => op === 'add' && name === 'warlord_ram').length, 1);
    assert.deepEqual(leader.groupHistory.slice(historyStart), [], 'no group reinstall/removal during the wait');
    assert.deepEqual(logs.slice(mark).filter(line => line.includes('patient_lord')), [], 'waiting never emits periodic spam');
    assert.equal(rules.RULES.ramStartTimeoutTicks, undefined);
    h.nativeRamStart(leader); h.step(1);
    assert.equal(state.ramPhase, 'ram_active'); assert.equal(state.nextRam, 0);
    const elapsed = h.clock.currentTick - selectedAt;
    assert.equal(logs.slice(mark).filter(line => line.includes(`ram native on_start; espera en ram_pending: ${elapsed} ticks (${(elapsed / 20).toFixed(2)} s)`)).length, 1);
    leader.nativeRamAttacking = false; h.step(3);
    assert.equal(state.ramPhase, 'melee'); assert.deepEqual(leader.components.get(collision), normalBox);
    assert.ok(state.nextRam > h.clock.currentTick);
});

test('only the goal on_start confirms active; a query cycle or finish callback while pending cannot tear down ram', () => {
    const h = harness(), leader = h.add('on_start_only'); h.controller.register(leader);
    h.add('target', '', 5, 0, ['player']);
    h.until(() => h.controller.states.get(leader.id).ramPhase === 'ram_pending'); h.step(2);
    const state = h.controller.states.get(leader.id);
    assert.deepEqual(orc.component_groups.warlord_ram[ramGoal].on_start, [{ event: 'leadership_ram_started', target: 'self' }]);
    assert.equal(ramController.states.ram.on_entry, undefined, 'BP query is not a second on_start source');
    leader.nativeRamAttacking = true; h.step(3);
    assert.equal(state.ramPhase, 'ram_pending');
    leader.nativeRamAttacking = false; h.step(3);
    assert.equal(state.ramPhase, 'ram_pending');
    assert.deepEqual(offensiveGoals(leader), [ramGoal]);
    assert.equal(state.nextRam, 0);
    h.nativeRamStart(leader); h.step(3);
    assert.equal(state.ramPhase, 'ram_active');
    leader.nativeRamAttacking = false; h.step(3);
    assert.equal(state.ramPhase, 'melee');
    assert.deepEqual(offensiveGoals(leader), [meleeGoal]);
});

test('on_start at the former two-second deadline is accepted; duplicate/late callbacks cannot restart or extend cooldown', () => {
    const h = harness(), leader = h.add('deadline_lord'); h.controller.register(leader);
    h.add('target', '', 5, 0, ['player']);
    h.until(() => h.controller.states.get(leader.id).ramPhase === 'ram_pending');
    const state = h.controller.states.get(leader.id), deadline = state.ramSelectedAt + 40;
    h.until(() => h.clock.currentTick === deadline - 1);
    h.nativeRamStart(leader); h.step(1);
    assert.equal(state.ramPhase, 'ram_active'); assert.equal(state.nextRam, 0);
    leader.triggerEvent('leadership_ram_started'); h.step(5);
    assert.equal(state.ramPhase, 'ram_active'); assert.equal(state.nextRam, 0);
    leader.nativeRamAttacking = false; h.step(3);
    const cooldownEnd = state.nextRam;
    leader.triggerEvent('leadership_ram_started'); leader.triggerEvent('leadership_ram_finished'); h.step(5);
    assert.equal(state.ramPhase, 'melee'); assert.equal(state.nextRam, cooldownEnd);
    assert.deepEqual(offensiveGoals(leader), [meleeGoal]);
    assert.equal(leader.components.get('minecraft:attack').damage, 10);
});

for (const active of [false, true]) {
    test(active ? 'active ram ignores target death until native completion, then starts full cooldown'
        : 'pending ram still aborts on real target loss, with retry only', () => {
        const h = harness(), leader = h.add('lost_target'); h.controller.register(leader);
        const target = h.add('target', '', 5, 0, ['player']);
        h.until(() => h.controller.states.get(leader.id).ramPhase === 'ram_pending'); h.step(2);
        if (active) { h.nativeRamStart(leader); h.step(2); }
        const state = h.controller.states.get(leader.id), mark = logs.length;
        target.health = 0; h.step(10);
        if (active) {
            assert.equal(state.ramPhase, 'ram_active'); assert.deepEqual(offensiveGoals(leader), [ramGoal]);
            assert.deepEqual(leader.components.get(collision), ramBox); assert.equal(state.nextRam, 0);
            assert.equal(logs.slice(mark).filter(line => line.includes('native target absent durante ram_active: NO cancela')).length, 1);
            leader.nativeRamAttacking = false; h.step(3);
        }
        assert.equal(state.ramPhase, 'melee'); assert.deepEqual(offensiveGoals(leader), [meleeGoal]);
        assert.equal(state.nextRam > h.clock.currentTick, active);
        assert.equal(logs.slice(mark).filter(line => line.includes('pérdida/invalidez del target nativo')).length, active ? 0 : 1);
        leader.nativeRamAttacking = false; const cooldown = state.nextRam; h.step(10);
        assert.equal(state.nextRam, cooldown, 'late native end after cancellation does not restart cooldown');
    });
}

test('native target absent after on_start cannot cancel either preparation or the physical ram query cycle', () => {
    const h = harness(), leader = h.add('native_target_release'); h.controller.register(leader);
    const target = h.add('target', '', 4, 0, ['player']);
    h.until(() => h.controller.states.get(leader.id).ramPhase === 'ram_pending'); h.step(2);
    const state = h.controller.states.get(leader.id), mark = logs.length;
    // on_start can precede the first true query.is_ram_attacking sample.
    leader.triggerEvent('leadership_ram_started'); h.step(1);
    assert.equal(state.ramPhase, 'ram_active'); assert.equal(leader.nativeRamAttacking, false);
    const historyStart = leader.groupHistory.length;
    leader.nativeTarget = null; leader.canAcquireNative = false; h.step(100);
    assert.equal(get(leader, 'leadership_has_target'), false);
    assert.equal(state.ramPhase, 'ram_active'); assert.equal(state.nextRam, 0);
    assert.deepEqual(leader.components.get(collision), ramBox);
    leader.nativeRamAttacking = true; h.step(10);
    leader.nativeTarget = target; h.step(10);
    leader.nativeTarget = null; h.step(100);
    assert.equal(state.ramPhase, 'ram_active'); assert.equal(state.nextRam, 0);
    assert.deepEqual(offensiveGoals(leader), [ramGoal]);
    assert.deepEqual(leader.groupHistory.slice(historyStart), [], 'target edges never remove/reinstall the active goal');
    assert.equal(logs.slice(mark).filter(line => line.includes('native target absent durante ram_active: NO cancela')).length, 1);
    leader.nativeRamAttacking = false; h.step(3);
    assert.equal(state.ramPhase, 'melee'); assert.deepEqual(offensiveGoals(leader), [meleeGoal]);
    assert.deepEqual(leader.components.get(collision), normalBox);
    assert.ok(state.nextRam - h.clock.currentTick >= 198);
    assert.equal(logs.slice(mark).filter(line => line.includes('ram_active → melee: fin nativo')).length, 1);
});

test('a queued marking signal waits for an active ram instead of dismantling it', () => {
    const h = harness(), first = h.leader('first', 'patrol', 0), second = h.leader('second', 'patrol', 20);
    h.follower('first_follower', 'patrol', 0).canAcquire = false;
    h.follower('second_follower', 'patrol', 20).canAcquire = false;
    h.add('first_target', '', 3, 0, ['player']); h.add('second_target', '', 25, 0, ['player']);
    const state = h.controller.states.get(second.id);
    h.until(() => state.order?.stage === 'queued' && state.ramPhase === 'ram_pending'); h.step(2);
    assert.equal(h.controller.inspect().bridge.leaderId, first.id);
    h.nativeRamStart(second); h.step(100);
    second.nativeTarget = null; second.canAcquireNative = false; h.step(20);
    assert.equal(state.ramPhase, 'ram_active'); assert.equal(state.order.stage, 'queued');
    assert.deepEqual(offensiveGoals(second), [ramGoal]);
    second.nativeRamAttacking = false;
    h.until(() => get(second, 'leadership_state') === 'ordering');
    assert.equal(state.ramPhase, 'melee'); assert.deepEqual(offensiveGoals(second), []);
});

test('a real marking signal may cancel pending, without successful-ram cooldown or an offensive goal during the signal', () => {
    const h = harness(), leader = h.leader(); h.add('target', '', 5, 0, ['player']);
    h.until(() => h.controller.states.get(leader.id).ramPhase === 'ram_pending'); h.step(2);
    const state = h.controller.states.get(leader.id);
    h.follower(); h.until(() => get(leader, 'leadership_state') === 'ordering');
    assert.equal(state.ramPhase, 'melee'); assert.equal(state.nextRam, 0);
    assert.deepEqual(offensiveGoals(leader), []);
    h.until(() => state.order.stage === 'sharing'); h.step(6);
    assert.equal(state.ramPhase, 'ram_pending');
    assert.deepEqual(offensiveGoals(leader), [ramGoal]);
});

test('only a mobile leader with troops poses; late attack callbacks cannot overwrite that pose', () => {
    const h = harness(), leader = h.leader(); h.add('target', '', 5, 0, ['player']);
    h.until(() => h.controller.states.get(leader.id).ramPhase === 'ram_pending'); h.step(2);
    leader.triggerEvent('leadership_ram_started'); h.step(2);
    h.follower();
    leader.triggerEvent('leadership_ram_finished');
    h.until(() => get(leader, 'leadership_state') === 'ordering');
    leader.triggerEvent('leadership_ram_started'); leader.triggerEvent('leadership_ram_finished'); h.step(1);
    assert.equal(get(leader, 'leadership_state'), 'ordering');
    assert.deepEqual(offensiveGoals(leader), []);
    assert.ok(leader.components.has('minecraft:behavior.hold_ground'));
    h.until(() => h.controller.states.get(leader.id).order?.stage === 'active'); h.step(5);
    assert.deepEqual(offensiveGoals(leader), [meleeGoal]);
});

test('Warlord waiting no longer times out; Warchief roar watchdog remains unchanged', () => {
    const h = harness(), leader = h.leader(); h.add('target', '', 5, 0, ['player']);
    h.until(() => h.controller.states.get(leader.id).ramPhase === 'ram_pending'); h.step(100);
    assert.deepEqual(offensiveGoals(leader), [ramGoal]);
    assert.deepEqual(leader.components.get(collision), ramBox);
    const c = harness(), chief = c.add('chief', 'warchief'); c.controller.register(chief);
    chief.nativeTarget = c.add('enemy', '', 3, 0, ['player']); c.add('second', '', 0, 3, ['monster']);
    c.step(80); assert.deepEqual(offensiveGoals(chief), [meleeGoal]);
    assert.ok(c.controller.states.get(chief.id).meleeUntil > c.clock.currentTick);
});

test('context removal releases only actual orders; existing variant target hook is preserved', () => {
    const h = harness(), leader = h.leader(), follower = h.follower();
    h.add('target', '', 3, 0, ['player']);
    h.until(() => h.controller.states.get(leader.id).order?.stage === 'active');
    leader.triggerEvent('leadership_disable_mobile'); h.step(10);
    assert.equal(get(follower, 'order_active'), false);
    const blight = h.add('blight', 'blightshrieker');
    h.apply(blight, orc.events.leadership_release_order);
    h.apply(blight, orc.events.leadership_default_target_acquired);
    assert.ok(h.pending.some(event => event.entity === blight && event.name === 'apply_debuffs'));
});

test('manual Warchief acquires with base targeting even without BP presence callbacks', () => {
    const h = harness(), chief = h.add('manual_chief', 'warchief'); chief.bpEnabled = false;
    const player = h.add('player', '', 12, 0, ['player']); h.controller.register(chief); h.step(20);
    assert.equal(get(chief, 'mobile_leader'), false); assert.equal(get(chief, 'leadership_context'), 'none');
    assert.equal(chief.nativeTarget, player); assert.equal(get(chief, 'leadership_has_target'), true);
    assert.deepEqual(chief.components.get('minecraft:behavior.nearest_attackable_target'), orc.components['minecraft:behavior.nearest_attackable_target']);
    assert.ok(chief.components.has('minecraft:behavior.hurt_by_target'));
    assert.deepEqual(offensiveGoals(chief), [meleeGoal]);
    assert.ok(chief.components.get('minecraft:behavior.hold_ground').priority > chief.components.get(meleeGoal).priority, 'hold must not interrupt melee pursuit');
    chief.triggerEvent('leadership_probe'); h.step(2);
    assert.equal(get(chief, 'leadership_has_target'), true, 'order probe is not a combat signal writer');
});

test('manual Warlord never marks, including direct command event; native sensor remains enough for ram', () => {
    const h = harness(), leader = h.add('manual_warlord'); leader.bpEnabled = false; h.controller.register(leader);
    h.follower(); h.add('player', '', 5, 0, ['player']);
    leader.triggerEvent('leadership_begin_order'); h.step(20);
    assert.deepEqual(offensiveGoals(leader), [ramGoal]);
    assert.equal(h.controller.states.get(leader.id).order, null);
    assert.equal(leader.groups.has('warlord_order_pose'), false);
    assert.equal(leader.groups.has('leadership_order_target'), false);
    assert.equal(h.controller.inspect().bridge, null);
    assert.ok(logs.some(line => line.includes('manual_warlord marking omitido porque mobile=false')));
});

test('native target distance, not nearest enemy/marked enemy/scripted corridor, selects ram', () => {
    const h = harness(), leader = h.add('manual'); h.controller.register(leader);
    leader.nativeTarget = h.add('actual_native', '', 4, 0, ['player']);
    h.add('closer_player', '', 1, 0, ['player']); h.add('ally', 'bludgeonhand', 3, 0);
    h.dimension.getBlockFromRay = () => { throw new Error('combat must not call scripted path/corridor checks'); };
    h.step(20);
    assert.equal(get(leader, 'leadership_target_band'), 'ram');
    assert.deepEqual(offensiveGoals(leader), [ramGoal]);
    assert.equal(h.controller.states.get(leader.id).order, null);
    assert.doesNotMatch(script, /safeRamTarget|inChargeCorridor|ramSafetyTick|entity\.target\s*=/);
});

test('mobile=true without valid context, or a valid leader without troops, does not mark', () => {
    for (const invalidContext of [true, false]) {
        const h = harness(), leader = h.leader(); h.add('player', '', 5, 0, ['player']);
        if (invalidContext) { set(leader, 'leadership_context', 'none'); h.follower(); }
        h.step(30);
        assert.equal(h.controller.states.get(leader.id).order, null);
        assert.equal(leader.groups.has('warlord_order_pose'), false);
        assert.deepEqual(offensiveGoals(leader), [ramGoal]);
    }
});

test('mobile marking chooses a concrete follower target without ever replacing the leaders combat target', () => {
    const h = harness(), leader = h.leader(), follower = h.follower();
    const own = h.add('native_player', '', 1, 0, ['player']);
    const marked = h.add('priority_golem', '', 8, 0, ['irongolem']);
    leader.nativeTarget = own;
    h.until(() => h.controller.states.get(leader.id).order?.stage === 'active'); h.step(5);
    assert.equal(h.controller.states.get(leader.id).order.targetId, marked.id);
    assert.equal(follower.nativeTarget, marked);
    assert.equal(leader.nativeTarget, own);
    assert.equal(get(leader, 'order_acquiring'), false);
    assert.equal(leader.groups.has('leadership_order_target'), false);
    assert.deepEqual(offensiveGoals(leader), [meleeGoal]);
});

test('combat resumes before follower timeout; marked target loss does not abort an unrelated native ram', () => {
    const h = harness(), leader = h.leader(), follower = h.follower(); follower.canAcquire = false;
    const own = h.add('native_player', '', 4, 0, ['player']); leader.nativeTarget = own;
    const marked = h.add('priority_golem', '', 8, 0, ['irongolem']);
    h.until(() => h.controller.states.get(leader.id).order?.stage === 'confirming'); h.step(2);
    assert.equal(h.controller.states.get(leader.id).order.targetId, marked.id);
    assert.deepEqual(offensiveGoals(leader), [ramGoal]);
    leader.triggerEvent('leadership_ram_started'); h.step(2);
    marked.health = 0; h.step(10);
    assert.equal(h.controller.states.get(leader.id).order, null);
    assert.equal(leader.nativeTarget, own);
    assert.deepEqual(offensiveGoals(leader), [ramGoal]);
    assert.equal(leader.components.get('minecraft:attack').damage, 16);
    assert.ok(h.controller.states.get(leader.id).nextMark > h.clock.currentTick);
});

test('offensive mode swaps preserve base targeting for both leaders; absent native target cancels pending ram', () => {
    const h = harness(), chief = h.add('chief', 'warchief'), lord = h.add('lord');
    h.controller.register(chief); h.controller.register(lord);
    const player = h.add('player', '', 5, 0, ['player']); h.step(20);
    for (const [entity, start, finish] of [[chief, 'leadership_start_roar', 'leadership_roar_finished'], [lord, 'leadership_enable_ram', 'leadership_ram_finished']]) {
        const targeting = entity.components.get('minecraft:behavior.nearest_attackable_target');
        h.apply(entity, orc.events[start]); h.apply(entity, orc.events[finish]);
        assert.equal(entity.components.get('minecraft:behavior.nearest_attackable_target'), targeting);
        assert.ok(entity.components.has('minecraft:behavior.hurt_by_target'));
    }
    player.health = 0; h.step(10);
    assert.equal(get(lord, 'leadership_has_target'), false);
    assert.equal(get(lord, 'leadership_target_band'), 'none');
    assert.deepEqual(offensiveGoals(lord), [meleeGoal]);
});

test('native target and distance debug is emitted only when the signal changes', () => {
    const h = harness(), leader = h.add('quiet_lord'); h.controller.register(leader);
    h.add('player', '', 2, 0, ['player']); const start = logs.length;
    h.step(150);
    const messages = logs.slice(start).filter(line => line.includes('quiet_lord'));
    assert.equal(messages.filter(line => line.endsWith('native target present')).length, 1);
    assert.equal(messages.filter(line => line.endsWith('distancia usada por selector (nativa): <3')).length, 1);
    assert.equal(messages.filter(line => line.includes('marking omitido porque mobile=false')).length, 1);
});

test('all new event/group/property/controller references resolve', () => {
    function walk(node) {
        if (!node || typeof node !== 'object') return;
        for (const name of node.component_groups ?? []) assert.ok(orc.component_groups[name], name);
        for (const name of Object.keys(node.set_property ?? {})) assert.ok(orc.description.properties[name], name);
        if (node.event) assert.ok(orc.events[node.event], node.event);
        if (node.trigger) assert.ok(orc.events[node.trigger], node.trigger);
        for (const child of Object.values(node)) walk(child);
    }
    for (const [name, value] of Object.entries(orc.events)) if (name.startsWith('leadership_')) walk(value);
    for (const [name, value] of Object.entries(orc.component_groups)) if (/^(leadership_|warlord|warchief|follow_orc)/.test(name)) walk(value);
    for (const name of [...script.matchAll(/(?:event|phase)\([^\n]*?'(leadership_[a-z_]+)'/g)].map(match => match[1])) assert.ok(orc.events[name], name);
    const bp = JSON.parse(read('mythical_BP/animation_controllers/orc_leadership.json')).animation_controllers;
    const rp = JSON.parse(read('mythical_RP/animation_controllers/orc_leadership.animation_controllers.json')).animation_controllers;
    const client = JSON.parse(read('mythical_RP/entity/orc.entity.json'))['minecraft:client_entity'].description;
    const animations = JSON.parse(read('mythical_RP/animations/orc_leadership.animation.json')).animations;
    for (const id of Object.values(orc.description.animations)) assert.ok(bp[id], id);
    for (const controller of [...Object.values(bp), ...Object.values(rp)]) {
        assert.ok(controller.states[controller.initial_state ?? 'default']);
        for (const state of Object.values(controller.states)) {
            for (const transition of state.transitions ?? []) for (const dest of Object.keys(transition)) assert.ok(controller.states[dest], dest);
            for (const entry of [...state.on_entry ?? [], ...state.on_exit ?? []]) if (entry.startsWith('@s ')) assert.ok(orc.events[entry.slice(3)], entry);
            for (const alias of state.animations ?? []) assert.ok(animations[client.animations[alias]], alias);
        }
    }
    assert.equal(orc.component_groups.warlord_order_pose['minecraft:behavior.hold_ground'].broadcast, false);
    assert.equal(orc.component_groups.warchief['minecraft:behavior.hold_ground'].broadcast, false);
    assert.ok(script.includes('const DEBUG = true;'));
});

test('Warlord preserves collision and impact design; native retry is short and scripted cooldown remains 10 seconds', () => {
    assert.deepEqual(orc.components[collision], normalBox);
    assert.deepEqual(orc.component_groups.warlord_melee_mode[collision], normalBox);
    assert.deepEqual(orc.component_groups.warlord_order_pose[collision], normalBox);
    assert.deepEqual(orc.component_groups.warlord_ram[collision], ramBox);
    assert.deepEqual(orc.component_groups.warlord_ram[ramGoal], {
        priority: 2, run_speed: 1, ram_speed: 2.2, min_ram_distance: 3, ram_distance: 5,
        knockback_force: 4, knockback_height: 0.04, cooldown_range: { min: 0.1, max: 0.1 },
        on_start: [{ event: 'leadership_ram_started', target: 'self' }],
    });
    assert.equal(orc.component_groups.warlord['minecraft:attack'].damage, 10);
    assert.equal(orc.component_groups.warlord_ram_impact['minecraft:attack'].damage, 16);
    assert.equal(rules.RULES.ramCooldownTicks, 200);
    assert.equal(rules.RULES.ramMinDistance, orc.component_groups.warlord_ram[ramGoal].min_ram_distance);
    assert.equal(rules.RULES.ramMaxDistance, orc.component_groups.warlord_ram[ramGoal].ram_distance);
    assert.equal(rules.RULES.ramRetryTicks, 20);
    assert.doesNotMatch(JSON.stringify(orc), /minecraft:attack_cooldown/);
    assert.doesNotMatch(script, /\.(?:applyImpulse|teleport|applyKnockback|applyDamage)\(/);
});

test('manual Warlord swaps collision before on_start, preserves it across distance changes and restores on native end', () => {
    const h = harness(), leader = h.add('collision_cycle');
    assert.deepEqual(leader.components.get(collision), normalBox, 'spawn is normal size');
    h.controller.register(leader); h.step(3);
    const logStart = logs.length, historyStart = leader.groupHistory.length;
    const target = h.add('target', '', 5, 0, ['player']);
    h.until(() => h.controller.states.get(leader.id).ramPhase === 'ram_pending'); h.step(2);
    const state = h.controller.states.get(leader.id);
    const entry = leader.groupHistory.slice(historyStart);
    assert.ok(entry.findIndex(([op, name]) => op === 'remove' && name === 'warlord_melee_mode')
        < entry.findIndex(([op, name]) => op === 'add' && name === 'warlord_ram'));
    assert.deepEqual(leader.components.get(collision), ramBox, 'small box is installed before native preparation');
    assert.equal(leader.nativeRamAttacking, false, 'adding the group is not a native start');
    for (const x of [2, 6]) {
        target.location.x = x; h.step(5);
        assert.equal(state.ramPhase, 'ram_pending'); assert.deepEqual(leader.components.get(collision), ramBox);
    }
    h.nativeRamStart(leader); h.step(2);
    assert.equal(state.ramPhase, 'ram_active'); assert.deepEqual(leader.components.get(collision), ramBox);
    target.location.x = 2; h.step(50);
    assert.deepEqual(leader.components.get(collision), ramBox);
    const exitStart = leader.groupHistory.length;
    leader.nativeRamAttacking = false; h.step(3);
    assert.equal(state.ramPhase, 'melee'); assert.deepEqual(leader.components.get(collision), normalBox);
    const exit = leader.groupHistory.slice(exitStart);
    assert.ok(exit.findIndex(([op, name]) => op === 'remove' && name === 'warlord_ram')
        < exit.findIndex(([op, name]) => op === 'add' && name === 'warlord_melee_mode'));
    assert.equal(get(leader, 'mobile_leader'), false); assert.equal(state.order, null);
    assert.ok(state.nextRam > h.clock.currentTick);
    leader.triggerEvent('leadership_disable_ram'); h.step(20);
    const messages = logs.slice(logStart).filter(line => line.includes('collision_cycle'));
    for (const text of ['melee → ram_pending', 'ram collision box active: 0.9 x 1.3', 'ram native on_start',
        'ram_pending → ram_active', 'ram_active → melee', 'orc collision box restored: 1.2 x 2.7']) {
        assert.equal(messages.filter(line => line.includes(text)).length, 1, text);
    }
});

for (const active of [false, true]) {
    for (const exit of [active ? 'native end after target lost' : 'target lost', 'leadership_disable_ram', 'leadership_reset', 'lifecycle error', 'reload']) {
        test(`collision is explicitly restored from ram_${active ? 'active' : 'pending'} on ${exit}`, () => {
            const h = harness(), leader = h.add('collision_restore'); h.controller.register(leader);
            const target = h.add('target', '', 5, 0, ['player']);
            h.until(() => h.controller.states.get(leader.id).ramPhase === 'ram_pending'); h.step(2);
            h.step(600); // All existing abort/reset paths must still work after a long native preparation.
            if (active) { h.nativeRamStart(leader); h.step(2); }
            assert.deepEqual(leader.components.get(collision), ramBox);
            const mark = logs.length;
            if (exit === 'target lost' || exit === 'native end after target lost') {
                target.health = 0; h.step(10);
                if (active) {
                    assert.equal(h.controller.states.get(leader.id).ramPhase, 'ram_active');
                    assert.deepEqual(leader.components.get(collision), ramBox);
                    leader.nativeRamAttacking = false; h.step(3);
                }
            }
            else if (exit === 'lifecycle error') {
                // canCommand/context reads are guarded; inject a one-off error
                // at the state access used by the actual Warlord update path.
                const state = h.controller.states.get(leader.id);
                Object.defineProperty(state, 'commandDecision', { configurable: true, get() { delete this.commandDecision; throw new Error('injected lifecycle failure'); } });
                h.step(6);
            } else if (exit === 'reload') {
                // Isolate restoration from a new, otherwise eligible attempt
                // immediately after loading the entity into a fresh controller.
                target.location.x = 2; set(leader, 'leadership_target_band', 'near');
                h.controller.states.delete(leader.id); h.controller.load(leader); h.step(2);
            } else { leader.triggerEvent(exit); h.step(2); }
            const state = h.controller.states.get(leader.id);
            assert.equal(state.ramPhase, 'melee');
            assert.equal(leader.groups.has('warlord_ram'), false);
            assert.equal(leader.groups.has('warlord_ram_impact'), false);
            assert.ok(leader.groups.has('warlord_melee_mode'));
            assert.deepEqual(leader.components.get(collision), normalBox);
            assert.deepEqual(offensiveGoals(leader), [meleeGoal]);
            assert.equal(leader.components.get('minecraft:attack').damage, 10);
            if (exit !== 'reload') assert.equal(state.nextRam > h.clock.currentTick, active);
            assert.equal(logs.slice(mark).filter(line => line.includes('orc collision box restored: 1.2 x 2.7')).length, 1);
        });
    }
}

test('a real target loss after a long pending wait restores melee, logs elapsed time and uses only retry lock', () => {
    const h = harness(), leader = h.add('pending_abort'); h.controller.register(leader);
    const target = h.add('target', '', 5, 0, ['player']);
    h.until(() => h.controller.states.get(leader.id).ramPhase === 'ram_pending'); h.step(2);
    const state = h.controller.states.get(leader.id), mark = logs.length;
    h.step(900);
    assert.equal(state.ramPhase, 'ram_pending');
    target.health = 0;
    h.until(() => state.ramPhase === 'melee');
    const elapsed = h.clock.currentTick - state.ramSelectedAt;
    h.step(2);
    assert.deepEqual(leader.components.get(collision), normalBox);
    assert.deepEqual(offensiveGoals(leader), [meleeGoal]);
    assert.equal(state.nextRam, 0); assert.ok(state.ramRetryUntil > h.clock.currentTick);
    for (const text of ['ram_pending → melee: pérdida/invalidez del target nativo',
        `espera en ram_pending: ${elapsed} ticks (${(elapsed / 20).toFixed(2)} s)`, 'orc collision box restored: 1.2 x 2.7']) {
        assert.equal(logs.slice(mark).filter(line => line.includes(text)).length, 1);
    }
});

for (const active of [false, true]) {
    test(`failed restoration event is retried from ram_${active ? 'active' : 'pending'}, not forgotten`, () => {
        const h = harness(), leader = h.add('restore_retry'); h.controller.register(leader);
        const target = h.add('target', '', 5, 0, ['player']);
        h.until(() => h.controller.states.get(leader.id).ramPhase === 'ram_pending'); h.step(2);
        if (active) { h.nativeRamStart(leader); h.step(2); }
        const trigger = leader.triggerEvent.bind(leader);
        let failed = false;
        leader.triggerEvent = name => {
            if (name === 'leadership_disable_ram' && !failed) { failed = true; throw new Error('one-off restore failure'); }
            trigger(name);
        };
        const state = h.controller.states.get(leader.id), mark = logs.length;
        if (active) leader.nativeRamAttacking = false;
        else target.health = 0;
        h.until(() => failed);
        assert.deepEqual(leader.components.get(collision), ramBox);
        assert.notEqual(state.ramPhase, 'melee', 'failed request must not pretend restoration succeeded');
        assert.ok(state.ramRestoreReason);
        h.step(10);
        assert.equal(state.ramPhase, 'melee'); assert.equal(state.ramRestoreReason, null);
        assert.deepEqual(leader.components.get(collision), normalBox);
        assert.deepEqual(offensiveGoals(leader), [meleeGoal]);
        assert.equal(state.nextRam > h.clock.currentTick, active);
        assert.equal(logs.slice(mark).filter(line => line.includes('orc collision box restored: 1.2 x 2.7')).length, 1);
    });
}

test('marking interruption restores melee explicitly before the full-sized non-combat pose', () => {
    const h = harness(), leader = h.leader(); h.add('target', '', 5, 0, ['player']);
    h.until(() => h.controller.states.get(leader.id).ramPhase === 'ram_pending'); h.step(2);
    const mark = leader.groupHistory.length;
    h.follower(); h.until(() => get(leader, 'leadership_state') === 'ordering');
    const sequence = leader.groupHistory.slice(mark);
    const removed = sequence.findIndex(([op, name]) => op === 'remove' && name === 'warlord_ram');
    const restored = sequence.findIndex(([op, name]) => op === 'add' && name === 'warlord_melee_mode');
    const posed = sequence.findIndex(([op, name]) => op === 'add' && name === 'warlord_order_pose');
    assert.ok(removed >= 0 && removed < restored && restored < posed);
    assert.deepEqual(leader.components.get(collision), normalBox);
    assert.deepEqual(offensiveGoals(leader), []);
    assert.ok(leader.components.has('minecraft:behavior.hold_ground'));
    leader.triggerEvent('leadership_release_order'); h.step(3);
    assert.deepEqual(leader.components.get(collision), normalBox);
    assert.deepEqual(offensiveGoals(leader), [meleeGoal]);
});
