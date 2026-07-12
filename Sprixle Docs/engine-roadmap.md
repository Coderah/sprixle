# Engine Roadmap — gaps & extraction candidates

Mined from the game projects (2026-07 survey of test-pilots, cursory-world, sobelow, shadow-boxer, lanebreak-tactics, laok). Check here before hand-rolling; update when a gap is felt or an item ships. Complements `todo.md` (threading, pooling, renderer plans).

## Engine gaps (felt repeatedly in projects)

1. **Multi-query consumer (`anyUpdated` / `anyNewOrUpdated`)** — run one system when any of several queries change, without N consumers + manual dirty flags. Requested in laok's code comments; the dirty-flag+flush workaround is everywhere.
2. **Network: multiple receivers per command** — `networkPlugin` allows one resolver per command (silent-ish override, `// TODO refactor to handle multiple receivers`).
3. **Network: first-class broadcast** — `send` with no target loops all socket entities per call; several `// TODO can probably just use broadcast` sites.
4. **Entity projection / subtree sync helper** — "sync this entity subtree to these sockets, with authoritative delete-missing merge on the client." test-pilots hand-walks this at ~50 call sites; the single biggest networking boilerplate tax.
5. **Reconciliation `'replay'` strategy** — unimplemented; `'basic'` uses one global version counter (`// TODO maybe per component versions`) and is tightly coupled to `stagedUpdates`/`previousComponents` timing.
6. **Device/peer presence model** — multi-socket-per-identity + half-open zombies forced test-pilots to invent `liveSocketsForDevice`-style fan-out; belongs next to `getClientEntity`.
7. **vuePlugin shallowRef re-fire hack** — `ref.value = undefined; ref.value = x` to force listeners on identical values (multiple `// TODO find a better way` sites).
8. **`loaderPlugin` is an empty file** — either implement (GLTF + LoadingManager + progress entities) or delete to stop misleading readers.
9. **`boilerplate/` refresh** — deprecated Manager args, dead `../input/input` import, manual subTicks instead of `Pipeline`. Should demo: type-only Manager, `quickEntity`, consumer systems, `Pipeline`, an input bind, and point at the docs.
10. **networkPlugin named-export mismatch** — `createClient`/`createServer` import `applyNetwork` as a named import; it's default-only (works in type position only). Add a named export or fix the imports.
11. **Timing API leakage** — shadow-boxer-era note ("now management is bleeding outside of sprixle") partially addressed by pipeline internal time; verify and document the intended `now()` surface.
12. **`ecs/object.extensions.ts` defects** (verified 2026-07) — `Map.prototype.first`, `Map.prototype.last`, and `Set.prototype.last` index into an iterator (`this.values()[n]`) and always return `undefined`; `Set.prototype.union` unconditionally overwrites the native ES2025 `Set.prototype.union` (native shipped 2024+ in browsers/Node; semantics differ — native rejects non-Set-likes); all extensions are assigned enumerably rather than via `Object.defineProperty`; `eachIntersect`/`eachSub` accept a boolean-returning fn whose return value is silently ignored (forEach). Fix the broken three, guard/rename around native collisions (`intersect`/`subtract` deliberately avoid native names; `union` doesn't), and consider non-enumerable definition.
13. **No engine change-log / upgrade discipline** — every project pins a submodule commit; nothing records breaking changes between pins, so modernizing an old branch (which is also the only way it receives these docs) means diffing the engine blind. A `CHANGELOG.md` (or breaking-notes section per significant commit) is the cheapest fix, and matters more as project count grows.
14. **Query dedup is dead code** (verified 2026-07) — `Manager.createQuery` intends to return an existing identical query (`if (state.queries.has(query.queryName)) return existing`), but the `Query` constructor runs first and unconditionally appends a uuid to `queryName` when `state.queryStates` already holds it — so the `queries.has` check can never succeed and every identical definition creates a fresh independent query. Either fix the ordering (compute the name and check before constructing) or delete the branch and document that queries are never shared.
15. **Sim-time determinism policy** — sims freely mix wall-clock `now()` into gameplay state (lanebreak's match FSM, timestamps in components). This conflicts with the intended `'replay'` reconciliation strategy, headless/server determinism, and record-replay debugging. Decide and document: gameplay reads pipeline time (`useInternalTime`) only; wall clock stays at the edges.

16. **Deepkit serializer silently corrupted an interface array in ONE project's webpack build — root cause unconfirmed** (orrery, 2026-07) — `em.createSerializer<T>()` where `T` reached an imported interface array (`PhraseNote[]`) through `Partial<ComponentTypes>` round-tripped FINE under ts-node but in orrery's webpack/ts-loader build silently encoded array elements as nothing — decode returned `[undefined × n]`, no error. **Do NOT read this as "deepkit breaks under webpack"** — other projects serialize very complex component structures through webpack builds without issue, so the trigger is likely something orrery-specific (candidates: ambient `declare module` shims for untyped ESM deps in the same import graph, the components-interface shape, import order). Worth a proper diagnosis if it recurs elsewhere. Orrery's workaround: disk format uses raw `bson` serialize/deserialize (plain-data saves need no reflection — see its `encoders.ts` disk section); fine as a project-local pattern, not an engine rule.

17. **InputPlugin: custom input sources** — ✅ BUILT (orrery, 2026-07): `injectInput(
    name, state, value?)` + `pulseInput(name, value?)` (momentary, auto-released via
    the *Move mechanism; `inputMomentary` component), `Input` type widened for
    project-defined names, `resolveInputMode` option for activeInputMode
    classification. Encoder deltas resolved as up/down pulses whose magnitude rides
    `inputPosition` (quietSet, like gamepad axes) — see game-patterns.md Input for
    the pattern + the stale-magnitude caveat. Remaining niceties: a dedicated value
    activation type for continuous/absolute controls (faders, analog sticks), and
    extraction candidate #8's bind-hint UI now renders custom binds for free.

18. **Module-scope DOM access in plugins breaks headless node imports** — ✅ FIXED (loq, 2026-07-10, verified by loading the full em+game chain under `ts-node --transpile-only`): `plugins/nodeTrees/shader/uniforms.ts` (`window.innerWidth` at module scope → `globalThis.innerWidth ?? 1`), `plugins/nodeTrees/shader/colorRamp.ts` (module-scope `document.createElement('canvas')` → lazy `getLUTContext()`), `plugins/three/rendererPlugin.ts` (defaults `window.*` → `globalThis.*`, and the `OutputPass` import needs the explicit `.js` subpath — node's exports-map resolution rejects the extensionless form webpack tolerates; node 22.12+ `require(esm)` then loads it). Context: any node process whose import chain reached these died with `ReferenceError: window is not defined`; in loq that blocked importing the entity manager headlessly (em → game components.ts → a **value** import of `RendererPluginComponents` → renderer/shader chain) and was misdiagnosed for a whole build phase as "deepkit can't load under ts-node" — a duplicate inline-mirror generation pipeline got built on that false premise. Deepkit reflection was NEVER the problem (patched typescript + `reflection: true` works fine under `ts-node --transpile-only`; tsx/esbuild can never emit reflection). Standing rule: no module-scope DOM in plugins — headless node must be able to *import* the type surface; throwing on headless *use* of a render feature is fine.
19. **Deepkit reflection quirks around imported/derived component types** (loq, 2026-07-10, both verified) — (a) **SCAR: never convert `ComponentTypes` member imports to `import type`.** A type-only import stays erased at runtime, and deepkit then silently resolves the imported type to `any` — no crash, no warning; the Manager loses that plugin's component names AND annotations invisibly (verified: `typeOf` probe reports the member as `any`, module absent from require.cache). Value imports are load-bearing for reflection. (b) Some members are dropped from Manager reflection in ALL compile modes (verified identical under transpile-only and full type-checking, so webpack builds match): in loq's `RendererPluginComponents`, `rSize` (Vector2), `rLayers` (Layers), `rPassTextureUniform` (Uniform<…>), and all mapped-type members (`` `r${Capitalize<K>}` `` over a `Pick<WebGLRenderer,…>`). Currently harmless — `componentTypesSet`/`componentNames` have no engine consumers and the dropped members carry no annotations — but a trap: an annotation (`SingletonComponent`/`Nested`/`TrackPrevious`) on such a member would silently not register. Worth a proper diagnosis (relates to gap #16's unconfirmed serializer corruption).

## Plugin extraction candidates (source: project code)

Ranked by leverage. Each names the donor implementation.

1. **Matter-physics plugin** (shadow-boxer `physicsSystem.ts`) — engine setup, body↔entity lifecycle (`body.label = entity.id`), ECS↔matter position sync, and the **collision-as-ephemeral-entity bridge** (`'collision'+a+b` ids, `isColliding(a,b)`). Game-specific clamps become config hooks. Companion recipe: live body resize via `Body.setVertices`.
2. **Signal plugin** (shadow-boxer sfx/music/collision; lanebreak damage signals) — `createSignal(components, ttl?)`: one-shot entities with a guaranteed death path (deadAt/DeathEffect integration). Fixes a real shipped leak class.
3. **Audio plugin** (shadow-boxer `sfxSystem`/`musicSystem`) — buffer cache, filename-suffix **variant selection**, layered music **crossfade** (two-node ramp, resume-from-offset), autoplay-resume handling, LoadingManager integration. Game mapping stays a resolver callback.
4. **Grid pattern matcher** (laok `patterns.ts` + `dataUtils.ts`) — `PatternDefinition`/`findAllPatterns` (exclusive & overlapping modes), query→2D-grid adapter, and the stat-merge algebra (`combineCalculatedStats`). One engine served crafting recipes and loadout synergies.
5. **Reflection/depth toolkit promotion** (sobelow) — `reflectorCamera` is already engine; add sobelow's `maybeAddDepthMapToShader` (shared depth texture + `depthDiff` GLSL) and `applyShaderCompile` chaining as engine `render/`/`shader/` utilities.
6. **Hitstop & time-dilation helpers** (shadow-boxer) — `hitstop(ms)` + tweened `timeScale` feeding `pipeline.getTimeScale`; tiny, universally wanted.
7. **Input buffer** (shadow-boxer `inputBufferSystem`) — generic `{bufferedInput, time}` retry-within-window; fold into InputPlugin or stateMachinePlugin.
8. **Input-binding hint UI** (shadow-boxer `ui.ts getBindingIndicator` + `.input-bindings-overlay` scss) — renders live key/button hints for named input binds by reading the actual bind entities (`inputBindName` → `inputBinds`), so hints reflect real bindings, not hardcoded labels. Indicator families: `DPad`/`FaceButtons`/`ArrowKeys` (4-cell diamond with per-direction highlight, multiple binds can highlight one widget), `TriggerButton`, `KeyboardKey`/`GamepadButton` (label chips derived from input names, `KeyA`→"A"). Icons are pure CSS/unicode — no glyph assets. Lift shape: split the **model** from the **presenter**. (a) A framework-agnostic helper next to InputPlugin: `getBindingIndicatorModel(em, bindNames) → {family, cells:[{highlight,label}]}[]`, auto-detecting the family from the bind's inputs (the original has a TODO for exactly this) and using an indexed query instead of its linear `getEntities().find()` scan. (b) A Vue component (`<InputBindingHint bind="jump"/>`) on top, using the vuePlugin composables so it reacts to rebinds and to the engine's `activeInputMode` singleton (show keyboard vs gamepad variant — shadow-boxer's overlay renders both, statically, once at startup; the original never re-renders on rebind). Ship the scss with it. `activeInputMode`/`inputActiveModeSystem` were already absorbed into InputPlugin — this completes that extraction. Adjacent candidate in the same file: `moveUIFocus`/`ensureUIFocus` gamepad-driven focus traversal over `[tabindex]` elements (menu navigation without a mouse).
9. **Scene manager** (shadow-boxer/sobelow/lanebreak convergently) — `sceneName` singleton + pipeline gating + enter/exit consumer hooks + tagged scene-object cleanup (`isSceneObject` sweep with mesh/material disposal).
10. **Ortho camera fit** (shadow-boxer `cameraBounds.ts`) — fit an OrthographicCamera to a fixed design box on resize; zero coupling, drop-in.
11. **calculatedComponents recompute helper** (laok) — formalize the base/derived overlay: declare derived keys + a recompute fn; engine wires the consumers and the `?? components` read path.
12. **InputPlugin touch guard is a latent always-true bug** (birbdex, 2026-07) — `handleTouchStart`/`handleTouchEnd` gate their `preventDefault`+`stopPropagation`+`stopImmediatePropagation` on `event.currentTarget === domElement`, but `currentTarget` in a bubble listener is ALWAYS the bound element, so it fires for every touch on the page and swallows overlaid-UI taps/scroll on device (see vue-bridge.md SCAR). Interim fix shipped: added `allowOtherTouchEvents` opt-out (default off, no regression). **Proper fix:** gate on `event.target === domElement` (only hijack gestures that land on the surface itself, not those bubbling from overlaid UI) and/or bind `domElement` to the actual play surface instead of `document.body`. Not changed by default because canvas games binding to `body` with a child `<canvas>` would then stop swallowing gestures — decide per the engine owner.

13. **PWA install plugin** (birbdex, 2026-07-10) — **DONE, in engine.** `promptInstall.ts`
    gained `applyPromptInstallPlugin(manager)`: pure `isStandalone()` (checks `display-mode`
    **and** iOS `navigator.standalone`) + `detectPlatform()` (iPadOS via `maxTouchPoints`), an
    `installStatus` singleton component (`standalone`/`platform`/`canPrompt`/`dismissed`), and a
    system that captures the Android `beforeinstallprompt` **into a closure** (the old function
    discarded it into a local — dead code) plus `appinstalled`, publishing state. `install()`
    fires the native prompt (no-op iOS); `dismissInstall()` persists to localStorage. Renders
    nothing — the project supplies the Vue surface. Old imperative `promptInstall()` kept
    `@deprecated`. Pattern: **detection + capture in the plugin, presentation in the project.**
14. **Web Push plugin** (birbdex `birbdex-editions-push.md` EP5, future) — a real engine gap: no
    push/notification surface exists. Needs a **service worker** (none in engine yet — pairs with
    a local-persistence/offline plugin, item below), VAPID handling, a subscription lifecycle
    keyed to an app-defined account id, and `push`/`notificationclick` handlers that open a
    deep link. **iOS constraint:** delivery only to installed (home-screen) PWAs. Blocked on a
    backend in the donor project (Path B), so extract when the first project actually ships it.
15. **Local per-user persistence (ECS ↔ IndexedDB)** (birbdex SP3 — **prototyped project-side
    2026-07-10, extraction candidate**) — a `persisted`-tag query snapshotted to IndexedDB on
    debounced change (system reacts to add/remove) and rehydrated on `init`. birbdex chose a
    **JSON projection over `em.createSerializer`/BSON** deliberately — its server backup is JSON
    (`dex/<key>.json`), so one shape backs both local storage and the sync upload; a general
    engine plugin should support *both* codecs (BSON for networked snapshots, JSON for
    server-JSON alignment) behind one `applyPersistencePlugin(manager, { key, codec, tag })`.
    Donor: `src/client/idb.ts` + `system/persistenceSystem.ts`.
16. **Offline write outbox** (birbdex SV10, candidate) — an offline-first write queue: an entity
    per pending server op (persisted alongside #15), a drain system that delivers when
    `navigator.onLine` with **2xx=done / 409=terminal / 5xx=retry-with-ceiling** semantics and
    `(op, key)` dedupe. Pairs with any local-first + eventual-server project. Donor:
    `src/client/system/outboxSystem.ts`. Keep the local mutation immediate; the outbox only
    carries the *server reconciliation*, never gates the local reward.

## Documentation debt (beyond these docs)

- Per-project `CLAUDE.md`s exist only on test-pilots; each active branch should get a thin one (@-importing the engine CLAUDE.md + project vocabulary).
- `generate-docs.ts` covers a subset of plugins; extend to network/renderer/vue plugins so `plugins.md` stops under-representing the surface.
