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
    index: 'ownerId',
});

const stats = {
    newEntities: 0,
    updatedEntities: 0,
    allEntities: 0,
};

for (let i = 0; i < 10; i++) {
    manager.quickEntity({
        position: new Vector2(),
        ownerId: i < 5 ? 'player-2' : 'player-1',
    });
}

manager.subTick();
manager.tick();

console.log('query', positionQuery);
console.log('player-1', positionQuery.get('player-1'));
console.log('player-2', positionQuery.get('player-2'));

assert.equal(positionQuery.get('player-1').size, 5);
assert.equal(positionQuery.get('player-2').size, 5);

manager.deregisterEntity(positionQuery.get('player-1').first());

manager.subTick();
manager.tick();

assert.equal(positionQuery.get('player-1').size, 4);
assert.equal(positionQuery.get('player-2').size, 5);

console.log('player-1', positionQuery.get('player-1'));
console.log('player-2', positionQuery.get('player-2'));

positionQuery.get('player-2').first().components.ownerId = 'player-1';

manager.subTick();
manager.tick();

assert.equal(positionQuery.get('player-1').size, 5);
assert.equal(positionQuery.get('player-2').size, 4);

console.log('player-1', positionQuery.get('player-1'));
console.log('player-2', positionQuery.get('player-2'));
