import { Vector2 } from 'three';
import {
    defaultComponentNames,
    defaultComponentTypes,
    Manager,
} from '../ecs/manager';
import assert from 'assert';

type ComponentTypes = defaultComponentTypes & {
    position: Vector2;
    inactive: true;
};

const manager = new Manager<ComponentTypes>();

const positionQuery = manager.createQuery({
    includes: ['position'],
    excludes: ['inactive'],
});

const inactivePositionQuery = manager.createQuery({
    includes: ['position', 'inactive'],
});

const inactiveEntity = manager.createEntity('inactiveEntity');
inactiveEntity.components.updatedAt; //=
inactiveEntity.components.position = new Vector2();
inactiveEntity.components.inactive = true;
manager.registerEntity(inactiveEntity);

const entity = manager.createEntity('entity');
entity.components.updatedAt; //=
entity.components.position = new Vector2();
manager.registerEntity(entity);

manager.subTick();
manager.tick();

assert.equal(inactivePositionQuery.size, 1);
assert.equal(positionQuery.size, 1);

entity.components.inactive = true;
manager.subTick();

assert.equal(positionQuery.size, 0);
assert.equal(inactivePositionQuery.size, 2);

manager.removeComponent(entity, 'inactive');

assert.equal(inactivePositionQuery.size, 1);
assert.equal(positionQuery.size, 1);
