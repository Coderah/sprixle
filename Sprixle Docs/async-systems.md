# Async Systems — generator-based coroutines in the ECS

*Engine ref: 9e76509 (2026-07-24); networking patterns added 2026-07-24*

Source: `ecs/asyncSystem.ts`, `ecs/system.ts:208-284`, `ecs/manager.ts:576-623`.

An async system is a `function*` generator that yields conditions, suspends across ticks, and resumes at pipeline boundaries when those conditions resolve. Sequential async logic (wait, then act, then wait) becomes linear code instead of state-machine sprawl.

## Quick start

```ts
const introSequence = em.createAsyncSystem(function* (em, delta) {
    yield em.delay(2000);
    em.quickEntity({ dialogBox: { text: 'Welcome.' }, isDialog: true as true });
    yield em.delay(3000);
    em.quickEntity({ dialogBox: { text: 'Get ready.' }, isDialog: true as true });
    yield em.waitForEntity(playerId, 'isReady');
    em.quickEntity({ matchStarted: true as true });
});

const simPipeline = new Pipeline(em, physicsSystem, introSequence, enemySystem);
```

The generator runs up to the first `yield`, pauses, and resumes when the condition resolves. The `delta` parameter is the current tick's delta at the time that generator segment executes (re-snapshot on each restart).

## Creating an async system

```ts
em.createAsyncSystem(
    genFn: (em, delta) => Generator<Yieldable, boolean | void, any>,
    system?: { tag?, condition?, interval?, init?, reset?, cleanup? }
): AsyncSystem
```

The second argument is a `Partial<AsyncSystem>` — `tag`, `condition`, `interval`, `init`, `reset`, and `cleanup` all work identically to regular systems. Async systems are `AnySystem` members and slot directly into any `Pipeline`.

## Yieldable conditions

Every `yield` inside the generator must produce a `Yieldable` — one of the four condition types below. Raw `Promise` objects are also accepted (wrapped internally), but prefer the helpers for clarity.

All helpers are methods on `em` because the generator receives `em` as its first argument.

### delay(ms: number)

Pause for `ms` milliseconds of pipeline time.

```ts
yield em.delay(500);  // pause 500ms
yield em.delay(1000 / 60); // pause one frame at 60fps
```

The deadline is set lazily on first evaluation — if the yield and first evaluation happen in the same tick (typical), there's no added latency. If you yield inside a chain that doesn't evaluate immediately (e.g. after a Promise yield), the deadline starts from the next pipeline tick.

### waitForEntity(entityId, component, mode?)

Wait for a specific entity to gain, lose, or change a component.

```ts
yield em.waitForEntity(someEntityId, 'health', 'changed');
const e = yield em.waitForEntity(someEntityId, 'readyState');  // mode defaults to 'added'
yield em.waitForEntity(someEntityId, 'isAlive', 'removed');
```

| Mode | Resolves when | Resolution value |
|------|--------------|------------------|
| `'added'` (default) | Entity gains the component | The entity object |
| `'removed'` | Entity loses the component | The entity ID |
| `'changed'` | Component value differs from last seen | The entity object |

`'changed'` snapshots the component value on first evaluation; every subsequent tick compares the current value by reference (`!==`). This means it catches reassignment and Vector2/Vector3 clone-replacement, but not in-place mutation of plain objects — for those, couple with `yield em.delay(0)` after the mutating system.

### waitForQuery(query, predicate?)

Wait for any entity matching a query to also satisfy an optional predicate.

```ts
const entity = yield em.waitForQuery(playersQuery, e => e.components.health <= 0);
const anyMatch = yield em.waitForQuery(enemiesQuery);  // no predicate = any entity in query
```

Internally creates a `Consumer` on the query (pooled per condition — reused across yield-resolve cycles on the same system, no GC churn). Checks `newEntities` then `updatedEntities` each tick. On resolution, the consumer is flushed via `forNewOrUpdated()` to reset accumulated deltas. The resolution value is the matched entity.

### Raw Promise

Yield any `Promise` directly. The pipeline polls the settled flag each tick (no `await`, no event-loop coupling).

```ts
const data = yield fetch('/api/config').then(r => r.json());
yield new Promise(resolve => setTimeout(resolve, 1000));
```

Wrapped internally as a `PromiseCondition` that sets `resolved: true` + `value`/`error` on settlement. Rejections are fed to the generator via `generator.throw(error)`, so the generator can `try/catch` around the yield.

```ts
try {
    const data = yield fetch('/api/data').then(r => r.json());
} catch (err) {
    console.warn('fetch failed, continuing:', err);
}
```

## Generator lifecycle

### Restart vs stop

