import assert from 'assert';
import { defaultComponentTypes, Manager } from '../ecs/manager';
import { now } from '../util/now';
import { Pipeline } from '../ecs/system';

type ComponentTypes = defaultComponentTypes & {
    testAt: number;
};

const em = new Manager<ComponentTypes>();

assert.equal(
    em.state.now,
    0,
    'Manager initialState.now is incorrectly initialized'
);

const testPipeline = new Pipeline(
    em,
    em.createSystem({
        tick(delta) {
            assert.equal(
                delta,
                5,
                'system delta does not match internal pipeline time.'
            );
            assert.equal(
                now(),
                5,
                'now() inside system does not match internal pipeline time.'
            );
        },
    })
);

testPipeline.useInternalTime = true;

em.start(2);

assert.equal(now(), 2, 'Within first tick now() does not properly resolve.');

testPipeline.tick(5);

assert.equal(now(), 2, 'now() after Pipeline fails to retarget manager');

em.end();
