import { join } from 'jsr:@std/path@^1';

const src = Deno.env.get('ROOT_DIR')!;

const vanilla = JSON.parse(
    await Deno.readTextFile(join(src, 'vanilla_data/bp/entities/player.json')),
);
const entity = vanilla['minecraft:entity'];

Object.assign(entity.component_groups, {
    'javamechanics:enable': {
        'minecraft:attack': { damage: -10000 },
    },
    'javamechanics:disable': {
        'minecraft:attack': { damage: 1 },
    },
});

Object.assign(entity.events, {
    'javamechanics:enable': {
        add: { component_groups: ['javamechanics:enable'] },
    },
    'javamechanics:disable': {
        add: { component_groups: ['javamechanics:disable'] },
    },
});

await Deno.writeTextFile('player.json', JSON.stringify(vanilla));