When a generator returns (completes naturally), the async system restarts it from the beginning on the next tick — creating a fresh iterator from `_genFn`. This makes looping patterns natural:

```ts
em.createAsyncSystem(function* (em) {
    while (true) {
        yield em.delay(1000);
        em.quickEntity({ spawnWave: true as true });
    }
});
```

To stop permanently, `return false` from the generator — the system is marked done and will not restart.

```ts
em.createAsyncSystem(function* (em) {
    yield em.waitForEntity(sceneEntity, 'sceneName', 'changed');
    if (sceneEntity.components.sceneName !== 'gameplay') return false;
    em.quickEntity({ gameplayInit: true as true });
});
```

Any other return value (`return true`, bare `return`, implicit completion) restarts.

### Chaining resolvable yields

When a yield resolves, the generator's next segment runs. If that segment immediately yields another resolvable condition (e.g. `delay(0)`, or a `waitForEntity` for a component that already exists), the engine chains through it in the same resume flush — no tick wasted. The chain is capped at 100 iterations as a runaway guard.

## Pipeline integration

Async systems live in the pipeline's `systems` Set alongside sync systems. Processing has two phases:

1. **Evaluation (inline, during the `forEach` loop).** Each async system's current condition is checked. Condition evaluation is read-only — it reads entity maps, consumer sets, and time, but mutates nothing. Resolved systems are collected into a deferred resume queue.

