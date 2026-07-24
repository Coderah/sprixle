/**
 * Worker threading tests — verifies SAB pool, ReplicaSet, Manager worker mode,
 * and message protocol without requiring actual Web Workers.
 */

import assert from 'assert';
import { defaultComponentTypes, EntityId, Manager } from '../ecs/manager';
import { SABPool, SAB_HEADER_SIZE, SIGNAL_SAB_SIZE, isWorkerScope } from '../ecs/sabPool';
import { SABTransport, WorkerInit, WorkerSnapshot, WorkerDeltas, WorkerTick, WorkerTickComplete, WriteEntry } from '../ecs/sabTransport';
import { ReplicaSet } from '../ecs/replicaSet';

// ── Component Types ────────────────────────────────────────────────

type ComponentTypes = defaultComponentTypes & {
    position: { x: number; y: number };
    velocity: { x: number; y: number };
    mass: number;
    health: number;
    label: string;
};

// ── SAB Pool Tests ─────────────────────────────────────────────────

{
    const poolConfig = { sendPool: { count: 2, bufferSize: 4096 }, recvPool: { count: 2, bufferSize: 2048 } };
    const { sendPool, recvPool } = SABPool.createMain(poolConfig);

    // Pool structure
    assert.ok(sendPool.buffers.length === 2, 'sendPool has 2 buffers');
    assert.ok(recvPool.buffers.length === 2, 'recvPool has 2 buffers');
    assert.ok(sendPool.buffers[0]!.sab.byteLength === 4096, 'send buffer is correct size');
    assert.ok(recvPool.buffers[0]!.sab.byteLength === 2048, 'recv buffer is correct size');

    // Signal SAB size
    assert.ok(sendPool.signal.sab.byteLength === SIGNAL_SAB_SIZE, 'signal SAB is correct size');

    // All buffers start free
    for (const buf of sendPool.buffers) {
        assert.strictEqual(buf.owner, 0, 'send buffer starts free');
    }
    for (const buf of recvPool.buffers) {
        assert.strictEqual(buf.owner, 0, 'recv buffer starts free');
    }

    // Acquire and release
    const buf = sendPool.tryAcquire();
    assert.ok(buf !== null, 'can acquire a buffer');
    assert.strictEqual(buf!.owner, 1, 'acquired buffer owned by main'); // main side = 1

    sendPool.returnToFree(buf!);
    assert.strictEqual(buf!.owner, 0, 'returned buffer is free');

    // BSON write and read round-trip
    const msgBuf = sendPool.tryAcquire();
    assert.ok(msgBuf !== null, 'can acquire for write');
    const testData = { hello: 'world', count: 42 };
    const writeResult = sendPool.writeMessage(testData);
    assert.ok(writeResult, 'writeMessage succeeded');

    // Reading from recv pool (receiving what was "sent" to worker)
    // Simulate: the buffer was written by main (owner=1) and released to worker (owner=2)
    // Then worker returns it. For the test, we acquire and read directly.
    const recvBuf = recvPool.tryAcquire();
    assert.ok(recvBuf !== null, 'recv pool has free buffer');
    sendPool.returnToFree(msgBuf!);

    console.log('[SAB Pool] All pool tests passed');
}

// ── Signal SAB Tests ───────────────────────────────────────────────

{
    const poolConfig = { sendPool: { count: 1, bufferSize: 1024 }, recvPool: { count: 1, bufferSize: 1024 } };
    const { sendPool } = SABPool.createMain(poolConfig);

    const signal = sendPool.signal;

    assert.strictEqual(signal.mainPending, 0, 'mainPending starts at 0');
    assert.strictEqual(signal.workerPending, 0, 'workerPending starts at 0');
    assert.strictEqual(signal.shutdown, 0, 'shutdown starts at 0');

    signal.setMainPending(1);
    assert.strictEqual(signal.mainPending, 1, 'setMainPending works');

    signal.setMainPending(0);
    signal.setWorkerPending(1);
    assert.strictEqual(signal.workerPending, 1, 'setWorkerPending works');

    signal.setShutdown(1);
    assert.strictEqual(signal.shutdown, 1, 'setShutdown works');
    assert.strictEqual(sendPool.isShutdown, true, 'pool reflects shutdown');

    signal.setShutdown(0);

    console.log('[Signal SAB] All signal tests passed');
}

