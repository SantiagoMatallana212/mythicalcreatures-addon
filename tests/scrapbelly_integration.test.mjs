import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const json = path => JSON.parse(read(path));
const orc = json('mythical_BP/entities/orc.json')['minecraft:entity'];
const ball = json('mythical_BP/entities/cannonball.json')['minecraft:entity'];
const variant = 'mythicalcreatures:orc_variant';
const ranged = 'scrapbelly_ranged_mode', melee = 'scrapbelly_melee_mode';
const offensive = ['minecraft:behavior.ranged_attack', 'minecraft:behavior.delayed_attack'];

// Models explicit event operations only. This does not simulate native sensor
// timing, AI, equipment application, world serialization or projectile firing.
function modes() {
    const groups = new Set();
    const components = new Map(Object.entries(orc.components));
    const properties = { [variant]: 'scrapbelly' };
    const history = [];
    function apply(node) {
        if (node.filters && properties[node.filters.domain] !== node.filters.value) return;
        for (const child of node.sequence ?? []) apply(child);
        for (const group of node.remove?.component_groups ?? []) {
            history.push(['remove', group]);
            groups.delete(group);
            for (const key of Object.keys(orc.component_groups[group])) components.delete(key);
        }
        for (const group of node.add?.component_groups ?? []) {
            history.push(['add', group]);
            groups.add(group);
            for (const entry of Object.entries(orc.component_groups[group])) components.set(...entry);
            assert.ok(!(groups.has(ranged) && groups.has(melee)));
            assert.ok(offensive.filter(key => components.has(key)).length <= 1);
        }
        Object.assign(properties, node.set_property);
    }
    return { groups, components, properties, history, apply,
        event: name => apply(orc.events[name]) };
}

test('persistent spawn and repeated mode events preserve identity/equipment and exclude overlapping attacks', () => {
    const h = modes();
    h.apply(orc.events['minecraft:entity_spawned'].sequence[0]);
    h.event('spawn_as_scrapbelly');
    assert.ok(h.components.has('minecraft:persistent'));
    assert.ok(h.groups.has(ranged));
    const gear = h.components.get('minecraft:equipment');
    const sensor = h.components.get('minecraft:target_nearby_sensor');
    const targeting = h.components.get('minecraft:behavior.nearest_attackable_target');
    const retaliation = h.components.get('minecraft:behavior.hurt_by_target');
    for (let i = 0; i < 20; i++) {
        for (const [event, mode] of [
            ['scrapbelly_switch_to_melee', melee], ['scrapbelly_switch_to_melee', melee],
            ['scrapbelly_switch_to_ranged', ranged], ['scrapbelly_switch_to_ranged', ranged],
        ]) {
            h.event(event);
            assert.deepEqual(h.history.slice(-2), [['remove', mode === ranged ? melee : ranged], ['add', mode]]);
            assert.ok(h.groups.has(mode));
            assert.equal(h.components.get('minecraft:equipment'), gear);
            assert.equal(h.components.get('minecraft:target_nearby_sensor'), sensor);
            assert.equal(h.components.get('minecraft:behavior.nearest_attackable_target'), targeting);
            assert.equal(h.components.get('minecraft:behavior.hurt_by_target'), retaliation);
            assert.ok(h.components.has('minecraft:persistent'));
        }
    }
    h.event('spawn_as_scrapbelly');
    assert.ok(h.groups.has(ranged));
    assert.ok(!h.groups.has(melee));
});

test('mode guards do not alter Warlord or Ashgnaw; both native loss/range paths return to ranged', () => {
    for (const other of ['warlord', 'ashgnaw']) {
        const h = modes();
        h.properties[variant] = other;
        h.event('scrapbelly_switch_to_melee'); h.event('scrapbelly_switch_to_ranged');
        assert.equal(h.history.length, 0);
    }
    const sensor = orc.component_groups.scrapbelly['minecraft:target_nearby_sensor'];
    assert.ok(sensor.outside_range > sensor.inside_range);
    for (const event of [sensor.on_outside_range.event, sensor.on_vision_lost_inside_range.event]) {
        const h = modes(); h.event('spawn_as_scrapbelly'); h.event('scrapbelly_switch_to_melee'); h.event(event);
        assert.ok(h.groups.has(ranged) && !h.groups.has(melee));
    }
});

