import assert from 'assert';
import { defaultComponentTypes, Manager } from '../ecs/manager';
import { Pipeline } from '../ecs/system';

interface ComponentTypes extends defaultComponentTypes {
    ready: true;
    done: true;
    spawned: true;
    counter: number;
}

const em = new Manager<ComponentTypes>();

// --- Test 1: delay resolves after sufficient ticks ---

let delayResolved = false;

const delaySys = em.createAsyncSystem(function* (em) {
    yield em.delay(100);
    delayResolved = true;
});

const pipe1 = new Pipeline(em, delaySys);

pipe1.tick(50);
em.tick();
assert.strictEqual(delayResolved, false, 'should not resolve at 50ms');

pipe1.tick(60);
em.tick();
assert.ok(delayResolved, 'should resolve after 110ms total');
console.log('Test 1 PASS: delay resolves after deadline');

// --- Test 2: entity wait resolves when component added ---

let entityWaitResult: any = null;

const entityA = em.createEntity('entityA');
em.registerEntity(entityA);

const entityWaitSys = em.createAsyncSystem(function* (em) {
    entityWaitResult = yield em.waitForEntity('entityA', 'ready', 'added');
});

const pipe2 = new Pipeline(em, entityWaitSys);

pipe2.tick(10);
em.tick();
assert.strictEqual(entityWaitResult, null, 'entity not ready yet');

entityA.components.ready = true as true;

pipe2.tick(10);
em.tick();
assert.ok(entityWaitResult, 'should resolve after component added');
assert.strictEqual(entityWaitResult.id, 'entityA');
console.log('Test 2 PASS: entity wait resolves on component add');

// --- Test 3: entity wait removed mode ---

let entityRemovedResolved = false;

delete entityA.components.ready;

const entityRemovedSys = em.createAsyncSystem(function* (em) {
    yield em.waitForEntity('entityA', 'ready', 'removed');
    entityRemovedResolved = true;
});

const pipe3 = new Pipeline(em, entityRemovedSys);

pipe3.tick(10);
em.tick();
assert.ok(entityRemovedResolved, 'should resolve immediately when component already removed');
console.log('Test 3 PASS: entity wait removed mode');

// --- Test 4: query wait resolves on new matching entity ---

let queryWaitResult: any = null;

const readyQuery = em.createQuery({ includes: ['ready'] });

const queryWaitSys = em.createAsyncSystem(function* (em) {
    queryWaitResult = yield em.waitForQuery(readyQuery);
});

const pipe4 = new Pipeline(em, queryWaitSys);

pipe4.tick(10);
em.tick();
assert.strictEqual(queryWaitResult, null, 'no ready entity yet');

const entityB = em.quickEntity({ ready: true as true }, 'entityB');

pipe4.tick(10);
em.tick();
assert.ok(queryWaitResult, 'should resolve when entity enters query');
assert.strictEqual(queryWaitResult.id, 'entityB');
console.log('Test 4 PASS: query wait resolves on new match');

// --- Test 5: return false stops the coroutine permanently ---

let runs = 0;

const stopSys = em.createAsyncSystem(function* (em) {
    runs++;
    return false;
});

const pipe5 = new Pipeline(em, stopSys);

pipe5.tick(10);
em.tick();
assert.strictEqual(runs, 1);

pipe5.tick(10);
em.tick();
assert.strictEqual(runs, 1, 'should not run again after return false');

pipe5.tick(10);
em.tick();
assert.strictEqual(runs, 1, 'still stopped after third tick');
console.log('Test 5 PASS: return false stops permanently');

// --- Test 6: generator restarts on normal return (non-false) ---

let restarts = 0;

const restartSys = em.createAsyncSystem(function* (em) {
    yield em.delay(10);
    restarts++;
});

const pipe6 = new Pipeline(em, restartSys);

pipe6.tick(20);
em.tick();
assert.strictEqual(restarts, 1, 'first run');

pipe6.tick(20);
em.tick();
assert.strictEqual(restarts, 2, 'should restart after normal return');
console.log('Test 6 PASS: generator restarts on normal return');

// --- Test 7: condition() gates the whole system ---

let gatedRuns = 0;
let gate = false;

const gatedSys = em.createAsyncSystem(function* (em) {
    gatedRuns++;
    yield em.delay(0);
}, { condition: () => gate });

const pipe7 = new Pipeline(em, gatedSys);

pipe7.tick(10);
em.tick();
assert.strictEqual(gatedRuns, 0, 'gate closed');

gate = true;

pipe7.tick(10);
em.tick();
assert.strictEqual(gatedRuns, 1, 'gate opened, runs once');
console.log('Test 7 PASS: condition gates the async system');

// --- Test 8: chaining multiple yields works ---

let chainResults: number[] = [];

const chainSys = em.createAsyncSystem(function* (em) {
    yield em.delay(5);
    chainResults.push(1);
    yield em.delay(5);
    chainResults.push(2);
    yield em.delay(5);
    chainResults.push(3);
});

const pipe8 = new Pipeline(em, chainSys);

pipe8.tick(10);
em.tick();
assert.deepStrictEqual(chainResults, [1], 'first yield resolved');

pipe8.tick(10);
em.tick();
assert.deepStrictEqual(chainResults, [1, 2], 'second yield resolved');

pipe8.tick(10);
em.tick();
assert.deepStrictEqual(chainResults, [1, 2, 3], 'third yield resolved');
console.log('Test 8 PASS: chaining multiple yields');

console.log('\nAll async-system core tests passed.');
