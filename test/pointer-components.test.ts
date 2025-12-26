import assert from 'assert';
import {
    defaultComponentTypes,
    Manager,
    SerializableEntity,
} from '../ecs/manager';

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
    ability: Ability;
    mapTest: Ability;
};

const manager = new Manager<ComponentTypes>();

// Register pointer components
manager.registerPointers({
    ability: abilities,
    mapTest: mappedAbilities,
});

export type TransmittableEntity = SerializableEntity<Partial<ComponentTypes>>;
export const encodeEntity = manager.createSerializer<TransmittableEntity>();
export const decodeEntity = manager.createDeserializer<TransmittableEntity>();

globalThis.manager = manager;

const entity = manager.quickEntity({
    ability: abilities.fireball,
    mapTest: mappedAbilities.get('fireball'),
});

const serialized = encodeEntity(entity);
console.log('serialized', serialized);

// Modify the ability to prove deserialization references the same object
abilities.fireball.anotherStat = 1000;
const deserialized = decodeEntity(serialized);
console.log('deserialized', deserialized);

// After deserialization, ability should be the object reference (not the key string)
assert.ok(deserialized.components.ability === abilities.fireball);
const deserializedEntity = manager.createEntity(deserialized);
console.log(deserializedEntity);

// Should still point to the same object after entity creation
assert.ok(deserializedEntity.components.ability === abilities.fireball);

// And should see the updated value
assert.ok(deserializedEntity.components.ability.anotherStat === 1000);
