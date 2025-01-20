import { Vector2 } from 'three';
import { defaultComponentTypes, Manager } from '../ecs/manager';
require('process');
import assert from 'assert';
import { Pipeline } from '../ecs/system';

type ComponentTypes = defaultComponentTypes & {
    position: Vector2;
};

const manager = new Manager<ComponentTypes>();

const positionQuery = manager.createQuery({
    includes: ['position'],
    timeSlicing: {
        percentage: 50,
    },
});

const stats = {
    newEntities: 0,
    updatedEntities: 0,
};
const slicedSystem = manager.createSystem(positionQuery.createConsumer(), {
    forNew(entity, delta) {
        console.log('new');
        stats.newEntities++;
    },
    updated(entity) {
        console.log('updated', entity.id);
        stats.updatedEntities++;
    },
});

for (let i = 0; i < 10; i++) {
    manager.quickEntity({
        position: new Vector2(),
    });
}

const pipeline = new Pipeline(manager, slicedSystem);

pipeline.tick(1);
assert.equal(stats.newEntities, 10);
assert.equal(stats.updatedEntities, 0);

manager.tick();

for (let entity of positionQuery) {
    entity.flagUpdate('position');
}
manager.subTick(); // as if we are updating entities within a system

pipeline.tick(1);
console.log(stats, slicedSystem.source);
assert.equal(stats.updatedEntities, 5);

manager.tick();
pipeline.tick(1);
assert.equal(stats.updatedEntities, 10);
