import { Vector2, Vector3 } from 'three';
import { defaultComponentTypes, Manager } from '../ecs/manager';
import assert from 'assert';

type ComponentTypes = defaultComponentTypes & {
    vec2: Vector2;
    vec3: Vector3;
};

const manager = new Manager<ComponentTypes>();

const entity = manager.quickEntity({
    vec2: new Vector2(5, 5),
    vec3: new Vector3(5, 5, 5),
});

manager.tick();

entity.flagUpdate('vec2');
entity.components.vec2.set(3, 2);

manager.tick();

assert(entity.components.vec2 !== entity.previousComponents.vec2);
assert(entity.components.vec2.x === 3);
assert(entity.previousComponents.vec2.x === 5);
