import assert from 'assert';
import {
    defaultComponentTypes,
    Manager,
    SerializableEntity,
} from '../ecs/manager';
import { Pointer } from '../ecs/types';
import { typeOf } from '@deepkit/type';

type Ability = {
    stat: number;
    anotherStat: number;
};

const abilities = {
    fireball: {
        stat: 4,
        anotherStat: 1,
    },
} satisfies Record<string, Ability>;

const mappedAbilities = new Map<keyof typeof abilities, Ability>([
    ['fireball', abilities.fireball],
]);

type ComponentTypes = defaultComponentTypes & {
    abilities: {
        blueprint: Pointer<Ability, 'abilities'>;
        cooldownStartAt: number;
    }[];

    mapTest: Pointer<Ability, 'mappedAbilities'>;
};

const manager = new Manager<ComponentTypes>();

// Register pointer data sources
manager.registerPointers({
    abilities,
    mappedAbilities,
});

export type TransmittableEntity = SerializableEntity<Partial<ComponentTypes>>;
export const encodeEntity = manager.createSerializer<TransmittableEntity>();
export const decodeEntity = manager.createDeserializer<TransmittableEntity>();

globalThis.manager = manager;

const entity = manager.quickEntity({
    abilities: [
        {
            blueprint: abilities.fireball,
            cooldownStartAt: 100,
        },
    ],
    mapTest: mappedAbilities.get('fireball'),
});

const serialized = encodeEntity(entity);
console.log('serialized', serialized);

// Modify the ability to prove deserialization references the same object
abilities.fireball.anotherStat = 1000;
const deserialized = decodeEntity(serialized);
console.log('deserialized', deserialized);

// After deserialization, blueprint should be the object reference (not the key string)
assert.ok(
    deserialized.components.abilities[0].blueprint === abilities.fireball
);
assert.ok(deserialized.components.mapTest === mappedAbilities.get('fireball'));

const deserializedEntity = manager.createEntity(deserialized);
console.log(deserializedEntity);

// Should still point to the same object after entity creation
assert.ok(
    deserializedEntity.components.abilities[0].blueprint === abilities.fireball
);
assert.ok(
    deserializedEntity.components.mapTest === mappedAbilities.get('fireball')
);

// And should see the updated value
assert.ok(
    deserializedEntity.components.abilities[0].blueprint.anotherStat === 1000
);
