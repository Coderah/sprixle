import assert from 'assert';
import { vec2 } from 'gl-matrix';
import {
    defaultComponentNames,
    defaultComponentTypes,
    Manager,
} from '../ecs/manager';

type ComponentTypes = defaultComponentTypes & {
    position: vec2;
};

const componentNames = [...defaultComponentNames, 'position'] as const;

const manager = new Manager<ComponentTypes>(componentNames);

const positionQuery = manager.createQuery({
    includes: ['position'],
});

const positionConsumer = positionQuery.createConsumer();

const entity = manager.createEntity('test_entity');
entity.components.updatedAt; //=
entity.components.position = vec2.create(); //?
manager.registerEntity(entity);

assert.equal(positionConsumer.newEntities.size, 1);
assert.equal(positionConsumer.updatedEntities.size, 0);

positionConsumer.forNew((entity) => {
    entity.id;
});

manager.tick();

positionConsumer.newEntities; //=
assert.equal(positionConsumer.updatedEntities.size, 0);

entity.components.position = vec2.create(); //?

manager.subTick(); //?
assert.equal(positionConsumer.updatedEntities.size, 1);

manager.tick();
assert.equal(manager.state.updatedEntities.size, 0);
assert.equal(manager.state.previouslyUpdatedEntities.size, 1);

// Quiet updates test
entity.quietSet('position', vec2.create());

manager.subTick();
assert.equal(manager.state.updatedEntities.size, 0);
