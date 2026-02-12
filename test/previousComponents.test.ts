import { Vector2, Vector3 } from 'three';
import { defaultComponentTypes, Manager } from '../ecs/manager';
import assert from 'assert';
import { TrackPrevious } from '../ecs/types';

type ComponentTypes = defaultComponentTypes & {
    vec2: Vector2 & TrackPrevious;
    vec3: Vector3 & TrackPrevious;
    testBool: boolean & TrackPrevious;
};

const manager = new Manager<ComponentTypes>();

const entity = manager.quickEntity({
    vec2: new Vector2(5, 5),
    vec3: new Vector3(5, 5, 5),
    testBool: false,
});

manager.tick();

entity.willUpdate('vec2');
entity.components.vec2.set(3, 2);

manager.tick();

entity.components.testBool = true;

assert(entity.previousComponents.testBool === false);

entity.components.testBool = false;

// @ts-ignore typescript is being dumb and wrong here
assert(entity.previousComponents.testBool === true);

assert(entity.components.vec2 !== entity.previousComponents.vec2);
assert(entity.components.vec2.x === 3);
assert(entity.previousComponents.vec2.x === 5);
