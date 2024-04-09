import assert from 'assert';
import { vec2 } from 'gl-matrix';
import { DEFAULT_COMPONENT_DEFAULTS, Manager } from '../ecs/manager';

const COMPONENT_DEFAULTS = {
    ...DEFAULT_COMPONENT_DEFAULTS,
    position: vec2.create(),
};

const manager = new Manager(COMPONENT_DEFAULTS);

const positionQuery = manager.createQuery({
    includes: ['position'],
});

const positionConsumer = positionQuery.createConsumer();

const entity = manager.createEntity('test_entity');
entity.components.updatedAt; //=
entity.components.position = vec2.create(); //?
manager.registerEntity(entity);

positionQuery.entities; //=
positionConsumer.forUpdated((e) => {
    e.id; //=
});

assert.equal(positionConsumer.consumedEntities.size, 1);
assert.equal(positionConsumer.updatedEntities.size, 1);

manager.tick();

assert.equal(positionConsumer.consumedEntities.size, 0);
assert.equal(positionConsumer.updatedEntities.size, 0);

entity.components.position = vec2.create(); //?

manager.subTick(); //?
assert.equal(positionConsumer.updatedEntities.size, 1);

entity.components.updatedAt; //=
manager.getEntities('position'); //=

manager.state.updatedEntities; //=

manager.tick();
manager.state.updatedEntities; //=
manager.state.previouslyUpdatedEntities; //=
