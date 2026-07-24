import assert from 'assert';
import { defaultComponentTypes, Manager } from '../ecs/manager';
import { Pipeline } from '../ecs/system';
import {
    serializeAsyncSystem,
    deserializeAsyncSystem,
} from '../ecs/asyncSystem';

interface ComponentTypes extends defaultComponentTypes {
    ready: true;
    done: true;
    spawned: true;
    counter: number;
}

const em = new Manager<ComponentTypes>();

const readyQuery = em.createQuery({ includes: ['ready'] });

const entityA = em.createEntity('entityA');
em.registerEntity(entityA);

// --- Test S1: Serialize delay in-flight, deserialize, resume ---

let delayResolved = false;

const delayGen = function* (em: Manager<ComponentTypes>) {
    yield em.delay(100);
    delayResolved = true;
};

const sys1 = em.createAsyncSystem(delayGen, { id: 'delaySys' });

const pipeline = new Pipeline(em, sys1);

pipeline.tick(50);
em.tick();

const saved1 = serializeAsyncSystem(sys1);
assert.strictEqual(saved1.currentCondition?._spx, 'delay');
assert.strictEqual(saved1.currentCondition.ms, 100);
assert.ok(saved1.currentCondition._deadlineSet, 'deadline should be set');

const sys1Restored = deserializeAsyncSystem(em, saved1, delayGen);

const pipeline2 = new Pipeline(em, sys1Restored);
pipeline2.tick(60);
em.tick();

assert.ok(delayResolved, 'delay should have resolved after restore + 60ms more');
console.log('Test S1 PASS: delay serialized + deserialized + resolved');

// --- Test S2: delay resolves immediately if deadline already passed ---

let delay2Resolved = false;

const delayGen2 = function* (em: Manager<ComponentTypes>) {
    yield em.delay(50);
    delay2Resolved = true;
};

const sys2 = em.createAsyncSystem(delayGen2);
const pipe3 = new Pipeline(em, sys2);
pipe3.tick(30);
em.tick();

const saved2 = serializeAsyncSystem(sys2);
const sys2Restored = deserializeAsyncSystem(em, saved2, delayGen2);

const pipe4 = new Pipeline(em, sys2Restored);
pipe4.tick(30);
em.tick();

assert.ok(delay2Resolved, 'delay should resolve when extra delta passes deadline');
console.log('Test S2 PASS: delay resolved after deadline passed');

// --- Test S3: Entity wait serialization ---

let entityWaitResolved: any = null;

const entityWaitGen = function* (em: Manager<ComponentTypes>) {
    const e = yield em.waitForEntity('entityA', 'ready', 'added');
    entityWaitResolved = e;
};

const sys3 = em.createAsyncSystem(entityWaitGen);
const pipe5 = new Pipeline(em, sys3);

pipe5.tick(10);
em.tick();

const saved3 = serializeAsyncSystem(sys3);
assert.strictEqual(saved3.currentCondition?._spx, 'entityWait');
assert.strictEqual(saved3.currentCondition.entityId, 'entityA');
assert.strictEqual(saved3.currentCondition.component, 'ready');
assert.strictEqual(saved3.currentCondition.mode, 'added');

const sys3Restored = deserializeAsyncSystem(em, saved3, entityWaitGen);
const pipe6 = new Pipeline(em, sys3Restored);

pipe6.tick(10);
em.tick();
assert.strictEqual(entityWaitResolved, null, 'entity not ready yet');

entityA.components.ready = true as true;

pipe6.tick(10);
em.tick();
assert.ok(entityWaitResolved, 'entity wait should resolve after component added');
assert.strictEqual(entityWaitResolved.id, 'entityA');
console.log('Test S3 PASS: entity wait serialized + deserialized + resolved');

// --- Test S4: Query wait serialization ---

let queryWaitResolved: any = null;

const queryWaitGen = function* (em: Manager<ComponentTypes>) {
    const e = yield em.waitForQuery(readyQuery, (e: any) => true);
    queryWaitResolved = e;
};

const sys4 = em.createAsyncSystem(queryWaitGen);
const pipe7 = new Pipeline(em, sys4);

pipe7.tick(10);
em.tick();

const saved4 = serializeAsyncSystem(sys4);
assert.strictEqual(saved4.currentCondition?._spx, 'queryWait');
assert.strictEqual(saved4.currentCondition.queryName, readyQuery.queryName);

