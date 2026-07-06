# Starting a New Project

*Engine ref: f3f5215 (2026-07-05)*

Checklist for standing up a game on sprixle. Copy the *shape* below (the committed `boilerplate/` is stale — see legacy-modernization.md). When in doubt about a piece, read the reference branch named for it.

## 1. Repo & build

- New branch of the studio repo (each project is a branch); `src/sprixle` submodule present.
- Webpack + babel with the **deepkit type compiler** wired (`@deepkit/type`, `deepkit-type-install` postinstall, `.babelrc` transformer). Without it, reflection-driven component names/serializers silently break.
- One webpack entry per build target. For networked projects, use DefinePlugin (or env in npm scripts) to set `IS_CLIENT` / `IS_NETWORKED` / endpoint constants. Networking needs the node polyfill config (see engine `webpack.config.js` for reference).
- Root `CLAUDE.md` on the branch containing `@src/sprixle/CLAUDE.md` plus project-specific notes (feature vocabulary, domain rules, build targets).

## 2. Core files (src/game/)

| File | Contents |
|---|---|
| `entityManager.ts` | `export const em = new Manager<ComponentTypes>();` + `globalThis.em = em`. Nothing else (except documented import-order constraints on networked projects). |
| `components.ts` | The one `ComponentTypes` interface: game components + plugin component types by intersection (`InputComponents & TweenComponents<...> & NetworkComponentTypes & ReconciliationComponentTypes ...`), annotations (`TrackPrevious` on anything diffed/lerped, `SingletonComponent` for globals, `Nested` for deep-mutated objects). |
| `queries.ts` | Every query, documented. Index anything looked up by value. |
| `actions.ts` | All user-triggered mutations. On networked projects this is your `RPCActions` subclass. |
| `simulationPipeline.ts` | Ordered game systems; comment ordering constraints; `.condition` for server-authority gating if networked. |
| `systems/` | One file per system. |
| `encoders.ts` | (networked/persisted) `SerializableComponents = Omit<ComponentTypes, 'socket'>`, serializers, `registerVectorSerializers()`. |
| `network.ts` / `gameNetwork.ts` | (networked) command enum + the single `applyNetwork` call. |

## 3. Entries

```ts
// src/client/entry.ts
const mainPipeline = new Pipeline(em, inputSystem, simulationPipeline, renderPipeline, vuePipeline);
mainPipeline.init();
let last = performance.now();
function frame(t: number) {
    mainPipeline.tick(t - last); last = t;
    em.tick();                      // once, last
    requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
// handle visibilitychange: reset the clock so a backgrounded tab doesn't produce a giant delta
```

Server entry (networked): `createServer({port}, network)`, `actions.registerServerHandlers()`, a `Pipeline(em, newClientSystem, syncSystem, simulationPipeline)`, ticked via `setImmediate` recursion + `em.tick()`.

Bootstrap world/scene state as singleton entities in the entry (`em.quickEntity({ sceneName, ... }, 'sceneName')`).

## 4. Plugin menu — take what the game needs

| Need | Use |
|---|---|
| Input (kb/mouse/touch/gamepad, binds) | `applyInputPlugin` + `upsertInputBinds` + `createInputBindHandlers` |
| Component tweening | `applyTweenPlugin` |
| Per-entity FSM | `applyStateMachinePlugin` |
| Timed removal / apply-components-on-death | `applyDeathEffectPlugin` |
| Static game data by reference | `gameDataPlugin` + `Pointer` types |
| Vue UI | `applyVuePlugin` via a bridge module (vue-bridge.md) |
| Component→DOM lifecycle | `createUISystem`; 3D-anchored HTML: `createZUISystem` |
| Debug pane / FPS graph | `applyEditorUIPlugin` (keep bindings out of gameplay systems) |
| three.js render pipeline | `rendererPlugin` (render passes as entities) or hand-rolled composer for small projects |
| Blender content | `shaderTreePlugin` + `materialManagerPlugin` (+ `logicTreePlugin`); blender-authoring.md |
| Multiplayer / client-server | networking.md — do the layout split FIRST |
| Particles | `effekseerPlugin` (needs effekseer wasm in `/assets`) |
| PWA install | `promptInstall` |

`loaderPlugin` is empty — load GLTF/textures manually with a shared `LoadingManager`.

## 5. Day-one decisions that are expensive to retrofit

1. **Networked or not.** If plausibly yes: `game/`/`client/`/`server/` split, `IS_CLIENT`/`IS_NETWORKED` flags, actions as `RPCActions`, and `socket`-safe serialization from the start — even if you only ship offline sandbox mode initially (cursory-world's `simulationPipeline.condition` makes both modes cheap).
2. **Actions layer.** All mutations behind `actions.ts` from the first feature; retrofitting authority/undo/validation later touches everything.
3. **Heartbeats** for any fleet of passive browser clients (displays/kiosks): app-level Ping/Pong + reconnect from day one.
4. **Persisted-vs-ephemeral component discipline** if saving: maintain the exclusion sets (save/history/wire) alongside `components.ts`, and add every new ephemeral key to them in the same commit.
5. **Blender naming conventions**: pick and document the feature vocabulary + prefab id scheme before content accumulates; add load-time validation.