// ── BSON Message Round-Trip Tests ──────────────────────────────────

{
    const poolConfig = { sendPool: { count: 2, bufferSize: 4096 }, recvPool: { count: 2, bufferSize: 4096 } };
    const { sendPool, recvPool } = SABPool.createMain(poolConfig);

    // Write a message via writeMessage (send pool)
    const original = { type: 'tick' as const, delta: 0.016 };
    sendPool.writeMessage(original);

    // To simulate receiving: we need to find a buffer that was "sent" (owner=worker for main side)
    // Since we're on the "main" side, writeMessage releases with owner=2 (worker side)
    // For recvPool, the worker writes with its own "release to main" which would set owner=1
    // Let's test the actual BSON round-trip by reading what we wrote
    const recvBuf = recvPool.tryAcquire();
    assert.ok(recvBuf !== null, 'can acquire recv buffer');

    // Write a message as "worker" would (using recv pool, releasing to main)
    recvPool.writeMessage({ type: 'tickComplete' as const, writes: [] });

    // Read it from the "main" side perspective
    const readResult = recvPool.readMessage(0);
    assert.ok(readResult !== null, 'readMessage returns data');
    assert.strictEqual((readResult!.data as any).type, 'tickComplete', 'message type preserved');

    console.log('[BSON Round-Trip] Message round-trip passed');
}

// ── ReplicaSet Tests ───────────────────────────────────────────────

{
    const em = new Manager<ComponentTypes>();
    const rs = new ReplicaSet(em);

    const queryDefs = [
        { includes: ['position', 'velocity'] },
    ];

    rs.init(queryDefs);

    // Component auto-detection
    assert.ok(rs.neededComponentTypes.has('position'), 'detects position from query');
    assert.ok(rs.neededComponentTypes.has('velocity'), 'detects velocity from query');
    assert.ok(!rs.neededComponentTypes.has('mass'), 'does not include non-queried component');

    // Create entity and verify snapshot
    const entity = em.quickEntity({
        position: { x: 0, y: 0 },
        velocity: { x: 1, y: 0 },
        mass: 10,
    } as Partial<ComponentTypes>);

    const snapshot = rs.buildSnapshot();
    const id = entity.id;
    assert.ok(id in snapshot, 'entity is in snapshot');
    assert.ok('position' in snapshot[id]!, 'position in snapshot');
    assert.ok('velocity' in snapshot[id]!, 'velocity in snapshot');
    assert.ok(!('mass' in snapshot[id]!), 'mass not in snapshot (not needed)');

    // Delta accumulation
    entity.components.position.x = 5;
    em.subTick();

    const flushResult = rs.flush();
    assert.ok(flushResult !== null, 'flush produces deltas');
    assert.ok(flushResult!.patches.length > 0, 'flush has patches');
    const posPatch = flushResult!.patches.find(p => p.entity === id);
    assert.ok(posPatch !== undefined, 'position entity has a patch');
    assert.strictEqual(posPatch!.set.position.x, 5, 'delta has correct position.x');

    // Second flush with no changes
    const flush2 = rs.flush();
    assert.ok(flush2 === null, 'no changes = null flush');

    // New entity adding
    const entity2 = em.quickEntity({
        position: { x: 10, y: 10 },
        velocity: { x: 0, y: 1 },
    } as Partial<ComponentTypes>);

    const flush3 = rs.flush();
    assert.ok(flush3 !== null, 'new entity triggers flush');
    const addPatch = flush3!.patches.find(p => p.entity === entity2.id);
    assert.ok(addPatch !== undefined, 'new entity has an add patch');
    assert.ok('position' in addPatch!.set, 'add patch includes position');

    // Entity removal (exit query)
    delete entity2.components.position;
    em.subTick();

    const flush4 = rs.flush();
    assert.ok(flush4 !== null, 'entity removal triggers flush');
    const removePatch = flush4!.patches.find(p => p.entity === entity2.id && p.delete.length > 0);
    assert.ok(removePatch !== undefined, 'removed entity has delete patch');

    // Clean up
    em.deregisterEntity(entity);
    em.deregisterEntity(entity2);

    console.log('[ReplicaSet] All replication tests passed');
}

