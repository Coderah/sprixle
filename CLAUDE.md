# Sprixle Engine — Claude Guide

Sprixle is a rendering-agnostic TypeScript ECS engine, dropped into each game project as a git sub-repo at `src/sprixle/`. It leans on **@deepkit/type runtime reflection**: component names, annotations (`SingletonComponent`, `Nested`, `TrackPrevious`, `Pointer`), and BSON serialization are all derived from TypeScript types at runtime. The deepkit type compiler must be wired into the build (babel/postinstall) or nothing works.

Do not modify engine code from a game project unless you are deliberately fixing/improving the engine.

## Working style

**Do not build or verify.** No `tsc`, no webpack compiles, no dev servers, no
headless-browser runs to prove your code works — the user is a skilled engineer who
builds and verifies on his own cadence, and end-to-end verification wastes tokens.
Make the change, state what to observe when he runs it, and stop. The one sanctioned
exception is a **cheap sanity test of an isolated pure algorithm** in node — the
`scratchpad/*-sanity.mjs` files (e.g. `t7-varlength-sanity.mjs`) are this exception in
practice: prove the math in isolation, never drive the app.

**Forked work out of a master agent.** For multi-part work you (the master agent) stay
the orchestrator — hold the plan, delegate the parts, keep the conclusions not the file
dumps.

- **Read/explore fan-out parallelizes freely.** Read-only agents never collide, so
  launch them together (one message, multiple calls) and synthesize their reports.
- **Parallelize UNRELATED implementation, serialize RELATED — the test is the work, not
  the file.** Nearly every change touches `components.ts`/`actions.ts`, so "different
  files" is the wrong bar: two agents adding *independent* components/actions in
  different regions of the same file merge cleanly. Serialize when the changes *relate* —
  same logic, interdependent, or one's output feeds the other's edit. This is not a
  never-parallelize rule; it's "don't parallelize work that collides in meaning." When
  unsure whether two parts relate, serialize.
- **Lean fresh over fork, but decide per agent.** A fresh agent carries lean context and
  lets you pick the model; a fork inherits the whole transcript (no re-briefing, but
  locked to the parent model and dragging the full context along). A good spec doc
  externalizes the context a build needs, which usually tips it toward fresh — but it's
  the delegating call each time, not a rule.
- **Editing agents run in a git worktree** (`isolation: "worktree"`, fresh or fork
  alike): their edits land in an isolated checkout, so the user's working tree stays put
  — they keep the app running and make their own small tweaks without the dev server
  reloading on every agent write. Read-only fan-out skips it (no edits, and worktrees
  cost setup + disk). A worktree isolates the *live filesystem, not the merge* — related
  work still conflicts on integration, so the relatedness rule above still governs.
  **SCAR — agent worktrees come up broken two ways** (hit 2026-07-07, all three agents
  of a batch): (1) `src/sprixle/` is EMPTY — `git worktree add` never initializes
  submodules, so the engine source is missing and the root CLAUDE.md's
  `@src/sprixle/CLAUDE.md` import fails at agent boot (this doc never loads for that
  agent); (2) the worktree may be based at the DEFAULT-branch merge-base, not the
  working branch's HEAD — none of the branch's code or docs present. The protocol,
  IN ORDER (a stale base can record an uncheckoutable submodule pointer, so the
  ff-merge must precede the init): every worktree agent's prompt starts with
  (1) verify `git log --oneline -1` matches the working branch's HEAD — if stale,
  `git merge --ff-only <branch>` (never `reset --hard`; the sandbox blocks it);
  (2) `git submodule update --init src/sprixle`; (3) read `src/sprixle/CLAUDE.md`
  explicitly — the boot @-import already failed before any fix could land, so the
  read must be explicit.
- **Commit between batches.** A forked build checkpoints: integrate each completed
  batch's worktree back and commit before launching the next, so the tree is always
  recoverable, the user sees one controlled reload (not a stream), and the next batch
  starts clean. This is the standing exception to "commit only when asked" — it holds for
  a multi-batch forked build the user has set in motion (branch first if on the default
  branch, as always).

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
- **contract-docs.md** — the prompt-set method: how to author and reconcile a project's `<project>-<topic>.md` contract/scope docs (framing, locked decisions, verified groundwork, the reconciliation-authority pattern, status/SCAR markers). Read it before writing or reconciling a scope doc. This is a *method* doc, not an engine-source doc.

`plugins.md` is auto-generated signature tables (via `generate-docs.ts`); regenerate rather than hand-edit.

## Doc maintenance

These docs are part of the engine's change surface. When an engine change alters behavior documented here, **update the affected topic doc in the same commit**. Each topic doc carries an `Engine ref: <commit> (<date>)` stamp recording when its claims were last written/verified against engine source — bump the stamp whenever you re-verify or update a doc. A doc whose stamp is far behind engine HEAD should be read with suspicion.
