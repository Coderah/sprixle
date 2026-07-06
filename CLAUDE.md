# Sprixle Engine — Claude Guide

Sprixle is a rendering-agnostic TypeScript ECS engine, dropped into each game project as a git sub-repo at `src/sprixle/`. It leans on **@deepkit/type runtime reflection**: component names, annotations (`SingletonComponent`, `Nested`, `TrackPrevious`, `Pointer`), and BSON serialization are all derived from TypeScript types at runtime. The deepkit type compiler must be wired into the build (babel/postinstall) or nothing works.

Do not modify engine code from a game project unless you are deliberately fixing/improving the engine.

## Architecture philosophy

Two principles sit above every rule below — when a change you're about to make conflicts with them, restructure the change:

1. **The ECS is the medium for all cause-and-effect, not just storage.** Decisions are component writes (usually in actions); side effects — rendering, audio, network sends, DOM, three.js mutations — live exclusively in systems reacting to those writes. Never perform an effect inline where the decision is made, and never call one system from another: write the data, let a system react. (The instinctive imperative shape — find where Y happens and call `doX()` there — is wrong here even though it would compile and work.)
2. **Systems stay unaware of each other.** Components, signal entities, and query membership are the interfaces between systems; pipeline ordering is the only sanctioned coupling, and every ordering constraint gets a comment. A new feature should land as new components + new systems + an action, with existing systems untouched. If a change forces edits across many systems, that's a data-modeling smell — fix the components, not the systems.

This is what buys the ability to pivot: features compose and detach through data, so changing one behavior doesn't ripple through the codebase.

## Golden rules

1. **The ECS is the source of truth for all game/app state.** UI (Vue, DOM, three.js scene) is a reactive read layer on top of it, never a state manager.
2. **Create the manager with no runtime args**: `const em = new Manager<ComponentTypes>()`. Passing a component-defaults array/object is deprecated (old projects and `boilerplate/` still do it).
3. **Create entities with `em.quickEntity({...}, id?)`** — it creates, adds components, and registers in one call. Boolean tag components typed as `true` need `as true` at the call site (`isEnemy: true as true`).
4. **Mutate by direct assignment and `delete`**: `entity.components.x = v` / `delete entity.components.x`. Do **not** use `em.addComponent`/`em.removeComponent` — direct mutation goes through the components Proxy and fires queries/consumers/patchHandlers correctly. Before mutating *inside* an object component (Vector, Map, array), call `entity.willUpdate('x')` first — or type the component `Nested<T>` for automatic deep tracking.
5. **`previousComponents` only holds keys annotated `TrackPrevious`** (indexed query components get it automatically). Use it for before/after diffing in `updated` handlers.
6. **Define every query once, in one `queries.ts`, and import it everywhere.** Consumers only fire on the components a query `includes` — choosing `includes` is choosing your reaction semantics.
7. **`query.entities` is a `Set` (of EntityIds) with prototype extensions** — `.first()`, `.map()`, `.filter()` etc. `.map()`/`.filter()` return **Sets, not arrays** (`[...set]` to convert). `query.get(indexValue)` returns a Set of **Entity objects**, not ids. `EntityId = string | bigint`; compare with `===`, stringify with `String(id)`.
8. **Systems are query-consumer reactions**, built with `em.createSystem(query.createConsumer(), { forNew, updated, removed, newOrUpdated, all, tick, init })`, composed into ordered `Pipeline`s. Ordering inside a pipeline is load-bearing — comment why. Call `em.tick()` exactly once at the end of each frame, after all pipelines.
9. **Split code by build context from day one**: `src/game/` (shared, no DOM/Node imports), `src/client/`, `src/server/`. Networking, and any second build target (role/kiosk pages), depend on this split staying clean.
10. **Never put ECS entities/components in Vue `ref()`/`reactive()`.** Use the vuePlugin composables (`useQuery`, `useEntity`, `useComponent`, …) which are built on `shallowRef`; do sorting/filtering in `computed()`.
11. **Wire payloads**: flat arrays of primitives for small tuples; BSON `Uint8Array` blobs (via `em.createSerializer`) for entity snapshots and nested structures. Never send live objects; `socket` must be `Omit`ted from anything serializable.

## Topic docs (read when relevant)

All under `src/sprixle/Sprixle Docs/`:

- **ecs-core.md** — Manager, entity lifecycle, component mutation semantics, annotations, singletons, tick/subTick, patchHandlers, serialization/pointers.
- **queries-systems.md** — query params (index, flexible, timeSlicing), consumers, system/pipeline API, and the performance cookbook (reaction-scoped queries, dirty-flag+flush, transition components).
- **networking.md** — the shared-code client/server model: `applyNetwork`, `createServer`/`createClient`, encoders, state sync (two proven shapes), `@RPC`/`RPCActions`, reconciliation, heartbeats. Read this before touching any networked feature.
- **vue-bridge.md** — vuePlugin composables, shallowRef discipline, per-consumer refs, cleanup rules, known scars.
- **blender.md** + **blender-authoring.md** — the Blender pipeline concept doc, and the practical authoring conventions (`+feature(arg)` name DSL, export-attribute modifiers, shaderTree methods, prefab collections, hot reload).
- **game-patterns.md** — cross-project proven patterns: signal entities, calculatedComponents overlay, grid-cell caches, zone-by-tag, timed FSMs, hitstop, input binds, actions layer.
- **legacy-modernization.md** — old idioms you WILL see in older branches (shadow-boxer, sobelow) and their modern replacements. `boilerplate/` is stale; see this doc before copying from it.
- **new-project.md** — checklist for standing up a new project on the engine.
- **engine-roadmap.md** — known engine gaps and plugin-extraction candidates mined from the game projects. Check it before hand-rolling something; add to it when you feel a gap.

`plugins.md` is auto-generated signature tables (via `generate-docs.ts`); regenerate rather than hand-edit.

## Doc maintenance

These docs are part of the engine's change surface. When an engine change alters behavior documented here, **update the affected topic doc in the same commit**. Each topic doc carries an `Engine ref: <commit> (<date>)` stamp recording when its claims were last written/verified against engine source — bump the stamp whenever you re-verify or update a doc. A doc whose stamp is far behind engine HEAD should be read with suspicion.
