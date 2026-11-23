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
20. **`MessageData` rejected `boolean`** — ✅ FIXED (htrab, 2026-10-08). `plugins/network/networkPlugin.ts` typed wire payloads as `string | Uint8Array | number | (string|number|null)[] | bigint`, so an RPC with a boolean argument (e.g. `setStreaming(true)`) threw at encode time: `Validation error: v.1(type): Cannot convert true to string` — deepkit fell through the union to the `string` branch. Every project with a `@RPC(cmd) setFlag(bool)` method was silently broken. Fix: added `boolean` to the scalar union and to the array element union (`(string|number|boolean|null)[]`), and updated `networking.md`. BSON already carries booleans natively, so no codec change was needed. **Footgun:** the wire union is hand-maintained — add a primitive to BOTH the scalar and the array element type, or encode fails at runtime.

## Gaps found by wroth (2026-11-20 survey)

First project that is a **3D, rigged, third-person, multi-instance** game; these five gaps
did not surface in any 2D/sprite/static-prefab project.

20. **Skeletal-animation runtime is missing, but the exporter half exists.** The Blender addon
already writes every action to scene custom properties and stamps per-object
`animation = {action_name, action_slot}` (`blender/addon/animation_clips.py`, called from
`__init__.py:310`), yet nothing in TypeScript reads GLB animation clips — no clip
component, no `AnimationMixer` owner, no fade/loop/blend control, no root-motion policy.
`blender.md` lists Animation as *planned*. Any project with a rigged character hits this
wall first. The extraction shape: a component carrying `{clip, speed, loop, fade}` plus a
system owning one `AnimationMixer` per skinned object, reacting to component writes (never
called from gameplay code), and clip events surfaced as signal entities so gameplay stays
data-only.
21. **No 3D kinematic character controller.** `boilerplate/system/velocitySystem.ts` is
`position.add(velocity)`; there is no capsule sweep, step-up, slope/floor snap, or ground
probe anywhere in the engine. `three-mesh-bvh` is already a direct dependency (the raw
material for world collision), and `@dimforge/rapier3d-compat` is present transitively but
unused — so the choice is hand-rolled BVH sweeps vs adopting rapier's
`KinematicCharacterController`, and it should be a plugin either way, not per-project.
22. **No instance / match registry.** `createServer` is one process, one WS port, one ECS
world. Every multi-arena deployment re-invents "which world am I, who is in it, how does a
client get routed here". Wanted: a thin match-directory abstraction (register/heartbeat/
assign) that is transport-agnostic, so a Valkey/ElastiCache directory and a spawnless
single-process dev mode are the same interface. Do NOT let it grow into entity-state
storage — snapshots-per-tick in a KV store is a non-starter.
23. **Percentile modifier stack** (recurring across projects: shadow-boxer damage mods,
lanebreak stat merges, laok `combineCalculatedStats`). The ubiquitous shape is
`base -> beneficial[] + detrimental[] -> clamp`, integer-scaled to keep float drift out of
netcode, with hard overrides (`preventMove`/`preventTurn`-style) evaluated last. Worth one
implementation next to `calculatedComponents`, because every networked game eventually
needs buffs that round-trip.
24. **No particle runtime — and Effekseer is the wrong shape for us.** ✅ P1 BUILT
    (`plugins/particles/`): instanced-quad pools, analytic motion, curve atlas, entity-free
    arena playback, `rParticleFx`/`rParticleBudget`/`particleSignal`, two demo assets. Remaining:
    trails/ribbons verified in anger, sorting for alpha blend, soft depth, tier-B ping-pong,
    bone binding (blocked on #20), and the Ryzom `.ps` converter (P2). `effekseerPlugin`
needs `.efk` binaries + a WASM blob + its own renderer/context, and still leaves the real
cost (authoring effects by hand) untouched. Design for a native GPU-first replacement:
instanced quads over shared pools, stateless analytic simulation (zero per-frame upload),
trails by evaluating the same path at `t - k·Δ`, and a pose-history texture so attached
emitters stay correct without particle state. The asset schema and runtime are
**producer-neutral** (a Ryzom `.ps` converter is one input, not a dependency), playback is
**entity-free** (arena records, not entities — an entity is a uuid string, a Proxy per
component and a full registered-query sweep on registration) and the hot path is designed for **zero JS allocation per
frame**. Full design, corpus evidence and the NeL conversion plan: **`particles.md`**. Build
order matters — the runtime skeleton plus one hand-authored effect should land before any
NeL decoding work.

25. **One particle playback per entity, and no per-playback lifetime** — ✅ **FIXED** (wroth E1, 2026-11-21: `rParticleFx.playbacks[]`, per-playback `seconds`, `playbacks.ts`). Kept for the reasoning and the shape it settled on.
    `rParticleFx` is a **single component**, and `particles.play` starts by replacing it
    (`plugins/particles/index.ts:392-403`), so an entity can show exactly one effect at a time.
    That is fine for a projectile or a hit spark and wrong for anything layered: a caster that
    channels a glow while a weapon trail sweeps, a character with a persistent aura *and* a hit
    burst, a shield bubble plus its own impact flash. Wroth works around it by sequencing one asset
    per beat (channel → release → hit) and by composing multi-layer *assets* (the compiler already
    supports up to 4 layers per asset), which is the right authoring answer but not a substitute for
    two independently-lifetimed effects.
    Wanted shape: `rParticleFx` becomes an **array of playbacks** (`[{asset, startedAt, seconds, bone,
    tint, loop}]`, capped at 4 like layers), `play` appends and returns a handle/id, `stop(entity,
    handle?)` removes one or all, and the arena keys its runs by `(entity, handle)` instead of
    `entity`. Second half: an authored **lifetime in seconds** per playback (`seconds`), so a held
    state (a 31 s loop) can be started for a 0.6 s window without the project re-implementing an
    expiry ledger — wroth keeps its own map for exactly this today
    (`src/client/system/particleAbilityFxSystem.ts`), and that map is the thing that should not exist.
    Do not grow this into a general VFX graph; the budget/zero-allocation contract must survive.

26. **Particle playback takes no per-instance parameters, and `tint` is not applied.** ⚠️
    **PARTIALLY FIXED** (wroth W44, 2026-11-22: `ParticlePlayback.offset` and `.scale` on
    `plugins/particles/playbacks.ts`; the four-float `userParam` system is still absent). Kept for
    the reasoning and for the half that is still missing. What was built: `scale` — Ryzom's
    `CAnimationFXSheet::ScaleFX` — as a per-instance `aScale` attribute the vertex shader multiplies
    into `sizeX`/`sizeY` (never a per-particle CPU loop, and never a per-material uniform, because a
    pool is shared by every playback of a draw identity), plus the asset's node offsets scaled once
    per emitter in the spawn matrix; and `offset` — Ryzom's `CFXStickMode` + `StickOffset`
    (`attached_fx.cpp:154-168`) — folded into `anchor * T(offset)`, i.e. one extra 4×4 multiply per
    bound node per frame on the pose path and nothing per particle, with both endpoints of a
    travelling playback displaced as one. Both are absent = the old behaviour exactly, documented in
    `particles.md` §6.4 and proved by `scratchpad/w44-fx-placement-sanity.mjs`. **Still missing:**
    `ParticlePlayback.params?: readonly number[4]` (the four `userParam` floats Ryzom's power tiers
    drive, and Fury's `property1..5Value` per track), the importers that would bind a param to a
    float maker or property slot. The `tint` half is now **done** (wroth E1/issue 001,
    2026-11-22): `tint` is a per-instance `aTint` vec3 attribute, default (1,1,1), multiplied into
    `colour.rgb` in `shaders.ts` before the kind branches — per instance rather than per material for
    the same reason `aScale` is, so one pool serves differently tinted playbacks in one frame, and
    `ParticleArena.setTint` can re-tint a **live** playback without restarting it. Wroth's
    `ParticlePlayback` has no parameter array at all. Two unrelated corpora ask for
    exactly that: Ryzom instances every cast and impact `.ps` once per **power tier** (5 tiers, 4
    `userParam` floats progressively switched on — `CCharacterCL::playCastFX`, `CCharacterCL::impact()`),
    and Fury's per-ability track table carries `property1..5Value` **per track on every row**
    (`VFX_AbilityTracks.bin`, 3,230 rows in wroth's `content/fury/derived/ability-tracks.json`). So
    an effect's look is a *runtime argument* in both sources and a compile-time constant here.
    Wanted shape for the rest: `ParticlePlayback.params?: readonly number[4]`, with the `.ps`/track
    importers binding a param to whichever float maker or property slot the source used. Keep it
    declarative: params feed named emitters, not a scripting hook.

    **Standing rule this exposed** (wroth E1): the `InstanceScratch` packing in `pools.ts` and the
    attribute read order in `shaders.ts` are a contract with no type between them. A vec4 that packed
    `[sizeX, alpha, colour, unused]` while the shader read `y` as `sizeY` compiled fine, ran, and
    silently distorted every effect while killing the alpha channel — the bug survived long enough to
    be found by audit, not by the build. Any change to either side must change both, and a sanity
    check should assert a curve authored on one axis stays on that axis. Current order:
    `x = sizeX, y = sizeY, z = colour, w = alpha`.
27. **No animation notify / contact events.** Fury's hit-location model is a table keyed by
    animation: `VFX_AnimationContacts` (217 rows: `weaponTypeCode × animationName → frame,
    contactHeightCode, contactArcCode, contactStrengthCode, strikeDirectionCode`), i.e. gameplay
    reads **a frame of a clip**. Our animation runtime exposes clip changes and a countdown, never a
    per-frame notify, so gameplay approximates from the clock instead. Gap #20 already names the
    extraction shape ("clip events surfaced as signal entities"); this is the concrete consumer that
    justifies it — contact-frame FX, hit windows, and the footstep/landing events the Ryzom export
    manifest already carries (`content/ryzom-derived/homin/animation-manifest.json`).
28. **A playback cannot travel.** ✅ **FIXED** (wroth W43, 2026-11-22: `ParticlePlayback.travel` on
    `plugins/particles/playbacks.ts`, evaluated per particle in the arena's spawn table; the flight
    time is `distance / MAGICFX::PROJECTILE_SPEED` = 20 m/s). Kept for the reasoning and the shape it
    settled on. What was built, and why in that place: the origin of the asset's nodes interpolates
    `from → to` over `seconds` **as a function of each particle's birth time**, so a stream leaves a
    trail instead of a cloud sliding (`travelProgress`, `arena.writeLayer`); the interpolation is
    spent once, in the spawn-table write that already bakes every other analytic term, so a moving
    playback costs **nothing** per frame — the pose ring's "sample the emitter at birth" trick, made
    exact instead of 30 Hz-quantised, and without a second per-instance channel. `travel` absent is
    exactly the old behaviour; past `seconds` the origin holds at `to`; a travelling playback
    supersedes the bone binding, since the line is the origin. Not built, and named in `particles.md`
    §6.3: rotating the emitter onto the line, Ryzom's `Bomb` parabola, and `Chain`/`Spray`
    (`MAGICFX::TSpellMode`, `magic_fx.h:29-35`).

    The gap as first recorded: a projectile's visual is one effect whose node moves from the
    launch point to the target over `distance / speed`, and the arena's analytic path has no
    translate-over-time input — so wroth plays release-on-caster and impact-on-target and nothing
    crosses the gap (documented as a content gap in `content/particles/ability-fx.md` when it is in
    fact an engine shape). Wanted: `travel?: { from: Vec3; to: Vec3; seconds: number }` on a
    playback, evaluated in the same analytic pass as the rest of the motion, so a missile is still
    one arena run and zero per-frame JS.
29. **Particle collision / zone fields are decoded and ignored.** NeL's `.ps` graph carries kill and
    containment volumes — `CPSZonePlane/Sphere/Cylinder/Rectangle` with a `CPSAttrib` normal, radius,
    basis and dimensions, owned by a force located and targeting an emitter's located. The converter
    reads them (`tools/ryzom/ps_decode.py`, repaired in wroth W42) and the runtime evaluates none of
    them, so a closed-form motion integrates gravity for the particle's whole life. wroth's first
    asset to hit this is `ryzom.ability.resist`, whose ground plane stops a 10 m/s² fall at 2 s: the
    baked envelope reads *travel 11.48 m* where the source's particles drop ~1 m, so the asset is
    marked environment-scale on a measurement the engine made wrong (`content/particles/ability-fx.md`
    §"The bake, and its one threshold failure"). Shape: a per-layer convex/plane kill test in the
    analytic pass (a particle that crosses a plane dies or bounces, decided per zone class), still
    zero per-frame JS and no per-particle state — the zones are the same kind of closed form as
    gravity. Until then every Ryzom effect with a ground plane over-reports its reach.

    **✅ PLANE HALF BUILT** (wroth E3/issue 014, 2026-11-22). `ParticleAssetLayer.killBelowY?` is a
    per-layer height in the node's frame; `assets.compileLayer` defaults it to `+Infinity` (absent =
    no behaviour change) and — this is the part that bit once already — includes the **value** in
    `poolKey` (`|ky:${killBelowY}`), the way `|z:${zBias}` does, because a key that encodes presence
    instead of value is the pre-001 pool-collision bug. `arena.writeInstance` transforms the plane by
    the node matrix per spawned instance (`nodeMatrix · (0, killBelowY, 0)`) into a per-instance
    `aFloor` vec3-less float attribute, and `shaders.ts` clips by the **evaluated vertex world Y**
    below it — so a large sprite straddling the plane is cut, not vanished whole. Still open from the
    recorded shape: sphere/cylinder/rectangle containment and the per-zone bounce decision; only the
    plane kill is evaluated today. Per-layer `frameRate?` landed alongside it and drives Ryzom
    `CTextureGrouped` flipbook sheets (`uSpriteFps` advances the cell inside the analytic pass), which
    is the same shape as `aScale`: per-layer value, one uniform per pool, zero per-particle state.

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

17. **2D polygon kit (offsetting + ring-set sweep)** (embroidraw, 2026-07) — project-side
    geometry worth promoting if a second project needs it: `offsetPath` (mitred joins with a
    mitre clip, plus inverted-vertex culling so a rail never folds back on a tight curve),
    `scanlineSegmentsRings` (one even-odd sweep across an outer boundary plus holes), and
    `pointInRings`. All pure, no deps, ~200 lines. The culling step is the non-obvious part:
    it keeps output 1:1 with the input array, which is what lets two offset rails be zipped
    into satin bars without index bookkeeping. Donor: `src/game/embroidery/geometry.ts`.

## Documentation debt (beyond these docs)

- Per-project `CLAUDE.md`s exist only on test-pilots; each active branch should get a thin one (@-importing the engine CLAUDE.md + project vocabulary).
- `generate-docs.ts` covers a subset of plugins; extend to network/renderer/vue plugins so `plugins.md` stops under-representing the surface.
