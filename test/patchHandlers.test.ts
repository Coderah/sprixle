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
    genericID: string;
    numericComponent: number;
};

type SerializableComponents = Omit<ComponentTypes, 'genericID'>;

type ComponentPatch = {
    id: EntityId;
    componentType: keyof ComponentTypes;
    value: ComponentTypes[keyof ComponentTypes];
};

type TransmittableEntity = SerializableEntity<Partial<SerializableComponents>>;
// type ComponentPatch = [
//     EntityId,
//     keyof ComponentTypes,
//     ComponentTypes[keyof ComponentTypes]
// ];

const componentPatch = getBsonEncoder(typeOf<ComponentPatch>(), {
    validation: false,
});

let globalStorage: any;

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
            Partial<ComponentTypes>,
            ComponentTypes,
            TransmittableEntity
        >
    >(),
    {
        validation: false,
    }
);

manager.patchHandlers = {
    newEntity(entity) {
        const time = performance.now();
        const serialized = entityB.encode(entity);
        const newEntity = entityB.decode(serialized);
        console.log(
            '[patchHandlers newEntity]',
            serialized.length,
            // deserialize<typeof manager.Entity>(serialized),
            newEntity,
            'took',
            performance.now() - time
        );
    },
    component(entity, componentType, componentValue) {
        // const time = performance.now();
        const serialized = componentPatch.encode({
            id: entity.id,
            componentType,
            value: componentValue,
        });

        globalStorage = serialized;

        // const serialized = componentPatch.encode([
        //     entity.id,
        //     componentType,
        //     componentValue,
        // ]);

        // console.log(
        //     '[patchHandlers component]',
        //     serialized,
        //     componentType,
        //     componentValue
        // );

        console.log(componentPatch.decode(serialized));
        console.log('serialize loop', componentType);
    },
};

const entity = manager.quickEntity({
    genericID: '112365-45235-23452-2525',
    numericComponent: 3,
});

manager.tick();

entity.components.genericID = '8259-2348235-2348234-23424';
entity.components.numericComponent += 3;

manager.subTick();

entity.components.genericID = '234-2348235-2348234-23424';
entity.components.numericComponent += 3;

manager.subTick();
entity.components.genericID = '8259-55-2348234-23424';
entity.components.numericComponent += 3;

manager.subTick();
entity.components.genericID = '8259-2348235-88-23424';
entity.components.numericComponent += 3;

manager.subTick();

manager.tick();

const time = performance.now();
const serializedState = stateB.encode(manager.state);
console.log('serialized manager state', serializedState);
console.log('took', performance.now() - time);

console.log(stateB.decode(serializedState));