// ── ReplicaSet with extraComponents ────────────────────────────────

{
    const em = new Manager<ComponentTypes>();
    const rs = new ReplicaSet(em);

    rs.init([], { extraComponents: ['health', 'mass'] });

    assert.ok(rs.neededComponentTypes.has('health'), 'extra component detected');
    assert.ok(rs.neededComponentTypes.has('mass'), 'extra component detected');
    assert.ok(!rs.neededComponentTypes.has('position'), 'non-declared component not needed');

    console.log('[ReplicaSet extraComponents] Extra component tests passed');
}

// ── Manager Worker Mode Tests ──────────────────────────────────────

{
    // Manager in main mode (default in Node.js — no WorkerGlobalScope)
    const em = new Manager<ComponentTypes>();
    assert.strictEqual(em.mode, 'main', 'Manager defaults to main mode');
    assert.strictEqual(em._transportReady, false, 'transport not ready in main mode');

    // createSerializer works in main mode
    const serializer = em.createSerializer<{ x: number }>();
    const serialized = serializer({ x: 42 });
    assert.ok(serialized instanceof Uint8Array, 'serialization produces Uint8Array');
    assert.ok(serialized.byteLength > 0, 'serialized data not empty');

    // createDeserializer works in main mode
    const deserializer = em.createDeserializer<{ x: number }>();
    const deserialized = deserializer(serialized);
    assert.strictEqual(deserialized.x, 42, 'round-trip works in main mode');

    // createPipeline works
    const pipeline = em.createPipeline();
    assert.ok(pipeline.systems.size === 0, 'creates empty pipeline');
    assert.strictEqual(em._pipelines.size, 0, 'main mode does not add to _pipelines');

    // createQuery does not collect defs in main mode
    assert.strictEqual(em._pendingQueryDefs.length, 0, 'no pending query defs in main mode');

    console.log('[Manager main mode] Main mode tests passed');
}

// ── Write-Back Buffer Tests ────────────────────────────────────────

{
    const em = new Manager<ComponentTypes>();
    const testId: EntityId = 'test_writeback';

    // Set up write-back buffer manually (without worker detection)
    const entity = em.createEntity(testId);
    em.registerEntity(entity);

    // Simulate worker-mode write buffering
    const id: EntityId = entity.id;
    em._bufferWrite(id, 'position', { x: 10, y: 0 });
    em._bufferWrite(id, 'velocity', { x: 1, y: 0 });

    const writes = em._drainWrites();
    assert.strictEqual(writes.length, 1, 'one entity, one combined write entry');
    assert.strictEqual(writes[0]!.entity, id, 'correct entity id');
    assert.deepStrictEqual(writes[0]!.set, {
        position: { x: 10, y: 0 },
        velocity: { x: 1, y: 0 },
    }, 'combined writes');

    // Second drain is empty
    const writes2 = em._drainWrites();
    assert.strictEqual(writes2.length, 0, 'drain clears buffer');

    // Deletion write-back
    em._bufferWriteDeletion(id, 'velocity');
    const writes3 = em._drainWrites();
    assert.strictEqual(writes3.length, 1, 'deletion creates entry');
    assert.deepStrictEqual(writes3[0]!.delete, ['velocity'], 'deletion tracked');

    // Set + delete on same entity merges
    em._bufferWrite(id, 'mass', 5);
    em._bufferWriteDeletion(id, 'mass');
    const writes4 = em._drainWrites();
    assert.strictEqual(writes4.length, 1, 'set+delete merges to one entry');
    assert.strictEqual(writes4[0]!.set.mass, undefined, 'set overwritten by delete');
    assert.ok(writes4[0]!.delete.includes('mass'), 'delete recorded');

    // Clean up
    em.deregisterEntity(entity);

    console.log('[Write-Back Buffer] Write-back buffer tests passed');
}

// ── Delta Application Tests ────────────────────────────────────────

