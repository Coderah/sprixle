# Game Patterns — proven across projects

*Engine ref: f3f5215 (2026-07-05)*

Patterns mined from test-pilots, cursory-world, sobelow, shadow-boxer, lanebreak-tactics, and laok. Each entry names its reference implementation. Prefer these shapes over inventing new ones; if a pattern is missing, consider whether it belongs in `engine-roadmap.md`.

Every pattern here is an instance of the two principles in the engine CLAUDE.md: cause-and-effect flows through component writes (decisions in actions, effects in reacting systems), and systems communicate through data — components, signal entities, query membership — never by knowing about each other. Read the patterns as answers to "how do I get X done *without* coupling systems," not as isolated tricks.

## Project layout & mutation discipline

```
src/game/    ← shared simulation: components.ts, queries.ts, actions.ts, entityManager.ts,
               simulationPipeline.ts, systems/ (one file per system), encoders.ts, network.ts
src/client/  ← entry + rendering + Vue/DOM bridge (build-specific)
src/server/  ← server entry + server-only systems (networked projects)
```

- **`actions.ts` is the only sanctioned mutation entry point** for user-triggered changes (test-pilots at scale; laok's drag-drop TODOs show what skipping this costs — no validation seam, no server authority path, no undo grouping). UI calls actions; actions mutate components; systems react.
- Keep "one file per system" honest — test-pilots' 3000-line `playheadSystem.ts` (14 systems) is the documented counterexample.
- Pure computation helpers (traversals, resolution math) live in plain modules with no ECS imports, so they're testable and shareable.

## Entity modeling

- **Everything is an entity with flat tag components** — no classes. Distinguish kinds by boolean tags (`isEnemy: true as true`), relate by id (`ownerId: EntityId`) + indexed queries, never by object references.
- **Zone-by-tag** (laok, lanebreak): an item's location (store/inventory/board, forge/equipped) is which tag components it has; moving = add/delete tags. Queries slice zones via includes/excludes. No parallel data structures.
- **Grid-cell cache entities** (lanebreak): pre-create one entity per cell with a deterministic id (`grid${x}-${y}`), holding pick targets and a `unitId` back-reference maintained by a consumer watching unit positions. O(1) spatial lookup + decoupled raycast picking. For sparse/large worlds: string `chunkId` component + `index: 'chunkId'` (cursory-world).
- **Signal entities** (shadow-boxer, lanebreak): one-shot cross-system events as ephemeral entities (`isDamageSignal`, SFX/music signals, collision pairs keyed `'collision'+a+b`). A consumer performs the side effect and deregisters it. **Always give signals a death path** (`deadAt` + DeathEffectPlugin, or explicit cleanup next step) — undying signals are a real leak shadow-boxer shipped with.
- **`calculatedComponents` overlay** (laok): keep authored/base data immutable; a consumer system recomputes a parallel `calculatedComponents` (a `Pick<>` of derived keys) whenever inputs change; readers use `entity.components.calculatedComponents ?? entity.components`. Clean template for stats/buffs/loadout math, and shows derived-vs-base deltas trivially in UI.

## State machines & sequencing

- **Per-entity FSM**: use `stateMachinePlugin` (`state` + `stateStartedAt`, `attemptChangeState`, `setInStateLogic`/`setEnteredStateLogic`). Don't hand-roll (shadow-boxer predates it and paid for it).
- **Match/scene FSM as a singleton** (lanebreak, shadow-boxer): a `SingletonComponent` enum (`matchState`, `sceneName`) + a `stateStartedAt` timestamp, advanced by comparing `now() - stateStartedAt` against a durations table; pipelines gate on it via `.condition`. Scene enter/exit logic = a consumer on the scene singleton's query.
- **DeathEffect as a one-shot timer/sequencer** (shadow-boxer, sobelow): a throwaway entity with `deadAt` + `deathEffect: { id: targetId, components: {...} }` applies components to *another* entity when it expires. Also the "after this tween finishes, do X" idiom: give the tween entity a `deathEffect`.
- **Hitstop / slow-mo** (shadow-boxer): a `freezeFrameUntil` singleton timestamp gates the sim pipeline tick (render keeps running); a tweened `timeScale` singleton feeds `pipeline.getTimeScale` for slow-mo. Cheap, juicy, reusable.

## Data-driven design

- **Enum-keyed `Partial` stat maps** (`attributes: Partial<Record<ATTRIBUTE, number>>`) + static config tables (per-level parameters, modifier criteria) keep balance in data. lanebreak's `Modifier` model (criteria enum + effects enum + parameter tuples) and laok's crafting tables are the references. `cloneDeep` per-entity copies of shared tables before mutating them.
- **Declarative grid pattern matching** (laok `patterns.ts`): `PatternDefinition = { relativeCoords, maybeIncorporate(entity, coord, i) }` + `findAllPatterns(grid, patterns, exclusive?)` + a query→2D-grid adapter. One matcher served both crafting recipes and loadout synergies. Extraction candidate.
- **Derived animation** (shadow-boxer): compute the current frame purely from `(state, stateStartedAt, now)` — never store frame counters. Frame-rate independent and rewind-safe.
- Static game data referenced by components → `gameDataPlugin` / `Pointer` types, so saves/wire carry keys, not copies.

## Rendering & UI reaction

- Consumer systems own the ECS→scene sync: `forNew` mounts (mesh/div), `updated` writes, `removed` unmounts. Pool DOM elements (`PooledMap`).
- **Components-as-CSS** (cursory-world, laok): entity component keys → element classList; state values → `data-*` attributes and CSS vars; all visual styling lives in CSS. Zero-boilerplate DOM rendering.
- Camera follow/vignettes/screen-shake read health/position deltas from `previousComponents` in consumers (damage numbers, shake triggers).
- 3D-anchored HTML → `zUIPlugin`; component→DOM lifecycle → `UISystem`; Vue apps → vuePlugin (see vue-bridge.md).

## Input

- `applyInputPlugin` with **declarative binds**: `upsertInputBinds({ click: [MouseLeft, Touch0], ... })` with activation `press|held|release`, then `createInputBindHandlers(pressMap, releaseMap)`. Keyboard/mouse/touch/gamepad unified; world-position raycasting via `useThreeForWorldPosition` + camera.
- **Custom input sources** (orrery WebMIDI): the plugin returns `injectInput(name, state, value?)` (press = `now()`, release = `null`) and `pulseInput(name, value?)` (momentary — auto-releases after propagating to binds, like `*Move` inputs; `value` rides `inputPosition`, e.g. a relative-encoder delta magnitude read off the bind entity in handlers). A source adapter (MIDI/OSC/serial parser) injects canonical names (`'MidiNote36'`) and **binds do all mapping** — `inputBinds: ['KeyA', 'MidiNote36']` is one bind, two physical controls. `resolveInputMode` option classifies custom names into `activeInputMode`. Magnitude caveat: handlers should only honor `inputPosition` when the bind's `inputName` is the analog input — a later keypress on the same bind would stale-read it otherwise.
- **Input buffering** (shadow-boxer): on a rejected state change, store `{ bufferedInput, time }` and retry within a leniency window (~300ms) each tick. Essential feel for action games.
- Route input handlers through actions (they may be RPCs on networked games — cursory-world's mouse-move → `actions.movePlayer` reconciled RPC).

## Audio (until an engine plugin exists)

shadow-boxer's recipe: WebAudio buffer cache; **variant selection** by stripping a `-N` filename suffix and rolling a random variant; music as two-node crossfade per layer (`linearRampToValueAtTime`, resume-from-offset); `audioContext.resume()` retry for autoplay policies. Trigger via signal entities.

## Timing

- `interval(ms)` from `util/timing` for throttled systems; `.accumulative = false` to drop missed runs.
- `dLerp` (`util/damp`) for framerate-independent damping — never raw `lerp(a, b, k)` per frame.
- `now()` is memoized per tick and pipeline-aware (`useInternalTime`); always use it over `Date.now()` inside systems.
