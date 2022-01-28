import { vec2 } from 'gl-matrix';
import { Immutable } from './imm';
import { TOWERS } from './const';
import { registerEntity, INITIAL_ENTITY_ADMIN_STATE, getEntities } from './entity-admin';
import { createEntity, Entity, EntityID } from './entity';
import { ComponentTypes, addComponent } from './components';
import KDTreeSystem from './systems/kd-tree-system';

let entity = createEntity(); //?
entity.get('id')//?
entity = addComponent(entity, 'ownerID')
entity = addComponent(entity, 'health')
entity = addComponent(entity, 'position', vec2.fromValues(5, 5))
entity = addComponent(entity, 'towerAttributes', TOWERS[0])

let state = registerEntity(INITIAL_ENTITY_ADMIN_STATE, entity); //?

entity = createEntity();
entity.get('id')//?
entity = addComponent(entity, 'ownerID')
entity = addComponent(entity, 'health')
entity = addComponent(entity, 'position')

state = registerEntity(state, entity); //?


state = KDTreeSystem.update(state);

const treeEntity = getEntities(state, 'kdTree').first() as Immutable<Entity>;

KDTreeSystem.withinRadius(state, entity, 9).first(createEntity()) //?
// treeEntity.getIn(['components', 'kdTree']).within(0, 0, 10); //?

/* TODO

create a singleton entity (with id = singleton) to hold singleton components,
we are single threaded so its fine to share all in one entity.

make singleton Entity getter

make list of singleton components and enforce? (the above may achieve this)

make action buffer reducer (custom size, infinite for server)

create serialization tests, serialize and deserialize Immutable's,
we'll only ever serialize/deserialize an action buffer

*/