# ECS Core

*Engine ref: f3f5215 (2026-07-05)*

Source: `ecs/manager.ts`, `ecs/types.ts`, `ecs/pool.ts`, `ecs/object.extensions.ts`.

## Manager

```ts
// entityManager.ts — one singleton per app, imported by every other module
import { Manager } from '../sprixle/ecs/manager';
import { ComponentTypes } from './components';

export const em = new Manager<ComponentTypes>();
globalThis.em = em; // console debugging
```

- The **type argument alone** drives everything: component names, annotations, and pointer paths are extracted via deepkit reflection at construction. Passing a runtime defaults array/object is **deprecated**.
- `ComponentTypes` must extend `defaultComponentTypes`, which provides `ownerId`, `createdAt`, `updatedAt`.
- Convention: one giant `ComponentTypes` interface in `components.ts` is the central registry of every component key in the app. Compose plugin component types in by intersection (`& InputComponents & TweenComponents<...> & NetworkComponentTypes ...`).

## Entities

`Entity = { id, components, previousComponents, willUpdate(key), quietSet(key, value) }`. `flagUpdate` is a deprecated alias of `willUpdate`.

- `EntityId = string | bigint`. Compare with `===` (both compare by value); use `String(id)` when a string key is needed. IDs default to uuid via `em.genId()`.
- **Using a meaningful string as the entity id is a first-class pattern**: device UUID as id (O(1) `em.entityExists(id)`/`getEntity(id)` instead of a query), grid cells as `grid${x}-${y}`, collision pairs as `'collision'+a+b`, singletons as the component name.

### Creation

```ts
// Modern one-shot path — gets-or-creates (by id), adds components, registers:
const e = em.quickEntity({ isEnemy: true as true, position: new Vector3() }, optionalId);

// Explicit path (rare — when you must stage before registering):
const e = em.createEntity(id);
em.addComponents(e, {...});
em.registerEntity(e);

em.cloneEntity(entity, excludeKeys?);
em.deregisterEntity(entity);
```

### Mutation semantics (the most important section in this doc)

`entity.components` is a **Proxy**. All change tracking flows through it:

```ts
entity.components.name = 'foo';     // add OR update — fires queries/consumers/patchHandlers
delete entity.components.isSelected; // remove — fires removeComponent handlers

// Deep mutation of an object component: flag FIRST, then mutate
entity.willUpdate('position');
entity.components.position.add(velocity);

// Set without any update flagging (used by reconciliation; rarely by games):
entity.quietSet('position', v);
```

- Do **not** use `em.addComponent`/`em.removeComponent`/`em.updateComponent` — they are thin legacy wrappers; direct assignment is the idiom.
- Never cast `entity.components` or `entity.previousComponents` to `any`. All keys are in `ComponentTypes`. For dynamic key iteration (history replay, generic serializers), cast to `Record<string, unknown>`.
- Assigning a **brand-new key** re-matches the entity against queries; assigning an existing key flags an update (staged, flushed on the next `subTick`).

## Component annotations (`ecs/types.ts`)

Attach by type intersection in `components.ts`:

| Annotation | Effect |
|---|---|
| `TrackPrevious` | The prior value is copied into `entity.previousComponents` on change (Vectors are cloned). Only annotated keys populate `previousComponents`. Indexed query components get this automatically. |
| `SingletonComponent` | Enforced unique; lives on a lazily-created entity whose **id is the component name**. |
| `Nested<T>` | Wraps the value in a deep proxy so any nested mutation auto-calls `willUpdate` — no manual flagging. |
| `Pointer<Map, 'name'>` | Serializes as a key into a named data source registered with `em.registerPointers({name: map})`; rehydrates as the live reference. Use for static game-data references (see gameDataPlugin). |

```ts
position: Vector3 & TrackPrevious;
sceneName: SceneName & SingletonComponent;
inventory: Nested<{ slots: ItemSlot[] }>;
unitData: Pointer<typeof unitTable, 'units'>;
```

## Singletons

Global state without globals — heavily used in every project (`sceneName`, `matchState`, `selfPlayerId`, `mouseTarget`, …):

```ts
em.setSingletonEntityComponent('sceneName', SceneName.menu);
const scene = em.getSingletonEntityComponent('sceneName');
const holder = em.getSingletonEntity('sceneName'); // entity id === 'sceneName'
```

