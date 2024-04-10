import assert from 'assert';
import { vec2 } from 'gl-matrix';
import { DEFAULT_COMPONENT_DEFAULTS, Manager } from '../ecs/manager';
import { Pipeline } from '../ecs/system';

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

const positionSystem = manager.createSystem(positionConsumer, {
    new(entity) {
        console.log('new', entity);
    },
    updated(entity) {
        console.log('updated', entity);
    },
    removed(entity) {
        console.log('removed', entity);
    },
});

const masterPipeline = new Pipeline(manager, positionSystem);

masterPipeline.tick();
manager.tick();

manager.deregisterEntity(entity);

masterPipeline.tick();