const sys4Restored = deserializeAsyncSystem(em, saved4, queryWaitGen);
const pipe8 = new Pipeline(em, sys4Restored);

pipe8.tick(10);
em.tick();
assert.strictEqual(queryWaitResolved, null, 'entity already matched but consumer was rebuilt so waits for next delta');

delete entityA.components.ready;
pipe8.tick(10);
em.tick();

entityA.components.ready = true as true;
pipe8.tick(10);
em.tick();
assert.ok(queryWaitResolved, 'query wait should resolve on restored consumer');
console.log('Test S4 PASS: query wait serialized + deserialized + resolved');

// --- Test S5: return false stops, serialized system with null condition ---

let runs = 0;

const stopGen = function* (em: Manager<ComponentTypes>) {
    runs++;
    return false;
};

const sys5 = em.createAsyncSystem(stopGen, { id: 'stopSys' });
const pipe9 = new Pipeline(em, sys5);

pipe9.tick(10);
em.tick();
assert.strictEqual(runs, 1);

pipe9.tick(10);
em.tick();
assert.strictEqual(runs, 1, 'should not run again after return false');

const saved5 = serializeAsyncSystem(sys5);
assert.strictEqual(saved5.currentCondition, null);

const sys5Restored = deserializeAsyncSystem(em, saved5, stopGen);
assert.strictEqual(sys5Restored._currentCondition, null);
assert.strictEqual(sys5Restored._generator, null);

console.log('Test S5 PASS: return false = stop, serialized as null condition');

// --- Test S6: Manager-level deserialize with registry ---

let registryResolved = false;

const registryGen = function* (em: Manager<ComponentTypes>) {
    yield em.delay(100);
    registryResolved = true;
};

em.registerAsyncGen('registeredSys', registryGen);

const sys6 = em.createAsyncSystem(registryGen, { id: 'registeredSys' });
const pipe10 = new Pipeline(em, sys6);

pipe10.tick(30);
em.tick();

const saved6 = serializeAsyncSystem(sys6);

const sys6Restored = em.deserializeAsyncSystem(saved6);
const pipe11 = new Pipeline(em, sys6Restored);

pipe11.tick(80);
em.tick();

assert.ok(registryResolved, 'should resolve via registry lookup by saved.id');
console.log('Test S6 PASS: Manager.deserializeAsyncSystem with registry');

// --- Test S7: Delta preserved across serialize/deserialize ---

const deltaGen = function* (em: Manager<ComponentTypes>) {
    yield em.delay(50);
    entityA.components.counter = (entityA.components.counter || 0) + 1;
};

const sys7 = em.createAsyncSystem(deltaGen, { id: 'deltaSys' });
const pipe12 = new Pipeline(em, sys7);

pipe12.tick(25);
em.tick();

const saved7 = serializeAsyncSystem(sys7);
assert.strictEqual(saved7.delta, 25);

const sys7Restored = deserializeAsyncSystem(em, saved7, deltaGen);
assert.strictEqual(sys7Restored._delta, 25);

pipe12.tick(30);
em.tick();

assert.strictEqual(entityA.components.counter, 1);
console.log('Test S7 PASS: delta preserved through serialization');

// --- Test S8: Promise condition serialization ---

let promiseResolved = false;

const promiseGen = function* (em: Manager<ComponentTypes>) {
    try {
        const val = yield Promise.resolve('hello');
        promiseResolved = val === 'hello';
    } catch (_) {}
};

const sys8 = em.createAsyncSystem(promiseGen);
const pipe13 = new Pipeline(em, sys8);

pipe13.tick(10);
em.tick();

const saved8 = serializeAsyncSystem(sys8);
assert.strictEqual(saved8.currentCondition?._spx, 'promise');
assert.ok(saved8.currentCondition.resolved, 'promise should be resolved');
assert.strictEqual(saved8.currentCondition.value, 'hello');

const sys8Restored = deserializeAsyncSystem(em, saved8, promiseGen);
const pipe14 = new Pipeline(em, sys8Restored);

pipe14.tick(10);
em.tick();

assert.ok(promiseResolved, 'restored promise should deliver value on first tick');
console.log('Test S8 PASS: Promise condition serialized + deserialized');

console.log('\nAll async-system serialization tests passed.');