2. **Resume (after all sync systems, before the pipeline's final `subTick`).** The resume queue is flushed: `.next(value)` is called on each resolved generator, which runs the coroutine's next segment (this IS the mutation phase). If a generator yields a fresh condition during the flush, it is evaluated immediately — resolvable ones chain, blocked ones are stored for the next tick. After the flush, `subTick()` fires to propagate any component writes from resumed coroutines.

**Why deferred?** Sync systems in the pipeline see a consistent snapshot of state — async resumes don't interleave with sync decisions. Within the resume flush, earlier async systems' mutations ARE visible to later async systems' resumed code (they run sequentially in the flush loop). This matches the ECS principle: condition evaluation = decision (snapshot-consistent), resume code = action (sees prior actions).

### Ordering

Async systems respect pipeline insertion order. A system at position 3 evaluates its condition after position 1 and 2 have run. Resume order within the flush is same as insertion order.

```ts
// asyncSysA's resume runs before asyncSysB's — B sees A's component writes
new Pipeline(em, asyncSysA, asyncSysB);
```

### Interaction with interval / condition

`interval` gates the entire async system (evaluation + resume), same as sync systems. `condition()` returning `false` skips the system for that tick.

```ts
em.createAsyncSystem(function* (em) { ... }, {
    interval: interval(1000 / 2),  // evaluate + resume at most every 500ms
    condition: () => em.entityExists('matchActive'),
});
```

### Pipeline.reset / init

`pipeline.reset()` calls `system.reset?.()` on async systems; `pipeline.init()` calls `system.init?.()`. Use these to reinitialize generator state (re-create the iterator from `_genFn`).

## Patterns

### Timed state machine

```ts
em.createAsyncSystem(function* (em) {
    yield em.delay(1000);
    em.setSingletonEntityComponent('matchPhase', 'countdown');
    yield em.delay(3000);
    em.setSingletonEntityComponent('matchPhase', 'playing');
    yield em.waitForQuery(playersQuery, e => e.components.health <= 0);
    em.setSingletonEntityComponent('matchPhase', 'gameover');
    return false;
});
```

### Wait for external asset load

```ts
em.createAsyncSystem(function* (em) {
    const gltf = yield gltfLoader.loadAsync('/assets/scene.glb');
    em.quickEntity({ loadedScene: gltf.scene, isScene: true as true });
});
```

### Poll until condition, then act once

```ts
em.createAsyncSystem(function* (em) {
    while (true) {
        const dying = yield em.waitForQuery(playersQuery, e => e.components.health <= 0);
        em.quickEntity({ deathEvent: { entityId: dying.id }, isDeathEvent: true as true });
    }
});
```

### Chain multiple waits

```ts
em.createAsyncSystem(function* (em) {
    yield em.waitForEntity(npcId, 'isInRange');
    yield em.delay(500);
    yield em.waitForQuery(dialogQuery, e => e.components.dialogState === 'idle');
    em.quickEntity({ dialogBox: { text: 'Hello.' }, isDialog: true as true });
});
```

## Networking patterns

Async systems linearize several network patterns that currently require separate systems + shared mutable state. For context, read `Sprixle Docs/networking.md` — these patterns assume the two proven sync shapes (broadcast patch-sync and targeted entity projection).

### Batch sync accumulator

Replaces the interval-based `syncSystem` + shared mutable `Map` for shape A (broadcast patch-sync). The accumulator lives in generator-local scope instead of module scope, and the flush loop is self-contained:

```ts
em.createAsyncSystem(function* (em) {
    let queue: Map<EntityId, Partial<SerializableComponents>> = new Map();

    em.patchHandlers = {
        components(id, components) {
            const existing = queue.get(id) || {};
            Object.assign(existing, components);
            queue.set(id, existing);
        },
        removeComponent(id, key) {
            const existing = queue.get(id) || {};
            (existing as any)[key] = undefined;
            queue.set(id, existing);
        },
    };

    while (true) {
        yield em.delay(16);
        if (queue.size === 0) continue;
        const snapshot = queue;
        queue = new Map();
        network.send(GameCommands.statePatch, encodeStatePatch(snapshot));
    }
});
```

This is a direct replacement for the shape-A pattern in `networking.md:62-66`. The generator closure owns the queue — no module-level mutable state, no separate system definition. The `yield em.delay(N)` replaces `interval(N)` on the sync system.

### Per-entity reactive publish

For targeted entity projection (shape B) or Valkey/pub-sub backplanes, react to component changes per entity and publish immediately instead of batching:

```ts
em.createAsyncSystem(function* (em) {
    while (true) {
        const entity = yield em.waitForQuery(syncableQuery);
        yield em.delay(0); // let same-tick writes settle
        publishEntity(entity);
    }
});
```

This is chatty by default — prefer batching for high-frequency components (position). Combine with `interval` on the async system to rate-limit:

```ts
em.createAsyncSystem(function* (em) { /* ... */ }, {
    interval: interval(50), // fire at most every 50ms
});
```

### Connection watchdog

Heartbeat and dead-connection detection as linear async logic instead of `setInterval` + imperative checks:

```ts
em.createAsyncSystem(function* (em) {
    while (true) {
        yield em.delay(5000);
        const now = Date.now();
        for (const client of activeClientsQuery) {
            if (now - client.components.lastPong > 30000) {
                client.components.connectionState = 'dead' as const;
                // Systems react: deregister, clean up, notify peers
            }
        }
    }
});
```

### Late-joiner state sync

Async system state is serializable — conditions and delta are captured as plain objects. This means an in-flight coroutine (timed sequence, countdown, spawn wave) can be serialized on the server and sent to a reconnecting client as part of state sync:

```ts
import { serializeAsyncSystem, deserializeAsyncSystem } from '../sprixle/ecs/asyncSystem';

// Server: serialize in-flight state
const serialized = pipeline.asyncSystems
    .filter(s => s.tag === 'replayable')
    .map(serializeAsyncSystem);
network.send(GameCommands.syncAsyncState, serialized, client);

// Client: reconstruct and resume
const saved = decodeMessage(data);
for (const entry of saved) {
    const genFn = asyncGenRegistry.get(entry.genFnId);
    if (!genFn) continue;
    const system = em.deserializeAsyncSystem(entry, genFn);
    clientPipeline.systems.add(system);
}
```

Caveats: generator local variables are lost (JS internals); predicate functions for `queryWait` are not serializable — use an `id`-based registry (`em.registerAsyncGen(id, fn)`) and skip conditions that can't be rehydrated. Unresolved Promises become `PromiseCondition` with `resolved: false` — they will re-resolve on the client's first tick.

## Caveats

- **Delta is snapshot-on-restart.** The `delta` parameter reflects the tick that created or restarted the generator, not the tick where a yield resolved. For frame-accurate timing across resumes, accumulate `yield em.delay(n)` instead of reading `delta`.

- **`'changed'` uses reference equality.** `entity.components[name] !== _lastSeen`. In-place mutations to plain objects won't trigger resolution — reassign or use `Nested` + a composition of `delay(0)` after the mutating system.

- **Promise settlement is polled, not awaited.** The `.then()` hooks set a flag; the pipeline reads the flag each tick. This adds at most one frame of latency between settlement and the pipeline seeing it.

- **Cancellation.** Async systems have no built-in cancellation API. Use `condition: () => shouldRun` to gate the system, or `return false` from the generator to stop permanently.

- **Query consumers are pooled per condition.** The consumer created by `waitForQuery` lives on the `QueryWaitCondition._consumerRef` and is reused across resolution cycles of the same condition object. Do not manually destroy it.

- **Max chain guard.** The resume flush chains at most 100 immediately-resolvable yields per entry. An intentionally infinite chain (e.g. `while(true) yield delay(0)`) is caught instead of hanging the frame.
