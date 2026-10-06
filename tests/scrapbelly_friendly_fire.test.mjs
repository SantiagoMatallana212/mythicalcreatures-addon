import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const entity = path => JSON.parse(read(path))['minecraft:entity'];
const orc = entity('mythical_BP/entities/orc.json');
const goblin = entity('mythical_BP/entities/goblin.json');
const cannonball = entity('mythical_BP/entities/cannonball.json');
const tag = 'mythicalcreatures:greenskin_projectile';
const family = components => components['minecraft:type_family'].family;
const allies = [
    ['scrapbelly-a', family(orc.component_groups.scrapbelly)],
    ['scrapbelly-b', family(orc.component_groups.scrapbelly)],
    ['orc', family(orc.components)],
    ['warlord', family(orc.component_groups.warlord)],
    ['warchief', family(orc.component_groups.warchief)],
    ['ashgnaw', family(orc.component_groups.ashgnaw)],
    ['goblin', family(goblin.components)],
];

// Run the actual shared subscriptions with mocked API events; this does not
// simulate Bedrock collision, projectile removal, damage application or motion.
const source = read('mythical_BP/scripts/greenskin/friendly_fire.js')
    .replace(/^import .*;\r?\n/gm, '')
    .replace(/^export function /gm, 'function ');
const subscribe = new Function('world', 'system', source);

function harness() {
    const callbacks = {};
    const signal = name => ({ subscribe: fn => { callbacks[name] = fn; } });
    const pending = [];
    const system = {
        currentTick: 0,
        runTimeout(fn, delay) { pending.push({ fn, tick: this.currentTick + delay }); },
    };
    subscribe({
        afterEvents: { entitySpawn: signal('spawn'), entityLoad: signal('load') },
        beforeEvents: { entityHurt: signal('hurt'), explosion: signal('explosion') },
    }, system);
    return {
        spawn: entity => callbacks.spawn({ entity }),
        load: entity => callbacks.load({ entity }),
        hurt(hurtEntity, damageSource) {
            const event = { hurtEntity, damageSource, damage: 8, cancel: false };
            callbacks.hurt(event);
            return event;
        },
        tick() {
            system.currentTick++;
            const due = pending.filter(task => task.tick <= system.currentTick);
            for (const task of due) pending.splice(pending.indexOf(task), 1);
            for (const task of due) task.fn();
        },
    };
}

function actor(id, families = ['player']) {
    return {
        id, families, tags: new Set(), isValid: true,
        getComponent(name) {
            if (!this.isValid) throw new Error('Unloaded entity');
            if (name === 'minecraft:type_family') {
                return { hasTypeFamily: family => this.families.includes(family) };
            }
            if (name === 'minecraft:projectile') return this.projectile;
        },
        addTag(value) { this.tags.add(value); },
        hasTag(value) { return this.tags.has(value); },
    };
}

function ball(id, owner) {
    const entity = actor(id, family(cannonball.components));
    entity.projectile = { owner };
    return entity;
}

