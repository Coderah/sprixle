# Legacy → Modern

*Engine ref: f3f5215 (2026-07-05)*

Older branches (shadow-boxer, sobelow, parts of laok/lanebreak) pin older engine versions and predate current APIs. When continuing or modernizing a project, translate on sight — and don't copy legacy idioms into new work.

| You'll see (legacy) | Write instead (modern) |
|---|---|
| `new Manager<C>(COMPONENT_DEFAULTS)` / defaults arrays | `new Manager<C>()` — type-driven, no runtime args |
| `em.addComponents(e, {...})` on a fresh entity + `registerEntity` | `em.quickEntity({...}, id?)` |
| `em.addComponent(e, 'x', v)` / `em.removeComponent(e, 'x')` | `e.components.x = v` / `delete e.components.x` |
| `entity.flagUpdate('x')` | `entity.willUpdate('x')` (same semantics, current name) — or type the component `Nested<T>` and skip manual flagging |
| Hand-rolled per-entity FSM (`moveState` + `moveStateStartedAt` + custom `changeState`/timeout systems) | `stateMachinePlugin` (`attemptChangeState`, `setInStateLogic`, `setEnteredStateLogic`) |
| Hand-rolled state-entity scans (`statesQuery.find(s => s.components.stateName === n)`) | indexed query (`index: 'stateName'`) + `.get(n)` |
| Plain `applyXPlugin(em, ...)` plugin authoring | `sprixlePlugin(fn, dependencies?, options?)` — registers in `manager.plugins`, resolves declared dependencies (how network/renderer/shaderTree/gameData are built). Older plugins (Input, Tween, StateMachine, DeathEffect, editorUI, UISystem, zUI, vue) still use the plain form — fine to consume, don't imitate for new plugins. |
| Re-trigger hacks: `query.addEntity(e)`, `query.for(system.updated)` | mutate a component the consumer genuinely reacts to |
| Manual `em.subTick()` between hand-called system functions | compose systems into a `Pipeline` (it subTicks after each system) |
| `console.log` in per-collision / per-transition hot paths | `util/log` wrappers, or remove; hot-path logging shipped as jank |
| Raw `Date.now()` in systems | `now()` (memoized, pipeline-time aware) |

## Engine facts that trip people up

- **`plugins/loaderPlugin.ts` is an empty placeholder.** Manual GLTF/texture loading (GLTFLoader + LoadingManager) is still the norm — don't hunt for a loader plugin, and don't be surprised old projects hand-roll it.
- **`boilerplate/` is stale.** It passes deprecated defaults to `Manager`, imports input code from a path that no longer exists, and drives systems manually instead of via `Pipeline`. Use it for the *shape* of a project (see new-project.md), not verbatim.
- `Sprixle Docs/plugins.md` is auto-generated signatures only — regenerate via `generate-docs.ts`, don't hand-edit.
- The deepkit type compiler is load-bearing. If component names come back empty or serializers explode, check the babel/deepkit wiring before debugging engine code.

## Per-branch era notes (game projects in the studio repo)

- **test-pilots** — most current engine usage; canonical for networking (fleet shape), Vue bridge, patchHandlers, actions/undo. Its `CLAUDE.md` is the most complete project doc.
- **cursory-world** — canonical for multiplayer (patch-sync, RPC, reconciliation, server-gated sim). DOM renderer, no three.js.
- **sobelow** — pre-plugin era: hand-rolled loading, hand-rolled state entities, monolithic `worldSystem`. Its rendering/shader-injection toolkit (reflector, depthDiff, compile chaining) and feature-tag loader are the valuable parts.
- **shadow-boxer** — oldest idioms (addComponents/flagUpdate everywhere, hand-rolled FSM) but the richest source of un-extracted gameplay patterns (physics bridge, audio, hitstop, input buffer — see engine-roadmap.md).
- **lanebreak-tactics** — canonical for Blender/shaderTree/prefabs/batching; unfinished gameplay, so treat scaffolding (commented-out blocks, wall-clock FSM timing) as non-normative.
- **laok** — prototype; canonical for calculatedComponents overlay + grid pattern matcher; UI mutates directly (no actions layer) — don't copy that part.
