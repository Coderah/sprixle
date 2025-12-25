import assert from 'assert';
import { defaultComponentTypes, Manager } from '../ecs/manager';
import { Nested } from '../ecs/types';

type BasicRecord = {
    [key: string]: string;
};

type MultiLevel = {
    foo: BasicRecord;
    bar: string;
};

type ComponentTypes = defaultComponentTypes & {
    basicRecord: Nested<BasicRecord>;
    deep: Nested<MultiLevel>;
    array: Nested<Array<BasicRecord>>;
};

const manager = new Manager<ComponentTypes>();

globalThis.manager = manager;

const entity = manager.quickEntity({
    array: [{ key: 'value' }, { foo: 'bar' }],
    basicRecord: {
        key: 'value',
    },
    deep: {
        foo: {
            key: 'value',
        },
        bar: 'bop',
    },
});

manager.tick();

entity.components.array.push({ new: 'value' });
entity.components.basicRecord.fluff = 'foof';
entity.components.deep.foo.key = 'newValue';

const stagedUpdates = manager.state.stagedUpdates.get(entity.id);

assert.ok(stagedUpdates.has('basicRecord'));
assert.ok(stagedUpdates.has('deep'));
assert.ok(stagedUpdates.has('array'));
