import { Vector2 } from 'three';
import { defaultComponentTypes, Manager } from '../ecs/manager';
require('process');
import assert from 'assert';
import { Pipeline } from '../ecs/system';
import { SingletonComponent } from '../ecs/types';

type ComponentTypes = defaultComponentTypes & {
    matchState: string & SingletonComponent;
};

const manager = new Manager<ComponentTypes>();

globalThis.manager = manager;

manager.quickEntity({
    matchState: 'test',
});

let error: Error = null;
try {
    manager.quickEntity({
        matchState: 'test',
    });
} catch (e) {
    error = e;
    console.warn('showing intended error as warning', error);
}

assert.ok(error);
