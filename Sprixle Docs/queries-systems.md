# Queries, Systems, Pipelines & Performance

*Engine ref: f3f5215 (2026-07-05)*

Source: `ecs/query.ts`, `ecs/system.ts`.

## Queries

Define **all queries in one `queries.ts`**, each a top-level `export const`, with a doc comment explaining *why* it includes what it includes. This is not just style: `createQuery` looks like it dedups identical definitions by derived name, but that branch is dead code (the `Query` constructor uuid-mangles the name on collision before the check runs — see engine-roadmap.md), so **two identical `createQuery` calls produce two independent queries** with separate entity sets and consumers. Defining once and importing everywhere is the only thing preventing silent duplication.

```ts
export const rowQuery = em.createQuery({
    includes: ['isRow', 'ownerId', 'position'],
    excludes: ['isDeleted'],
    index: 'ownerId',              // builds value → Set<Entity> index, enables .get(v)
    // flexible: true,             // match ANY of includes instead of ALL
    // timeSlicing: { count: 50 }, // or { percentage: 25 } — spread iteration over ticks
});
```

- `query.entities` — `Set<EntityId>`, updated **synchronously** on mutation. In action code, reads are safe immediately after a mutation. (In Vue, values update on the next RAF tick via the composables.)
- `query.get(indexValue)` — `Set<Entity>` (full entity objects). Don't mix up with `.entities` (ids).
- Iteration: `for...of` and `.for(fn)` respect time-slicing; `.find/.filter/.map/.first/.last` ignore it.
- **Indexed queries replace linear scans.** If you're writing `query.find(e => e.components.x === v)` in a hot path, you want `index: 'x'` and `query.get(v)` instead. Repeated `.find` scans (states by name, grid lookups) are a recurring perf smell in older projects.

### Consumers

`query.createConsumer()` tracks deltas since last consume: `newEntities`, `updatedEntities`, `deletedEntities`. Consumers are the input to reactive systems. Call `consumer.destroy()` on teardown (Vue `onUnmounted`, plugin cleanup) — leaked consumers are iterated every frame forever.

**Consumers only fire for changes to components in the query's `includes`.** This is the core reactivity lever: define near-duplicate queries that differ only in which key they include to control what triggers a reaction. (e.g. test-pilots has `textQuery` — structure only — and `textBodyQuery` — includes `text` — so body edits fire only the latter.)

## Systems

Three shapes via `em.createSystem(...)`:

```ts
// 1. Sourceless — tick only. Used as flush/drain points.
const flushSystem = em.createSystem({ tick(delta) { if (!dirty) return; flush(); dirty = false; } });

// 2. Query system — `all` runs for every matching entity every frame.
const damped = em.createSystem(fadeQuery, { all(entity, delta) { ... } });

// 3. Consumer system — reacts to deltas. The workhorse.
const mySystem = em.createSystem(rowQuery.createConsumer(), {
    init() {},                    // once, on pipeline.init()
    forNew(entity, delta) {},     // entity newly matches
    updated(entity, delta) {},    // an includes'd component changed
    newOrUpdated(entity, delta) {},
    removed(entity, delta) {},    // stopped matching or deregistered
    all(entity, delta) {},        // every matching entity, every tick
    tick(delta) {},               // once per tick, after per-entity handlers
    interval: interval(1000 / 30),// throttle (util/timing); set .accumulative = false to skip missed runs
    condition: () => enabled,     // gate the whole system
    tag: 'mySystem',              // performance timeline label
});
```

In `updated`, detect *real transitions* by comparing against `previousComponents` (requires `TrackPrevious`):

```ts
updated(entity) {
    if (entity.previousComponents.sceneName === entity.components.sceneName) return;
    ...
}
```

## Pipelines

```ts
export const simulationPipeline = new Pipeline(em, systemA, systemB, subPipeline, ...);
```

- Pipelines nest (a Pipeline is system-shaped). Group related systems into sub-pipelines and compose in the entry.
- **Ordering is load-bearing**: producers before consumers so same-tick propagation works; batching flush systems last. Comment every ordering constraint.
- `pipeline.condition = () => ...` gates a whole pipeline — e.g. scene gating (`sceneName === 'gameplay'`), or **server-authority gating**: `simulationPipeline.condition = () => !IS_CLIENT || !IS_NETWORKED` makes the same shared sim run on server or offline sandbox, never on a networked client.
- `deltaPerTick` — fixed-timestep substepping (accumulates lag, reruns). `useInternalTime` — pipeline owns its clock (`now()` reads it). `getTimeScale?()` — scale delta: pause, hitstop, slow-mo (tween a `timeScale` singleton and read it here).
- `pipeline.init()` once at boot; `tick(delta)` per frame; the pipeline calls `em.subTick()` after each system automatically.

## Performance cookbook (patterns proven across projects)

1. **Reaction-scoped queries.** Choose `includes` so consumers fire only on what matters (see above). React to **transition flag components**, not high-churn values: key the query on `pollClosed`/`pollOverride` rather than `pollVotes`, and a flood of vote updates costs nothing.
2. **Dirty-flag + tick-flush coalescing.** Handlers don't do expensive work; they set a module-level flag/queue. A `tick()` (same system or a later drain system) flushes **once per tick** and early-returns when clean. Collapses bursts (votes, text edits, serial output) into one broadcast/recompute.
3. **Interval throttling.** `interval(ms)` on systems that don't need every frame (AI, shadows, sync flush). `accumulative = false` to drop missed ticks instead of catching up.
4. **Time-slicing** for large populations where per-entity work is deferrable.
5. **Entity-id-as-identity** for O(1) existence/lookup instead of queries (devices, grid cells, collision pairs).
6. **Indexed queries** for spatial/ownership buckets: `index: 'ownerId'`, `index: 'chunkId'` (string chunk ids as a cheap spatial hash).
7. **`previousComponents` diffing** instead of storing shadow copies yourself.
8. **Pooling** hot allocations (`PooledMap` of DOM elements keyed by entity id in DOM renderers).
9. **Measure with the built-ins**: `globalThis.trackPerformance()` + browser performance timeline; `editorUIPlugin.addDeltaGraph()` for a live FPS/delta graph.

### Known gap: reacting to multiple queries at once

There is no `anyUpdated` consumer spanning several queries. The current workaround is N consumers each setting the same dirty flag, flushed by one tick (pattern 2). laok's code comments request this feature; see `engine-roadmap.md`.

### Re-trigger hacks to avoid

Older code re-fires handlers via `query.addEntity(entity)` or `query.for(system.updated)`. These work but bypass the delta model — prefer setting a component (even a counter/timestamp) that the consumer genuinely reacts to.