test('internal hand cannon and projectile resources resolve without migrating the Orc', () => {
    assert.equal(json('mythical_BP/entities/orc.json').format_version, '1.26.30');
    const gear = orc.component_groups.scrapbelly['minecraft:equipment'];
    assert.deepEqual(gear.slot_drop_chance, [{ slot: 'slot.weapon.mainhand', drop_chance: 0 }]);
    const item = json('mythical_BP/items/hand_cannon.json')['minecraft:item'];
    assert.equal(json('mythical_BP/' + gear.table).pools[0].entries[0].name, item.description.identifier);
    assert.equal(item.description.menu_category, undefined);
    const attachment = json('mythical_RP/attachables/hand_cannon.attachable.json')['minecraft:attachable'].description;
    assert.equal(attachment.identifier, item.description.identifier);
    const geo = json('mythical_RP/models/entity/attachable/hand_cannon.geo.json')['minecraft:geometry'][0];
    assert.equal(attachment.geometry.default, geo.description.identifier);
    assert.equal(geo.bones[0].binding, 'q.item_slot_to_bone_name(c.item_slot)');
    assert.ok(existsSync(new URL('../mythical_RP/' + attachment.textures.default + '.png', import.meta.url)));
    const client = json('mythical_RP/entity/cannonball.entity.json')['minecraft:client_entity'].description;
    assert.equal(client.identifier, ball.description.identifier);
    assert.equal(client.geometry.default,
        json('mythical_RP/models/entity/cannonball.geo.json')['minecraft:geometry'][0].description.identifier);
    const render = json('mythical_RP/render_controllers/cannonball.render_controllers.json').render_controllers;
    assert.ok(render[client.render_controllers[0]]);
    assert.ok(existsSync(new URL('../mythical_RP/' + client.textures.default + '.png', import.meta.url)));
    assert.ok(json('mythical_RP/manifest.json').capabilities.includes('pbr'));
    const materials = json('mythical_RP/materials/entity.material').materials;
    assert.ok(Object.keys(materials).some(name => name.split(':')[0] === client.materials.default));
});

test('Scrapbelly remains a single physical direct-impact projectile, not an explosive/fire attack', () => {
    const projectile = ball.components['minecraft:projectile'];
    assert.equal(ball.description.runtime_identifier, undefined);
    assert.equal(projectile.power, 3);
    assert.equal(projectile.uncertainty_base, 0);
    assert.equal(projectile.uncertainty_multiplier, 0);
    assert.equal(projectile.multiple_targets, false);
    assert.deepEqual(Object.keys(projectile.on_hit).sort(), ['impact_damage', 'remove_on_hit']);
    assert.equal(ball.components['minecraft:explode'], undefined);
    assert.equal(ball.components['minecraft:area_attack'], undefined);
    assert.equal(projectile.on_hit.impact_damage.catch_fire, undefined);
    assert.equal(orc.component_groups[ranged]['minecraft:shooter'].def, ball.description.identifier);
    assert.notEqual(orc.component_groups.ashgnaw_ranged_mode['minecraft:shooter'].def, ball.description.identifier);
    const goblin = json('mythical_BP/entities/goblin.json')['minecraft:entity'];
    const bomb = json('mythical_BP/entities/dynamite_projectile.json')['minecraft:entity'];
    assert.equal(goblin.component_groups.bombchucker['minecraft:shooter'].def, bomb.description.identifier);
    assert.notEqual(bomb.description.identifier, ball.description.identifier);
    assert.ok(bomb.component_groups.explode_on_hit['minecraft:explode']);
});

test('Shieldlug guard script leaves cancelled ally hits and non-Goblin combat untouched', () => {
    const callbacks = {};
    const signal = name => ({ subscribe: fn => { callbacks[name] = fn; } });
    const world = {
        beforeEvents: { entityHurt: signal('hurt') },
        afterEvents: Object.fromEntries(['entityHurt', 'worldLoad', 'entitySpawn', 'entityLoad', 'entityDie']
            .map(name => [name, signal(name)])),
    };
    const system = { run() {}, runTimeout() {}, runInterval() {} };
    const source = read('mythical_BP/scripts/goblin/shieldlug_combat.js').replace(/^import .*;\r?\n/gm, '');
    new Function('world', 'system', 'hasFamily', 'isGreenskin', 'isValidEntity', source)
        (world, system, (e, f) => e.families?.includes(f), e => e.families?.includes('greenskin'), e => Boolean(e?.isValid));
    const shield = { id: 'shieldlug', typeId: 'mythicalcreatures:goblin',
        getProperty: key => key.endsWith('goblin_variant') ? 'shieldlug' : 'bashing',
        location: { x: 0, y: 0, z: 0 }, getViewDirection: () => ({ x: 0, y: 0, z: 1 }) };
    const damageSource = { damagingEntity: { id: 'enemy', isValid: true, location: { x: 0, y: 0, z: 4 } } };
    const cancelled = { hurtEntity: shield, damageSource, cancel: true, damage: 8 };
    callbacks.hurt(cancelled);
    assert.equal(cancelled.cancel, true); assert.equal(cancelled.damage, 8);
    const enemy = { hurtEntity: shield, damageSource, cancel: false, damage: 8 };
    callbacks.hurt(enemy);
    assert.equal(enemy.cancel, false); assert.equal(enemy.damage, 4.4);
    const orcHit = { hurtEntity: { typeId: 'mythicalcreatures:orc' }, damageSource, cancel: false, damage: 8 };
    callbacks.hurt(orcHit);
    assert.equal(orcHit.cancel, false); assert.equal(orcHit.damage, 8);
    const bash = json('mythical_BP/entities/goblin.json')['minecraft:entity'].component_groups.shieldlug_bashing;
    assert.equal(bash['minecraft:behavior.delayed_attack'].attack_duration, 0.7);
    assert.equal(bash['minecraft:attack'].damage, 3);
});