test('Scrapbelly uses the shared protection and every sampled Orc/Goblin is a Greenskin', () => {
    assert.match(read('mythical_BP/scripts/main.js'), /import ['"]\.\/greenskin\/friendly_fire\.js['"]/);
    assert.equal(orc.component_groups.scrapbelly_ranged_mode['minecraft:shooter'].def,
        cannonball.description.identifier);
    for (const [name, families] of allies) assert.ok(families.includes('greenskin'), name);
    assert.ok(!family(cannonball.components).includes('greenskin'));
});

test('native cannonball damage sources cancel ally damage for simultaneous Scrapbellies', () => {
    const h = harness();
    const shooters = allies.slice(0, 2).map(([id, families]) => actor(id, families));
    const shots = shooters.map((owner, index) => ball('shot-' + index, owner));
    for (const shot of shots) h.spawn(shot);
    for (const shot of shots) {
        assert.ok(shot.hasTag(tag));
        for (const [id, families] of allies) {
            const target = actor(id, families);
            for (const damageSource of [
                { cause: 'projectile', damagingProjectile: shot },
                { cause: 'projectile', damagingEntity: shot },
                { cause: 'projectile', damagingEntity: shot.projectile.owner, damagingProjectile: shot },
            ]) assert.equal(h.hurt(target, damageSource).cancel, true, id);
        }
    }
});

test('owner lookup protects an early impact before projectile tagging', () => {
    const h = harness();
    const shooter = actor(...allies[0]);
    const shot = ball('early-shot', shooter);
    assert.ok(!shot.hasTag(tag));
    for (const [id, families] of allies) {
        assert.equal(h.hurt(actor(id, families), {
            cause: 'projectile', damagingProjectile: shot,
        }).cancel, true, id);
    }
});

test('existing spawn/load retries mark an owner assigned on the following tick', () => {
    const owner = actor(...allies[0]);
    for (const event of ['spawn', 'load']) {
        const h = harness();
        const shot = ball(event + '-shot');
        h[event](shot);
        assert.ok(!shot.hasTag(tag));
        shot.projectile.owner = owner;
        h.tick();
        assert.ok(shot.hasTag(tag), event);
        assert.equal(h.hurt(actor(...allies[1]), {
            cause: 'projectile', damagingProjectile: shot,
        }).cancel, true);
    }
});

test('a marked cannonball remains protected after owner loss and entity load', () => {
    const owner = actor(...allies[0]);
    const shot = ball('persistent-shot', owner);
    harness().spawn(shot);
    owner.isValid = false;
    delete shot.projectile.owner;
    const h = harness();
    h.load(shot);
    h.tick();
    h.tick();
    for (const [id, families] of allies) {
        assert.equal(h.hurt(actor(id, families), {
            cause: 'projectile', damagingProjectile: shot,
        }).cancel, true, id);
    }
});

test('cannon bash direct damage is cancelled against every sampled ally', () => {
    const h = harness();
    for (const [shooterId, shooterFamilies] of allies.slice(0, 2)) {
        for (const [id, families] of allies) {
            const event = h.hurt(actor(id, families), {
                cause: 'entityAttack', damagingEntity: actor(shooterId, shooterFamilies),
            });
            assert.equal(event.cancel, true, `${shooterId} -> ${id}`);
        }
    }
});

test('protection preserves enemy hits and does not grant allies general damage immunity', () => {
    const h = harness();
    const owner = actor(...allies[0]);
    const shot = ball('allied-shot', owner);
    h.spawn(shot);
    const enemy = actor('enemy');
    assert.equal(h.hurt(enemy, { cause: 'projectile', damagingProjectile: shot }).cancel, false);
    assert.equal(h.hurt(enemy, { cause: 'entityAttack', damagingEntity: owner }).cancel, false);
    const enemyShot = ball('enemy-shot', enemy);
    h.spawn(enemyShot);
    assert.ok(!enemyShot.hasTag(tag));
    const ally = actor(...allies[1]);
    assert.equal(h.hurt(ally, { cause: 'projectile', damagingProjectile: enemyShot }).cancel, false);
    assert.equal(h.hurt(ally, { cause: 'entityAttack', damagingEntity: enemy }).cancel, false);
    assert.equal(h.hurt(ally, { cause: 'fall' }).cancel, false);
});

test('native knockback presets select zero push for allies without suppressing enemy push', () => {
    const rules = [cannonball.components, orc.component_groups.scrapbelly_melee_mode];
    for (const components of rules) {
        const presets = components['minecraft:apply_knockback_rules'].presets;
        for (const [id, families] of [...allies, ['enemy', ['player']]]) {
            const matches = presets.filter(({ filter }) => {
                assert.equal(filter.test, 'is_family');
                assert.equal(filter.subject, 'other');
                const contains = families.includes(filter.value);
                return filter.operator === '!=' ? !contains : contains;
            });
            assert.equal(matches.length, 1, id);
            const preset = matches[0];
            if (families.includes('greenskin')) {
                assert.equal(preset.horizontal_power, 0, id);
                assert.equal(preset.vertical_power, 0, id);
                assert.equal(preset.slowdown_scale, 1, id);
                assert.equal(preset.extra_knockback_approach, 'multiply_reduced', id);
            } else {
                assert.ok(preset.horizontal_power > 0);
                assert.ok(preset.vertical_power > 0);
            }
        }
    }
});

test('native impact configuration removes an intercepted ball even without damage', () => {
    const projectile = cannonball.components['minecraft:projectile'];
    assert.equal(projectile.multiple_targets, false);
    assert.equal(projectile.should_bounce, 'no');
    assert.equal(projectile.on_hit.impact_damage.destroy_on_hit, true);
    assert.equal(projectile.on_hit.impact_damage.destroy_on_hit_requires_damage, false);
    assert.deepEqual(projectile.on_hit.remove_on_hit, {});
});