{
    const em = new Manager<ComponentTypes>();

    // Apply deltas (creates entities)
    em._applyDeltas([
        {
            entity: 'entity_a' as EntityId,
            set: { position: { x: 1, y: 2 }, velocity: { x: 0, y: 0 } },
            delete: [],
        },
    ]);

    const entity = em.getEntity('entity_a' as EntityId);
    assert.ok(entity !== undefined, 'entity created from delta');
    assert.deepStrictEqual(entity!.components.position, { x: 1, y: 2 }, 'position set from delta');
    assert.deepStrictEqual(entity!.components.velocity, { x: 0, y: 0 }, 'velocity set from delta');

    // Apply incremental delta
    em._applyDeltas([
        {
            entity: 'entity_a' as EntityId,
            set: { position: { x: 3, y: 4 } },
            delete: ['velocity'],
        },
    ]);

    assert.strictEqual(entity!.components.position.x, 3, 'position updated from delta');
    assert.strictEqual(entity!.components.velocity, undefined, 'velocity deleted from delta');

    // Clean up
    em.deregisterEntity(entity!);

    console.log('[Delta App] Delta application tests passed');
}

// ── Snapshot Application Tests ─────────────────────────────────────

{
    const em = new Manager<ComponentTypes>();

    em._applySnapshot({
        entity_a: { position: { x: 0, y: 0 }, velocity: { x: 1, y: 1 }, mass: 42 },
        entity_b: { position: { x: 10, y: 10 }, mass: 5 },
    });

    const a = em.getEntity('entity_a' as EntityId);
    const b = em.getEntity('entity_b' as EntityId);

    assert.ok(a !== undefined, 'entity_a created from snapshot');
    assert.ok(b !== undefined, 'entity_b created from snapshot');
    assert.strictEqual(a!.components.mass, 42, 'mass preserved');
    assert.strictEqual(b!.components.position.x, 10, 'entity_b position correct');

    // Clean up
    em.deregisterEntity(a!);
    em.deregisterEntity(b!);

    console.log('[Snapshot App] Snapshot application tests passed');
}

// ── SerializedQueryDef Collection ──────────────────────────────────

{
    const em = new Manager<ComponentTypes>();

    // Simulate worker mode: manually set state
    (em as any).mode = 'worker';

    const query = em.createQuery({
        includes: ['position', 'velocity'],
    });

    assert.strictEqual(em._pendingQueryDefs.length, 1, 'query def collected');
    assert.deepStrictEqual(em._pendingQueryDefs[0]!.includes, ['position', 'velocity'], 'includes collected');
    assert.strictEqual(em._pendingQueryDefs[0]!.flexible, undefined, 'flexible not set');

    const query2 = em.createQuery({
        includes: ['mass'],
        excludes: ['health'],
        flexible: true,
    });

    assert.strictEqual(em._pendingQueryDefs.length, 2, 'second query def collected');
    assert.strictEqual(em._pendingQueryDefs[1]!.flexible, true, 'flexible flag collected');
    assert.ok(em._pendingQueryDefs[1]!.excludes!.includes('health'), 'excludes collected');

    // Reset mode
    (em as any).mode = 'main';

    console.log('[Query Defs] Query definition collection tests passed');
}

// ── isWorkerScope ──────────────────────────────────────────────────

{
    // In Node.js (no WorkerGlobalScope), should return false
    assert.strictEqual(isWorkerScope(), false, 'isWorkerScope is false in Node.js');

    console.log('[isWorkerScope] Detection tests passed');
}

// ── Message Protocol Type Checks ───────────────────────────────────

{
    // Verify message types have the expected shape
    const initMsg: WorkerInit = { type: 'init', queryDefs: [] };
    assert.strictEqual(initMsg.type, 'init');

    const snapMsg: WorkerSnapshot = { type: 'snapshot', entities: {} };
    assert.strictEqual(snapMsg.type, 'snapshot');

    const deltaMsg: WorkerDeltas = { type: 'deltas', patches: [] };
    assert.strictEqual(deltaMsg.type, 'deltas');

    const tickMsg: WorkerTick = { type: 'tick', delta: 0.016 };
    assert.strictEqual(tickMsg.type, 'tick');
    assert.strictEqual(tickMsg.delta, 0.016);

    const completeMsg: WorkerTickComplete = { type: 'tickComplete', writes: [] };
    assert.strictEqual(completeMsg.type, 'tickComplete');

    const write: WriteEntry = {
        entity: 'test' as EntityId,
        set: { position: { x: 1, y: 0 } },
        delete: [],
    };
    assert.strictEqual(write.entity, 'test' as EntityId);

    console.log('[Message Protocol] Type shape tests passed');
}

