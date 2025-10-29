import {
    defaultComponentTypes,
    Entity,
    EntityId,
    Manager,
    SerializableEntity,
    SerializableState,
} from '../ecs/manager';
import {
    deserializeBSON,
    getBSONDeserializer,
    getBsonEncoder,
    getBSONSerializer,
    serializeBSON,
} from '@deepkit/bson';
import { deserialize, serialize, typeOf } from '@deepkit/type';
import assert from 'assert';

type ComponentTypes = defaultComponentTypes & {
    serverOnly: Object;
    genericID: string;
    numericComponent: number;
};

type SerializableComponents = Omit<ComponentTypes, 'serverOnly'>;

type TransmittableEntity = SerializableEntity<Partial<SerializableComponents>>;
// type ComponentPatch = [
//     EntityId,
//     keyof ComponentTypes,
//     ComponentTypes[keyof ComponentTypes]
// ];

const manager = new Manager<ComponentTypes>();

manager
    .createQuery({
        includes: ['numericComponent'],
    })
    .createConsumer();

const entityB = getBsonEncoder(typeOf<TransmittableEntity>(), {
    validation: false,
});

const stateB = getBsonEncoder(
    typeOf<
        SerializableState<
            Partial<SerializableComponents>,
            SerializableComponents,
            TransmittableEntity
        >
    >(),
    {
        validation: false,
    }
);

manager.patchHandlers = {
    register(entity) {
        const time = performance.now();
        const serialized = entityB.encode(entity);
        const newEntity = entityB.decode(serialized);
        console.log(
            '[patchHandlers register]',
            serialized.length,
            // deserialize<typeof manager.Entity>(serialized),
            newEntity,
            'took',
            performance.now() - time
        );
    },
    components(id, components: Partial<ComponentTypes>) {
        const time = performance.now();
        const serialized = entityB.encode({
            id,
            components,
        });

        // const serialized = componentPatch.encode([
        //     id,
        //     componentType,
        //     componentValue,
        // ]);

        // console.log(
        //     '[patchHandlers component]',
        //     serialized,
        //     componentType,
        //     componentValue
        // );

        console.log('deserialized', entityB.decode(serialized));
        console.log('serialize loop', components, performance.now() - time);
    },
    deregister(entity) {
        console.log('[patchHandlers deregister]', entity);
    },
};

const entity = manager.quickEntity({
    serverOnly: {},
    genericID: '112365-45235-23452-2525',
    numericComponent: 3,
});

manager.tick();

entity.components.serverOnly = function () {};
entity.components.genericID = '8259-2348235-2348234-23424';
entity.components.numericComponent += 3;
manager.subTick();

entity.components.genericID = '234-2348235-2348234-23424';
entity.components.numericComponent += 3;
manager.subTick();

entity.components.serverOnly = manager.createEntity();
entity.components.genericID = '8259-55-2348234-23424';
entity.components.numericComponent += 3;
manager.subTick();

entity.components.genericID = '8259-2348235-88-23424';
entity.components.numericComponent += 3;

// test stagedUpdates serialization
assert(stateB.decode(stateB.encode(manager.state)).stagedUpdates.size === 1);
manager.subTick();

manager.tick();

const time = performance.now();
const serializedState = stateB.encode(manager.state);
console.log('serialized manager state', serializedState);
console.log('took', performance.now() - time);

console.log(stateB.decode(serializedState));

manager.deregisterEntity(entity);
