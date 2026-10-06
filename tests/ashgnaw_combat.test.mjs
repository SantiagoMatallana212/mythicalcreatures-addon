import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const orc = JSON.parse(read('mythical_BP/entities/orc.json'))['minecraft:entity'];
const variant = 'mythicalcreatures:orc_variant';
const mode = 'mythicalcreatures:ashgnaw_combat_mode';
const rangedGoal = 'minecraft:behavior.ranged_attack';
const meleeGoal = 'minecraft:behavior.melee_box_attack';
const knockback = 'minecraft:apply_knockback_rules';
const visual = JSON.parse(read('mythical_RP/animation_controllers/ashgnaw.animation_controllers.json'))
    .animation_controllers['controller.animation.orc.ashgnaw_melee'];

// Models event/group swaps, not Minecraft's sensor, scheduler or physical movement.
function modes(initialVariant = 'ashgnaw') {
    const props = { [variant]: initialVariant, [mode]: 'ranged' };
    const groups = new Set();
    const components = new Map(Object.entries(orc.components));
    function apply(node) {
        if (node.filters && props[node.filters.domain] !== node.filters.value) return;
        for (const step of node.sequence ?? []) apply(step);
        for (const name of node.remove?.component_groups ?? []) {
            groups.delete(name);
            for (const key of Object.keys(orc.component_groups[name])) components.delete(key);
        }
        for (const name of node.add?.component_groups ?? []) {
            groups.add(name);
            for (const entry of Object.entries(orc.component_groups[name])) components.set(...entry);
            assert.ok(!(groups.has('ashgnaw_melee_mode') && groups.has('ashgnaw_ranged_mode')));
        }
        Object.assign(props, node.set_property);
    }
    const trigger = name => apply(orc.events[name]);
    return { props, groups, components, trigger };
}

test('Ashgnaw spawns in ranged with fire immunity, damage 2 and the existing ranged settings', () => {
    const entity = modes();
    entity.trigger('spawn_as_ashgnaw');
    assert.equal(entity.props[mode], 'ranged');
    assert.equal(entity.components.has(meleeGoal), false);
    assert.equal(entity.components.has(knockback), false);
    assert.deepEqual(entity.components.get('minecraft:fire_immune'), {});
    assert.deepEqual(entity.components.get('minecraft:attack'), { damage: 2 });
    assert.deepEqual(entity.components.get(rangedGoal), {
        priority: 2, attack_interval_min: 1, attack_interval_max: 3, attack_radius: 15
    });
    assert.deepEqual(entity.components.get('minecraft:shooter'), {
        def: 'mythicalcreatures:explosive_bottle_projectile'
    });
    assert.equal(orc.components['minecraft:fire_immune'], undefined);
});

test('Blaze-style 2/3 sensor preserves the selected mode inside the hysteresis band', () => {
    const entity = modes();
    entity.trigger('spawn_as_ashgnaw');
    const sensor = entity.components.get('minecraft:target_nearby_sensor');
    assert.equal(sensor.inside_range, 2);
    assert.equal(sensor.outside_range, 3);
    assert.equal(sensor.must_see, true);
    for (const [distance, expected] of [[5, 'ranged'], [2.5, 'ranged'], [1.8, 'melee'],
        [2.2, 'melee'], [2.9, 'melee'], [3.2, 'ranged'], [2.4, 'ranged']]) {
        if (distance < sensor.inside_range) entity.trigger(sensor.on_inside_range.event);
        if (distance > sensor.outside_range) entity.trigger(sensor.on_outside_range.event);
        assert.equal(entity.props[mode], expected);
        assert.equal(entity.components.has(rangedGoal), expected === 'ranged');
        assert.equal(entity.components.has(meleeGoal), expected === 'melee');
        assert.equal(entity.components.has(knockback), expected === 'melee');
        assert.equal(entity.components.has('minecraft:shooter'), expected === 'ranged');
        assert.equal(entity.components.get('minecraft:target_nearby_sensor'), sensor);
        assert.equal(entity.components.has('minecraft:fire_immune'), true);
        assert.equal(entity.components.get('minecraft:attack').damage, 2);
        assert.equal(entity.components.get('minecraft:behavior.nearest_attackable_target'),
            orc.components['minecraft:behavior.nearest_attackable_target']);
    }
});

test('vision loss and explicit Ashgnaw reset remove melee and restore ranged', () => {
    const entity = modes();
    entity.trigger('spawn_as_ashgnaw');
    entity.trigger('ashgnaw_switch_to_melee');
    entity.trigger(orc.component_groups.ashgnaw['minecraft:target_nearby_sensor'].on_vision_lost_inside_range.event);
    assert.equal(entity.props[mode], 'ranged');
    assert.equal(entity.components.has(knockback), false);
    entity.trigger('ashgnaw_switch_to_melee');
    entity.trigger('spawn_as_ashgnaw');
    assert.equal(entity.components.has(meleeGoal), false);
    assert.equal(entity.components.has(rangedGoal), true);
    assert.equal(entity.components.has(knockback), false);
});

test('Ashgnaw events do not activate attack modes or fire immunity on another Orc', () => {
    for (const other of ['warchief', 'warlord', 'hexmaw', 'spinecleaver']) {
        const entity = modes(other);
        entity.trigger('ashgnaw_switch_to_melee');
        entity.trigger('ashgnaw_switch_to_ranged');
        assert.equal(entity.groups.size, 0);
        assert.equal(entity.components.has('minecraft:fire_immune'), false);
    }
});