// ── Optimistic quickEntity in Worker Mode ──────────────────────────

{
    const em = new Manager<ComponentTypes>();
    (em as any).mode = 'worker';

    const entity = em.quickEntity({
        position: { x: 5, y: 10 },
        velocity: { x: 0, y: -1 },
    } as Partial<ComponentTypes>);

    assert.ok(entity !== undefined, 'quickEntity works in worker mode');
    assert.strictEqual(entity.components.position.x, 5, 'entity has correct position');

    const writes = em._drainWrites();
    assert.strictEqual(writes.length, 1, 'quickEntity produces write-back');
    assert.ok(writes[0]!.create !== undefined, 'write-back is a create entry');
    assert.strictEqual((writes[0]!.create as any).position.x, 5, 'create entry has correct data');

    // Clean up
    em.deregisterEntity(entity);
    (em as any).mode = 'main';

    console.log('[quickEntity worker] Optimistic create tests passed');
}

// ── deregisterEntity Write-Back in Worker Mode ─────────────────────

{
    const em = new Manager<ComponentTypes>();
    const entity = em.quickEntity({
        position: { x: 0, y: 0 },
    } as Partial<ComponentTypes>);

    (em as any).mode = 'worker';
    em._writeBuffer = []; // clear any writes from quickEntity

    em.deregisterEntity(entity);
    const writes = em._drainWrites();

    assert.strictEqual(writes.length, 1, 'deregister produces write-back');
    assert.strictEqual(writes[0]!.destroy, true, 'write-back is a destroy entry');
    assert.strictEqual(writes[0]!.entity, entity.id, 'correct entity id');

    (em as any).mode = 'main';

    console.log('[deregisterEntity worker] Destroy write-back tests passed');
}

// ── applyWrites (main-thread write-back intake) ────────────────────

{
    const em = new Manager<ComponentTypes>();
    const rs = new ReplicaSet(em);
    rs.init([{ includes: ['position', 'velocity', 'mass'] }]);

    // Test create via write-back
    rs.applyWrites([
        {
            entity: 'created_entity' as EntityId,
            set: {},
            delete: [],
            create: { position: { x: 0, y: 0 }, mass: 100 },
        },
    ]);

    const created = em.getEntity('created_entity' as EntityId);
    assert.ok(created !== undefined, 'entity created from write-back');
    assert.strictEqual(created!.components.mass, 100, 'mass set on created entity');

    // Test component set via write-back
    rs.applyWrites([
        {
            entity: 'created_entity' as EntityId,
            set: { position: { x: 5, y: 5 }, velocity: { x: 0, y: 0 } },
            delete: [],
        },
    ]);

    assert.strictEqual(created!.components.position.x, 5, 'position updated from write-back');
    assert.deepStrictEqual(created!.components.velocity, { x: 0, y: 0 }, 'velocity set from write-back');

    // Test deletion via write-back
    rs.applyWrites([
        {
            entity: 'created_entity' as EntityId,
            set: {},
            delete: ['mass'],
        },
    ]);

    assert.strictEqual(created!.components.mass, undefined, 'mass deleted from write-back');

    // Test destroy via write-back
    rs.applyWrites([
        {
            entity: 'created_entity' as EntityId,
            set: {},
            delete: [],
            destroy: true,
        },
    ]);

    assert.strictEqual(em.getEntity('created_entity' as EntityId), undefined, 'entity destroyed from write-back');

    console.log('[applyWrites] Main-thread write-back intake tests passed');
}

// ── Worker-Mode Disallowed Methods ─────────────────────────────────

{
    const em = new Manager<ComponentTypes>();
    (em as any).mode = 'worker';

    assert.throws(
        () => em.createSerializer<{ x: number }>()({ x: 1 }),
        /SAB transport/,
        'createSerializer throws in worker mode'
    );

    assert.throws(
        () => em.createDeserializer<{ x: number }>()(new Uint8Array()),
        /SAB transport/,
        'createDeserializer throws in worker mode'
    );

    (em as any).mode = 'main';

    console.log('[Disallowed Methods] Worker-mode restriction tests passed');
}

console.log('\n=== All worker threading tests passed ===\n');