Bootstrapping several at once: `em.quickEntity({ sceneName, fadeToBlack }, 'sceneName')`.

**Caution — don't let singletons become a global bus.** Reserve them for genuinely global state (scene, match phase, self-player id, input mode). If two systems are communicating through a singleton, or the value really describes one entity, put a component on that entity or use a signal entity instead — a dozen ad-hoc singletons makes data flow untraceable (sobelow is the cautionary example).

## Tick model

- `em.subTick()` — flushes `stagedUpdates` into queries/consumers and fires `patchHandlers.components`. **A `Pipeline` calls this automatically after each system** — you only call it manually when running systems outside a pipeline.
- `em.tick()` — **once, at the end of the frame**, after all pipelines: final subTick, rotates `updatedEntities` → `previouslyUpdatedEntities`, clears new/deleted sets, ticks queries, runs one-shot `tickHandlers`, clears the memoized `now()` cache.

```ts
function frame(delta: number) {
    mainPipeline.tick(delta);
    em.tick();
    requestAnimationFrame(frame); // server: setImmediate recursion
}
```

## patchHandlers — the change-observation seam

`em.patchHandlers = { register?, components?, removeComponent?, deregister? }` observes *every* entity change. This is how the network plugin builds state patches and the vuePlugin drives reactivity.

Rules learned the hard way (test-pilots):
- **Chain, don't replace.** When installing handlers where others may exist, capture the existing handler and call it:
  ```ts
  const prev = em.patchHandlers.components;
  em.patchHandlers.components = (id, components) => { prev?.(id, components); mine(id, components); };
  ```
- Install order matters (e.g. history recording before Vue reactivity). Make installation an explicit function call (`installHistoryRecording()`), not a module import side effect, when it's build-specific.
- `components` fires on the subTick flush (deferred), not synchronously at assignment.
- Beware side-effectful handlers (auto-save, sync) firing during load/connect flows — touching a persisted component on an entity before its config finishes loading can clobber saved state. Guard handlers with load-state checks.

## Serialization & pointers

```ts
type SerializableComponents = Omit<ComponentTypes, 'socket'>; // never serialize live objects
export const encodeEntity = em.createSerializer<TransmittableEntity>();
export const decodeEntity = em.createDeserializer<TransmittableEntity>();
```

- BSON via deepkit; register vector support once (`registerVectorSerializers()` from `data/`) so `Vector2/3` survive the wire.
- Convention: **all serializers live in one `encoders.ts`**. Anything needing `SerializableComponents` (wire sync, save format, undo log) ends up there — accept that it is the serialization crossroads, and keep wire vs disk sections clearly separated.
- `em.registerPointers({ name: dataSource })` + `Pointer<...>` fields: components serialize as keys, rehydrate as references; supports hot-reload replacement.

## Set/Map prototype extensions (`ecs/object.extensions.ts`)

Importing `ecs/manager` installs these. Used pervasively on `query.entities` and `query.get()`:

```
.first() .find(fn) .some(fn) .every(fn) .reduce(fn, init)
.map(fn)     → Set (NOT array!)
.filter(fn)  → Set
.sort(fn)    → array
.toArray()   → array
.union(b) .intersect(...b) .subtract(...b) .keyBy(propertyKey) .equals(b)
```

The `.map()`-returns-Set gotcha is the single most common footgun in the codebase family.

Known defects (verified 2026-07, see engine-roadmap.md): **`Set.last()`, `Map.first()`, and `Map.last()` are broken** — they index into an iterator (`this.values()[n]`) and always return `undefined`; don't use them until fixed. `Set.prototype.union` **overwrites the native ES2025 `Set.prototype.union`** with slightly different semantics — be aware when reading MDN-based expectations.

## Performance utilities

- `Pool<T>` / `PooledMap<K,T>` (`ecs/pool.ts`) — object recycling; the manager uses `PooledMap` for `stagedUpdates`. Reuse for hot-path allocations (e.g. pooled DOM elements in a renderer).
- `startPerformanceMeasure`/`endPerformanceMeasure` (`ecs/performance.ts`) — no-ops until `globalThis.trackPerformance()` is called; then Pipelines/Systems emit `performance.mark/measure` (keyed by `.tag`) visible in the browser performance timeline. `trackPerformance` is only defined when `NODE_ENV !== 'production'` — it cannot be enabled in a production build.