test('Ashgnaw keeps its validated melee knockback alongside the separate Scrapbelly bash', () => {
    const presets = orc.component_groups.ashgnaw_melee_mode[knockback].presets;
    const enemy = presets.find(p => p.filter.operator === '!=');
    assert.equal(enemy.horizontal_power, 3);
    assert.equal(enemy.vertical_power, 0.1);
    assert.equal(enemy.vertical_velocity_cap, 0.4);
    assert.equal(enemy.knockback_mode, 'relative_horizontal');
    assert.equal(enemy.extra_knockback_approach, 'multiply_reduced');
    assert.deepEqual(enemy.filter, {
        test: 'is_family', subject: 'other', operator: '!=', value: 'greenskin'
    });
    assert.equal(orc.components[knockback], undefined);
    assert.deepEqual(Object.entries(orc.component_groups).filter(([, group]) => group[knockback])
        .map(([name]) => name), ['ashgnaw_melee_mode', 'scrapbelly_melee_mode']);
});

test('Greenskins receive neither native shove nor extra knockback from sprinting/enchantments', () => {
    const ally = orc.component_groups.ashgnaw_melee_mode[knockback].presets[0];
    assert.deepEqual(ally.filter, { test: 'is_family', subject: 'other', value: 'greenskin' });
    assert.equal(ally.horizontal_power, 0);
    assert.equal(ally.vertical_power, 0);
    assert.equal(ally.slowdown_scale, 1);
    assert.equal(ally.extra_knockback_approach, 'multiply_reduced');
});

test('Ashgnaw keeps base damage 2 without inheriting axe damage or introducing a bottle drop', () => {
    const equipment = orc.component_groups.ashgnaw['minecraft:equipment'];
    const gear = JSON.parse(read('mythical_BP/' + equipment.table));
    const entries = gear.pools.flatMap(pool => pool.entries);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, 'mythicalcreatures:explosive_bottle');
    assert.equal(entries[0].functions, undefined);
    const item = JSON.parse(read('mythical_BP/items/explosive_bottle.json'))['minecraft:item'];
    assert.equal(item.components['minecraft:damage'], undefined);
    assert.deepEqual(orc.component_groups.ashgnaw['minecraft:attack'], { damage: 2 });
    assert.deepEqual(equipment.slot_drop_chance, [{ slot: 'slot.weapon.mainhand', drop_chance: 0 }]);
});

test('removed Script API handler is no longer registered; native component uses the minimum stable format', () => {
    assert.equal(existsSync(new URL('../mythical_BP/scripts/orc/ashgnaw_melee.js', import.meta.url)), false);
    assert.doesNotMatch(read('mythical_BP/scripts/main.js'), /ashgnaw_melee/);
    assert.equal(JSON.parse(read('mythical_BP/entities/orc.json')).format_version, '1.26.30');
});

test('shove animation uses existing bones, terminates and does not drive gameplay', () => {
    const animation = JSON.parse(read('mythical_RP/animations/ashgnaw.animation.json'))
        .animations['animation.orc.ashgnaw.push'];
    const bones = new Set(JSON.parse(read('mythical_RP/models/entity/orc.geo.json'))['geometry.orc'].bones.map(b => b.name));
    assert.equal(animation.loop, false);
    assert.equal(animation.animation_length, 0.35);
    for (const bone of Object.keys(animation.bones)) assert.ok(bones.has(bone), bone);
    const client = JSON.parse(read('mythical_RP/entity/orc.entity.json'))['minecraft:client_entity'].description;
    assert.equal(client.animations.ashgnaw_push, 'animation.orc.ashgnaw.push');
    assert.ok(client.animation_controllers.some(c => c.ashgnaw_melee === 'controller.animation.orc.ashgnaw_melee'));
    assert.equal(orc.description.properties[mode].client_sync, true);
    assert.deepEqual(visual.states.push.animations, ['ashgnaw_push']);
    for (const state of Object.values(visual.states)) {
        assert.equal(state.on_entry, undefined);
        assert.equal(state.on_exit, undefined);
        for (const transition of state.transitions ?? []) assert.ok(visual.states[Object.keys(transition)[0]]);
    }
});

// Evaluate the simple Molang conditions with stubbed query/variable values;
// actual swing timing and the visual result must still be checked in Minecraft.
function transition(state, props, attackTime, animationFinished = false) {
    for (const entry of visual.states[state].transitions ?? []) {
        const [next, expression] = Object.entries(entry)[0];
        if (new Function('query', 'variable', 'return ' + expression)(
            { property: key => props[key], all_animations_finished: animationFinished },
            { attack_time: attackTime })) return next;
    }
    return state;
}

test('native swing starts the shove only for Ashgnaw melee', () => {
    for (const [orcVariant, attackMode, attackTime, expected] of [
        ['ashgnaw', 'melee', 0.1, 'push'],
        ['ashgnaw', 'melee', 0, 'default'],
        ['ashgnaw', 'ranged', 0.1, 'default'],
        ['warlord', 'melee', 0.1, 'default'],
        ['warchief', 'melee', 0.1, 'default']
    ]) assert.equal(transition('default', { [variant]: orcVariant, [mode]: attackMode }, attackTime), expected);
});

test('a shove finishes across ranged transition, cannot loop on the same swing, and can play on the next hit', () => {
    const props = { [variant]: 'ashgnaw', [mode]: 'melee' };
    let state = transition('default', props, 0.1);
    assert.equal(state, 'push');
    props[mode] = 'ranged';
    state = transition(state, props, 0.2);
    assert.equal(state, 'push');
    state = transition(state, props, 0.4, true);
    assert.equal(state, 'wait_for_next_hit');
    state = transition(state, props, 0.5);
    assert.equal(state, 'wait_for_next_hit');
    state = transition(state, props, 0);
    assert.equal(state, 'default');
    props[mode] = 'melee';
    assert.equal(transition(state, props, 0.1), 'push');
});
