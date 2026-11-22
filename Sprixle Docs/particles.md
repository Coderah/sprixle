# Particles — GPU-first particle plugin (design)

*Engine ref: working tree @ 2026-11-21 (W-E1: multi-playback `rParticleFx`, per-playback `seconds`,
per-playback `bone` override — W32; then `softDepth` option + `setTimeScale`, W-E2)*

Status: **P1 landed** (runtime + demo effect, `src/sprixle/plugins/particles/`), P2+ design only.
This doc replaces the Effekseer plan (`effekseerPlugin` stays in
tree but is not the direction). The runtime is **engine-generic**: it knows nothing about Ryzom,
NeL, or `.ps`. Ryzom's library is one *producer* into a neutral asset schema — see §7.3. The
numbers in §2 come from that library because it is the first real corpus we have, and it is a
useful stress test: 770 effects authored by people who did not have our runtime in mind.

Authority for the counts: `ryzomcore_graphics-rev5.7z` (CC BY-SA 3.0) and the NeL source it was
authored against (`ryzom/ryzomcore@core4`, `nel/src/3d/ps_*.cpp`).

---

## 1. Decision summary

| Question | Decision |
|---|---|
| Primitive | **Instanced quads**, one shared 4-vertex quad per pool. No `gl_PointSize`. |
| Simulation | **Tier A: stateless analytic** (default, zero per-frame upload). **Tier B: RGBA32F ping-pong** for path-dependent forces. Tier C (CPU sim) is not built unless one effect demands it. |
| Draw calls | One per `(kind × blendMode × atlasPage)` visible — **not** per effect. |
| Trails | Free in tier A: evaluate the *same* analytic path at `t − k·Δ`. No history buffers, no state. |
| Bone/attachment | **Pose history ring** (float texture, `node × frame`). Particles fetch the emitting node's matrix *at their own birth time*. |
| Asset format | Neutral `sprixle.particles` JSON (§7). Producers: hand-authored, Blender exporter, Ryzom `.ps` converter, procedural builders. |
| Entity usage | **Zero entities per particle and zero per effect playback.** Playback lives in a plugin-owned arena (§8.1). |
| Steady-state allocation | **0 bytes/frame** in tier A — an acceptance criterion, not an aspiration (§8). |
| Control flow | ECS component writes → reacting systems → one renderer object per pool. No gameplay code touches three.js, no system calls another. |

Why not Effekseer: the asset path (`.efk` binary, WASM blob, its own renderer/context, a second
shader compilation path) is a black box we would still have to feed by *authoring effects by hand*
— which is the actual cost, and the part that does not scale against a reference library. A
runtime we own can be **generated from** such a library instead.

---

## 2. What the Ryzom corpus actually requires (measured)

770 `.ps` files, 3.17 MB total (mean 4.1 KB). Node class census across all files (files containing
the class):

| role | classes | files |
|---|---|---|
| container | `CParticleSystemShape`, `CPSLocated` | 770 / 769 |
| **default particle** | *nameless: billboard quad (class-id, not string — see §9.1)* | ~400 |
| render kinds | `CPSTailDot` 131 · `CPSRibbonLookAt` 127 · `CPSLight` 102 · `CPSMesh` 87 · `CPSDot` 45 · `CPSRibbon` 40 · `CPSShockWave` 14 · `CPSFanLight` 11 | |
| emitters | `Directionnal` 434 · `Omni` 340 · `Conic` 252 · `Rectangle` 216 · `Spherical` 160 · `Radial` 112 | |
| forces | `Gravity` 330 · `Brownian` 283 · `FluidFriction` 258 · `Magnetic` 183 · `Directionnal` 134 · `CentralGravity` 111 · `Spring` 31 · `CylindricVortex` 23 | |
| zones (kill/bounce) | `Plane` 134 · `Rectangle` 20 · `Sphere` 18 · `Cylinder` 4 · `Disc` 2 | |
| attribution (curves) | `FloatBlender` 739 · `ColorGradient` 651 · `FloatMemory` 506 · `ColorBlender` 442 · `FloatBinOp` 418 · `FloatGradient` 390 · `FloatCurve` 260 | |
| orientation | `FaceLookAt` 704 (billboard) · `Face` 164 · `ConstraintMesh` 160 · `RibbonLookAt` 112 · `PlaneBasis*` 258 | |
| misc | `CTextureFile` 737 · `CPSSound` 335 | |

Per-file shape (mean / median / max): locateds **5.2 / 4 / 37**, emitters **3.8 / 3 / 26**,
textures **4.7 / 4 / 36**, forces **2.1 / 2 / 13**, zones **0.3 / 0 / 5**.

Simulation tier split, by whether a file uses a path-dependent force (magnetic, spring, vortex,
central gravity) or a collision zone:

| | all 770 | `sfx/magic` 208 |
|---|---|---|
| analytic-only (tier A sufficient) | **408 (53%)** | 96 (46%) |
| path-dependent force | 257 | 93 |
| uses zones | 173 | 54 |

Atlas math, from the 366 PNGs in `sfx/maps` (64² ×102, 128² ×92, 256² ×42, 512² ×7, plus strips):

- `sfx/magic` references **93 unique sprites, 1.59 MPx** → **38% of one 2048² page**.
- entire corpus references 366 sprites, ~6.5 MPx → **2 pages of 2048²** at ~78% packing.
- every referenced `.tga` resolves to a PNG in `sfx/maps` (1 miss in the whole corpus).

Consequences that drive the design: quads dominate by a wide margin; systems are *shallow*
(few nodes, few emitters) but *texture-rich* (4.7 sprites each); trails are everywhere (171 files);
most dynamics are closed-form integrable. All of it is expressible without a single NeL-specific
concept in the runtime.

---

## 2.5 Two seams added by wroth's studio (W-E2)

* **Soft depth.** `particlePlugin({ softDepth: true, softDistance })` compiles a `SOFT_DEPTH` path into
  the fragment program: it samples `uSceneDepth` (a depth texture the **project** renders — the plugin
  must not own a render pass), converts both depths to view distance and feathers alpha over
  `uSoftDistance` metres. The uniforms are exposed as `particles.softDepthUniforms` for the project to
  write each frame (texture, resolution, near/far). Off by default: a project with no depth pass would
  fade everything out.
* **Clock scale.** `setTimeScale(x)` multiplies the one clock `seconds()` returns — which is also what
  a spawn's `bornAt` reads — so slow motion stays internally consistent instead of desynchronising the
  shader from the spawn table. Particles already in flight are not rescaled; set it while idle.
* **Pose ring: 2D layout, clamped sampling (`W-E3`, and a regression worth remembering).** The ring was
  one tall 1-texel-wide texture of `maxNodes × frames × 4` texels. Raising it to 256 frames for 8.5 s of
  history made that 32,768 texels of *height* — past `MAX_TEXTURE_SIZE` (16,384 on desktop drivers) — so
  the upload was silently rejected, every sample returned zero, and **every bone-bound particle
  collapsed to the world origin**. The ring is now `frames × 4` wide by `maxNodes` tall (1024 × 32 at the
  defaults). Two consequences are now asserted in `scratchpad/particles-sanity.mjs`: the layout fits
  both texture axes, and a written matrix reads back from the frame it was written to.
  Separately, the shader clamps a birth time to the surviving window
  (`birthTime = max(bornAt, uTime − uPoseWindow)`): a particle older than the ring used to sample a
  frame that had already been overwritten — which re-poses it with the *current* bone matrix, so long
  effects appeared to be **parented to the hand**. It now freezes on the oldest surviving pose instead.
  `setPoseLive(true)` is the debug switch that opts into live sampling deliberately.
* **The base quad must be indexed (`W-E4`).** Three ignores the strip draw modes and always draws
  `TRIANGLES`, so the pool's four un-indexed corners rendered **one triangle** — every particle was
  half a quad with a hard diagonal through the sprite. That was the long-reported "clipping": nothing
  to do with depth, and invisible to every depth-side fix. `setIndex([0, 1, 2, 2, 1, 3])` and a
  geometry assertion in `scratchpad/particles-sanity.mjs`. Also: `ParticlePool`/`ParticlePoolRegistry`
  /`ParticleArena` no longer use constructor parameter properties, so headless tests can import them.
* **Pose ring: a repeated frame index must not write the whole ring (`wroth`, the same report again).**
  `PoseTable.write` fills the frames it skipped since the last write, and the fill loop stops when it
  *reaches* `currentFrame`. Two writes inside one `1/hz` bucket have nowhere to advance, so the loop ran
  a full lap and stamped the current pose into **every** historical frame. That is the normal case, not
  an edge case: a display ticks at 60-144 Hz against a 30 Hz ring, and the frame that starts a playback
  writes twice (`arena.primePose`, then the same frame's `updatePoses`). The result is a ring in which
  "pose at birth" and "pose now" are the same matrix — every bone-bound particle rides the bone, and
  `uPoseLive` changes nothing because both branches read the same texel. `write` now restamps the
  bucket's own frame when the index has not advanced. The three sanity cases that hid it all drove the
  ring at exactly one write per bucket; `particles-sanity.mjs` now drives it at 60 fps too.

## 3. Primitive: instanced quads, not points

The engine's existing point-sprite path (`shader/splatShader.ts`: `gl_PointSize`, sprite-sheet
`index`, size attenuation) is the right *math* to keep and the wrong *primitive* to build on:

| | point sprites | instanced quads |
|---|---|---|
| max size | driver cap (`ALIASED_POINT_SIZE_RANGE`; 64–1024 by stack) — close-up quads clip | unbounded |
| non-uniform size (X≠Y) | no | yes |
| per-particle rotation | fragment UV trick only | vertex, proper |
| trails / ribbons / mesh | impossible | same geometry, different VS |
| depth-write / sorted alpha | awkward | normal |

So: **one shared quad** (4 verts, `TRIANGLE_STRIP`), all variation in instance attributes.
Sprite-sheet atlas indexing, additive blending and size attenuation come over from `splatShader`
verbatim.

**Five render kinds** — the union of everything any producer needs, not a 1:1 copy of NeL's eight:

| kind | geometry | produced from (Ryzom, for reference) |
|---|---|---|
| `quad` | 1 instance = 1 quad; `orient` picks billboard / fixed / velocity / mesh-normal | quad, `CPSDot`, `CPSTailDot` head |
| `trail` | `style: 'billboard'` (fading dot chain) or `style: 'strip'` (continuous ribbon); 1 instance = 1 segment | `CPSTailDot`, `CPSRibbon`, `CPSRibbonLookAt` |
| `mesh` | `InstancedMesh` per shape | `CPSMesh` |
| `glow` | additive quad, camera-facing, no texture atlas needed | `CPSLight`, `CPSFanLight` |
| `ring` | ground-plane quad with UV-animated radial falloff | `CPSShockWave` |

Orientation is an attribute (`camera | fixed | velocity | mesh-normal`), not a class — so `CPSDot`,
`CPSQuad`, `CPSFace` and `CPSFaceLookAt` all collapse into `kind: quad` with a different `orient`.

---

## 4. The two mechanisms that make it cheap

### 4.1 Stateless analytic evaluation (tier A)

A particle's entire state is `{p0, v0, tBirth, life, seed, kind, systemId, spriteIdx}` — written
**once**, never re-uploaded. The vertex shader owns the rest. With constant acceleration `a` and
linear drag `k` (`dv/dt = a − k·v`):

```
v(t) = (v0 − a/k)·e^(−kt) + a/k
p(t) = p0 + (a/k)·t + ((v0 − a/k)/k)·(1 − e^(−kt))
```

That covers `gravity`, `directional force` and `drag` in any producer's vocabulary. Noise
turbulence (NeL `BrownianForce`, 283 files; Unreal's `Orbital/Curl` equivalents) is added as a
**displacement field sampled at `(seed, age)`** — a pure function of two numbers, so it accumulates
nothing and is identical at any frame rate. **Landed** as three octaves of 3-channel value noise
(`aNoise`, `noiseOffset` in `plugins/particles/shaders.ts`):

```
p_disp(t) = fade(t)·A·Σ(k = 0..2) 0.5^k·(2·valueNoise(seed·53,97,151 + t·F·(1, 1.31, 1.73)·2.03^k) − 1) / Σ 0.5^k
fade(t)   = smoothstep(0, 0.15, t / life)          // born on the spawn point, then wanders
```

`A` is the amplitude in metres (`dynamics[].value`, the peak per axis) and `F` the base-octave rate
in cycles per second (`frequency` × `speed`). Both are bounded at compile time
(`MAX_NOISE_AMPLITUDE` = 1 m, `MAX_NOISE_FREQUENCY` = 10 Hz base octave, `assets.ts`), with a
warning: past those a particle is being teleported, not perturbed, and a producer that hands us a
**force magnitude** (`CPSBrownianForce` intensity, m/s²) where a length belongs lands exactly there
— so `A` is a displacement on every side of the format, and converting into it is the producer's
job (§9.3). It is *not* a true curl field (no potential, so not
divergence-free) and it does not sample the particle's position — at these sprite sizes the wobble
is the whole read, and both would cost several times the noise itself. Gated behind a `NOISE`
`#define`, so an asset without `dynamics[]` pays nothing.

Trails fall out of the same function: segment `k` is `p(t − k·Δ)` with `Δ = trailLife/segments`
and an alpha ramp. **No ring buffers, no history, no CPU.** A looping effect is just
`t_eff = mod(t + phase, period)` computed from a double-precision JS clock.

### 4.2 Pose history (attachment)

Emitters are bound to animated nodes (bones, props, sockets). Particles must leave the hand *where
it was at birth*, not where it is now. A 16 Hz ring texture of `node → mat3x4` covering `maxLife`
seconds (2 s × 16 × 16 nodes ≈ 768 B/frame) lets the vertex shader fetch the emitting node's matrix
at the particle's own birth time. That is what keeps tier A valid for animated casters and costs one
small `texSubImage2D` per frame.

Sizing: `36 nodes max (measured) × 32 frames × 12 floats` = **55 KB** for a whole fight.

---

## 5. Pool, batching, sorting

- **Pool** = one `InstancedBufferGeometry` per `(kind, blend, atlasPage)`, fixed capacity (e.g.
  8192 instances), integer free-list. A pool is a single `Mesh` in the render scene.
- **An effect instance** owns a contiguous run of slots; spawning an effect = one `bufferSubData` of
  `n × 132 B` (the per-instance layout in §11).
- **No per-frame upload** in tier A. Per frame: uniforms (time, near/far, tint), one pose row, and
  — only for alpha-blend pools — the draw order.
- **Sorting**: `add` and `multiply` need none. `alphaBlend` gets a **counting sort into 256 depth
  buckets** over a preallocated `Uint32Array` of slot ids — O(n), ~0.1 ms at 30k, zero allocation.
- **Culling**: per effect instance against a sphere baked by the producer (NeL ships a precomputed
  bbox; other producers compute from emitter extents × lifetime).
- **LOD**: sample every Nth instance (stride in the draw range) plus clamp sprite screen area. One
  distance ramp, same shape as NeL's `srcStep`, no per-particle branching.

Blend modes: `add`, `multiply`, `alphaBlend`, `alphaTest` — a fragment-shader define, so each pool
picks a specialized program (3–4 per kind, cached at load).

Extras: **soft-particle depth fade** against the existing `DepthPass` target (not in NeL, but hard
intersections read as bugs at 3rd-person distances), per-material z-bias, optional global ambient
tint, and an **overdraw clamp** (sprite pixel-area cap) — the single most effective GPU knob for
additive effects.

---

## 6. ECS surface (thin, and deliberately not per-particle)

Plugin: `src/sprixle/plugins/particles/` (directory, like `plugins/three/`), exporting
`particlePlugin` via `sprixlePlugin(...)` with `rendererPlugin` as a dependency. No DOM, no sockets
(import must survive headless node — roadmap #18).

```ts
export type ParticlePluginComponents = {
    /** play/stop effects on an entity. Appending a playback is the entire gameplay API. */
    rParticleFx: {
        playbacks: ParticlePlayback[];    // oldest first, capped at 6 (MAX_PLAYBACKS_PER_ENTITY)
    } & TrackPrevious;

    /** enemies of fill rate: one place to enforce the frame budget */
    rParticleBudget: { maxPlaybacks?: number; maxInstances?: number; minLodDistance?: number }
        & SingletonComponent;

    /** drained by consumers (audio, screen shake); low-rate, gameplay-relevant only */
    particleSignal: { kind: 'sound' | 'signal' | 'end'; asset: string; name: string };
};

type ParticlePlayback = {
    id: number;                 // handle, unique per entity, allocated by the plugin
    asset: string;              // neutral asset id (resolved through the registry)
    playing: boolean;           // the plugin writes false when the arena retires it
    loop?: boolean;
    seed?: number;              // determinism
    bone?: string;              // overrides every node the asset binds, per playback (§6.2)
    tint?: [number, number, number];   // carried; not applied in the shader yet (§13)
    seconds?: number;           // lifetime; 0/absent = the asset's duration + maxLife
};
```

**`rParticleFx` is a list, not one effect.** A pawn shows several at once, each with its own
lifetime: the cast channel on the hand keeps running while the missile it launched flies and the
impact bursts on the target — one asset each, two entities, one moment. The list is capped at **6 per
entity** and the oldest entry is evicted on overflow; the eviction frees that playback's arena runs,
so the cap also bounds pool consumption. Six because a layered moment already needs three (cast,
missile, impact) and a held aura plus a hit reaction want two more; the cost is six small objects per
entity, allocated at play/stop frequency, never per frame.

```ts
// Sequence on one pawn: channel → release → hit. Three assets, no sequencing on the caller's side
// and no timer of its own.
const channel = particles.play(caster, 'ryzom.ability.fire-cast-glow', { loop: true });
particles.play(caster, 'ryzom.ability.fire-projectile-trail', { seconds: 0.9 });   // flies while the channel burns
particles.play(target, 'ryzom.ability.fire-projectile-impact', { seconds: 0.6 }); // a 31 s held state, 0.6 s window
particles.stop(caster, channel);                    // or let `seconds` retire it
particles.stopWhere(caster, (p) => !!p.loop);       // "close the channels, keep the impact"
```

**The `seconds` rule.** `seconds` is the playback's lifetime, 0/absent meaning the asset's own
`duration + maxLife`. It is the property that lets a game fire a 31 s held state for a 0.6 s gameplay
window without an expiry map of its own — wroth kept exactly that map in
`particleAbilityFxSystem.ts`, and it was a hazard: an expiry keyed by entity could cut a *different*
effect that had since started on the same pawn. A one-shot ends at `min(seconds, its own particles)`;
a looping playback respawns in place every natural cycle until its window closes, so `loop: true` with
`seconds: 0.6` on a 31 s asset is a 0.6 s effect that never respawns.

**Written on play/stop, and on end.** The contract is still "no per-frame traffic": a write happens
when a playback is started, stopped, or retired (natural end, budget eviction) — and the retirement
write is one `playing: false`, which is load-bearing. Without it the entry stays `playing: true`, and a
later component update on that entity would reconcile the unchanged entry as a *start request*: a
self-ended playback would replay forever. `markPlaybackFinished` returns `null` the second time, so the
write happens exactly once per playback.

Systems (ordered pipeline, each unaware of the others):

1. `particleSpawnSystem` — `rParticleFx` newOrUpdated → `planPlaybackChanges` (pure, in
   `playbacks.ts`) → one arena record per start/restart, one stop per ended playback, slot allocation,
   one instance-run write per layer per playback. Emits `particleSignal` for producer-declared events
   (sounds).
2. Pose resolution — runs inside `arena.tick`, not as its own system: one `setNodeResolver` call per
   bound node per playback per frame (the seam the client supplies).
3. Budget enforcement — inside `particleSpawnSystem.tick`: retires the oldest playbacks while
   `rParticleBudget.maxInstances` is exceeded, and retires their component entries too.
4. `particleRenderSystem` — draw order and the shared clock (uploads happen in the arena's writes).

Actions layer (game repo): `playAbilityFx(entity, abilityId)` writes `rParticleFx`. Nothing else.

### 6.1 What `playbacks.ts` decides (and why it is its own file)

The lifecycle rules are pure — no `three`, no ECS, no module state — so
`scratchpad/particles-lifecycle-sanity.mjs` proves them in node. That split is not tidiness:
`arena.ts` cannot be imported by node at all (it imports `three` and uses constructor parameter
properties), so a rule that lives there is a rule no cheap test can reach.

| function | decides |
|---|---|
| `startPlayback` | handle allocation (`max + 1`), the per-entity cap, which entry is evicted |
| `stopPlaybacks` / `stopPlaybacksWhere` | which entries flip to `playing: false` (`null` when nothing changed) |
| `markPlaybackFinished` | the one-shot retirement write; `null` the second time |
| `playbackWindow` / `nextCycleEnd` | `seconds` → `endsAt` and the loop's `deadline` |
| `planPlaybackChanges` | per playback: **start / restart / stop / nothing** |
| `resolvedNodeBone` | which bone a bound node resolves against: the playback's `bone`, else the asset's |

Three rules in there are easy to get wrong, and each is proven by name in the sanity script:

- **Stops come from the arena's live handles, not from the component diff.** `TrackPrevious` stores the
  *reference* it replaced (`ecs/manager.ts`), so two writes in one frame — "close the channel, then
  play the impact" — collapse the intermediate `playing: false`, and a diff-based stop would leak the
  channel's arena record until the entity died. Asking `arena.handlesOf(entity)` what is actually live
  is idempotent, and it also covers the two ends that never touch the component (a budget eviction, a
  natural retirement).
- **Starts use the same answer, and that is not symmetry for its own sake.** The symmetrical case is
  two `play` calls on one pawn in one frame: they reach the reconcile as a single collapsed pair, so
  "the diff has no entry for this handle" is false for the first of them — the channel would be
  silently dropped. "The arena does not hold it" is true for both. The corollary is deliberate: a start
  that *failed* for want of pool capacity retries on the next write to that entity, once-warned, which
  is better than an effect lost to a transient full pool.
- **A finished entry must yield no decision.** No live handle and no start request (`playing: false`)
  means *nothing*, which is what turns the plugin's own `playing: false` write into a no-op instead of a
  replay. That write is also what makes the start rule safe: every arena-side end retires the entry, so
  an ended playback never looks like one that was never started.

### 6.2 `bone` — the per-playback attachment override

`ParticlePlayback.bone` (and the same field on `particles.play`'s options) **overrides the bone of
every node the asset itself binds**. The field was reserved for it from P1 and was inert until W32,
which is why the type said "carried".

The argument is ownership of the decision. A baked asset's node bones are a property of the *art*: the
four Ryzom cast channels (`ryzom.ability.cast-hand-fire/-life/-decay/-water`) bind every node to
`Bip01 R Hand`, because that is where the source `.ps` was authored. Which hand a *gesture* belongs to
is a property of the gameplay that plays it — a healer working with a blade in the main hand channels
off the other one, a full-body eruption is not one palm's gesture. Without the override, expressing
either meant editing the asset (forking four bakes to say "left") or forking the effect id per hand in
the game layer. One field on the instruction is the cheaper and more honest place.

Three rules, all in `arena.ts` via `playbacks.resolvedNodeBone`:

- **Every bound node is re-pointed**, not just the first: a three-node channel moves as a unit.
- **Free nodes stay free.** An override says "these sockets, on this hand"; it does not adopt the
  emitters the artist deliberately left riding the effect transform. (`resolvedNodeBone` returns
  `null` for an unbound node whatever the override says.)
- **An asset that binds nothing ignores it**, and `index.ts` warns once per asset — otherwise a
  mistyped/free-emitter asset looks like a broken hand rather than like a non-hand-bound effect.

Changing `bone` on a live playback is a **restart**, not a silent re-bind: `samePlaybackRequest`
compares it, so an effect that is already spawning particles is never half-moved to the other hand.
`scratchpad/particles-lifecycle-sanity.mjs` §8 proves the override, the free-node rule and the restart.

---

## 7. Generic asset format

### 7.1 Shape

`sprixle.particles` (JSON; an optional packed `.psysbin` later). Nothing in here is
producer-specific — a node graph with emitters, dynamics, colliders and events, plus curves:

```jsonc
{
  "format": "sprixle.particles", "version": 1,
  "id": "spell.fire.missile", "tags": ["spell", "fire"],
  "budget": { "maxParticles": 220, "maxViewDist": 40, "lodRamp": [0.6, 0.2] },
  "render":  { "blend": "add", "softDepth": true, "zBias": -0.01, "sort": "none",
               "atlases": ["spell-a"] },

  "nodes": [                                    // transform graph = attachment points
    { "id": "cast",  "parent": null,   "binding": { "type": "bone", "name": "hand_r" } },
    { "id": "rune",  "parent": null,   "space": "effect", "transform": [/* mat4 */] }
  ],

  "emitters": [                                 // where particles come from, and into which node
    { "at": "cast", "into": "rune", "shape": "directional", "rate": 90, "burst": 0,
      "period": 0.4, "spreadDeg": [10, 20], "speed": [6, 9], "life": [0.6, 1.1],
      "size": [0.25, 0.5], "color": "curve:fire", "sprites": ["ball", "ball_ribbon"],
      "seed": 1337 }
  ],

  "particles": [                                // how the emitted particles are drawn
    { "at": "rune", "kind": "trail", "style": "billboard", "segments": 6,
      "orient": "camera", "curves": { "sizeX": "curve:grow", "sizeY": "curve:grow",
                                      "angle": "curve:spin", "color": "curve:fire" } }
  ],

  "dynamics": [                                 // motion modules; only "noise" is evaluated today
    { "at": "rune", "type": "noise", "value": 0.4, "frequency": 2.0, "speed": 1.0 },
    // gravity / drag are emitter fields (they are per-emitter, not per-node)
    // "magnetic" | "spring" | "vortex" | "attract" force tier B (see §8.3)
  ],
  "colliders": [                                // tier B, opt-in
    { "at": "rune", "shape": "plane", "value": [0, 1, 0], "offset": -0.02,
      "action": "kill" }
  ],

  "events": [ { "at": "rune", "type": "sound", "name": "fire.launch", "atTime": 0.0 } ],

  "curves": { "fire": { "type": "gradient", "stops": [[0, "#ffffff"], [1, "#ff4400"]] },
              "grow": { "type": "keys", "stops": [[0, 0.2], [1, 1.0]] } },

  "meta": { "source": "ryzom:sfx/magic/mag_off_missile_fire.ps",
            "generator": "ps_bake@1", "warnings": [] }
}
```

Curves are baked at load into shared LUT `DataTexture`s (one per channel class: size / colour /
angle) — 128 KB total, sampled in the vertex shader by life ratio.

**Layers.** `particles[]` is a list of draw *layers*, not alternatives: each one owns its draw state
and a playback reserves one instance run per layer that has emitters (capped at `MAX_LAYERS = 4`).
`render` carries the asset-wide draw defaults and a layer may override `texture` / `blend` / `grid` /
`spriteCount`; `emitters[].layer` (default 0) assigns an emitter to a layer. That is what keeps a
two-texture, two-blend effect (additive sparks + alpha-blended smoke) one asset, one playback and one
arena slot instead of two assets that have to be kept in sync. `budget.maxParticles` still covers the
whole playback, so an oversized asset is thinned by one ratio across all its layers.

**Dynamics.** `emitters[].into` names the node the emitted particles *live on* (`at` is only where
they come out), which is the one link from a node to the layers that draw it: `dynamics[].at`
resolves through `into` to those layers at compile time. Omit `at` and the module covers every
layer. One located with several renderers therefore legitimately resolves to several layers (same
particles, several draws — all of them move); a layer fed from two different nodes cannot be scoped
and is reported. A layer carries **one** noise (one instance `vec4`), so several noise modules on it
are summed in amplitude and take the fastest frequency, with a warning. `value` is the peak
displacement in metres (default 0.25, clamped at 1 m with a warning) and `frequency × speed` its
base-octave rate in cycles per second (default 1, clamped at 10 Hz); the field itself is the formula
in §4.1.

### 7.2 Why this is generic

- **No producer vocabulary in the runtime.** `nodes/emitters/particles/dynamics/colliders/events`
  is the same model Unreal Cascade, Unity VFX Graph, Effekseer and Blender's particle systems all
  express; a converter only has to say *which* of these it means.
- **Capability degradation is the producer's job**, declared in `meta.warnings`. The runtime never
  guesses or silently drops: an unsupported `dynamics.type` fails asset validation at load.
- **Tier is derived, not declared by hand**: the loader marks an asset tier B if it has
  `colliders[]` or a `dynamics[]` type outside the analytic set. One rule, no per-asset flag to keep
  in sync.
- **Effect id is a plain string.** Ryzom's `mag_off_missile_fire` is legal, but so is
  `wroth.ability.fire-bolt` or a Blender collection name. Games map ability ids → effect ids
  themselves, in game code, not in the asset.

### 7.3 Producers

| producer | where | state |
|---|---|---|
| hand-authored JSON | any project | works at P1 |
| Ryzom `.ps` → `ps_bake` | `tools/ryzom/` (game repo) | §9, milestone P2 |
| procedural builders (code) | any project | thin wrapper over the same schema, P1 |
| Blender exporter (emitter/animation → JSON) | addon | later; needs the format stable first |
| glTF particle extension | — | watch only; too early |

The Ryzom converter is **one producer among several** and lives outside the engine for exactly that
reason: engine = runtime + schema, game repo = producer tooling that knows about a specific corpus.

---

## 8. Allocation & GC discipline

The stated cost centre is JavaScript garbage collection, so the hot path is designed to allocate
nothing. This is enforceable and testable (DevTools "Heap allocations" over 60 s: flat line).

### 8.1 No entities — anywhere in the particle path

Answering the pooling question directly:

| | entities? | why |
|---|---|---|
| particle | **never** | 30k/effect-playback would be absurd; particles are buffer bytes only |
| effect playback | **no** — arena record | see below |
| gameplay-visible thing with other systems watching (projectile, ground AoE) | yes, and reuse it | it earns ECS visibility |

An entity costs more than it looks: `genId` is `uuid()` — a 36-char string per entity
(`ecs/manager.ts:166`); every component value is Proxy-trapped; `registerEntity` sweeps **every
registered query** (`state.queries.forEach(...) → query.handleEntity`) once per entity; a
*post-registration* component add sweeps them all again (`entities.has(id)` guard at
`manager.ts:806/849`); `deregisterEntity` walks `removeEntityMapping` per component plus the
entity's query map. `quickEntity` is the cheap path (create → set components unregistered → one
registration sweep), so it is O(queries) per entity plus a uuid string and N proxy allocations —
still a steady stream of strings, wrapped component objects and query-set churn at a few hundred
effects/second, which is precisely the GC load we are trying to remove.

So playback state is a **structure-of-arrays arena** owned by the plugin, fixed capacity
(`maxPlaybacks`, a global cap per plugin instance — separate from the 6-per-entity component cap),
free-list of integers, no per-record objects:

```ts
// one flat record set, allocated once
handle     : Int32Array(MAX * LAYERS)  // instance run start, one per layer
entity     : string[]                 // the entity key, for transformOf / the bone resolver
handleId   : Int32Array(MAX)          // the component handle this slot was started from
total      : Int32Array(MAX)          // instances held, so freeing is one subtraction
+ assetIdx : Int16Array(MAX)
+ bornAt   : Float64Array(MAX)
+ endsAt   : Float64Array(MAX)         // this cycle's end
+ deadline : Float64Array(MAX)         // a looping playback's `seconds` window, 0 = unbounded
+ loop     : Uint8Array(MAX)
+ seed     : Int32Array(MAX)
```

Implemented names in `arena.ts`, so a reader can find the field the sketch calls something else:
`runStart`/`runCount`/`poolOf` (the `handle` sketch, one per layer), `assetOf`, `keyOf` (the
composite `entity/key/handle`), `handleOf`, `totalInstances` (the `total` sketch), `startedAt`,
`endsAt`, `deadline`, `loops`, `seeds`, and `entityOf` for `transformOf`/bones.

The ECS sees one `rParticleFx` write at play, one at stop, and one `playing: false` per playback that
ends on its own (natural retirement or budget eviction) — that last one is a decision, not
bookkeeping: a finished entry that still said `playing: true` would reconcile as a start request the
next time anything touched the entity. There is no per-frame write, and `rParticleFx` is the only
component in the tree carrying `TrackPrevious` for this reason.

A slot is keyed by **(entity, handle)**, so one pawn's channel, missile and hit burst are three slots
with three lifetimes; `entityOf[slot]` supplies the entity key that `transformOf` and the bone
resolver receive (a bone belongs to the pawn, not to one of its effects). Games that need to steer a
live effect use the handle from `particles.play`, not a component rewrite.

If a project genuinely wants entities, the engine has **no id recycling** — so pool by keeping
entities alive and toggling a transition component (`isActive`) that the meat of the queries
`includes`, rather than create/destroy. Cheap per entity, and it is the sanctioned
transition-component pattern (`queries-systems.md`).

### 8.2 Hot-path rules (per frame, per particle)

| don't | do |
|---|---|
| `new THREE.Vector3/Matrix4/Quaternion` in loops | module-scope scratch, mutated in place |
| `.map/.filter/[...set]`, spread, array literals | index-based loops over typed arrays |
| `for (const x of mapOrSet)` | integer iteration over own dense arrays; `Set` iteration allocates an iterator |
| `sort((a, b) => ...)` per frame | counting sort into a preallocated `Uint32Array` |
| `arr.subarray(i, n)` per spawn (allocates a view) | `bufferSubData(target, dstByteOffset, src, srcElemOffset, length)` |
| string keys in the frame loop | asset ids → integer indices at load; `Map<string, idx>` at spawn only |
| `Math.random()` per particle | one `xorshift32` state per arena, seeded per effect (also gives determinism) |
| `performance.now()` per particle | one clock read per frame |
| `query.entities` iteration with closures | maintain your own dense handle index; rebuild on transition flags |
| `TrackPrevious` on high-frequency components | only on `rParticleFx` (play/stop/end of one playback), never on per-frame data |

Engine helpers when an object *must* exist: `Pool<T>` / `PooledMap` (`ecs/pool.ts`) — but note they
are `Set`-backed, so use them at spawn/unload frequency, not per frame.

### 8.3 Tier B is opt-in per asset and costs no JS

Path-dependent dynamics (force fields, colliders) run in GPU ping-pong: 1 RGBA32F texel per
particle, one pass per frame. No CPU-side particle state, no readback, no JS garbage. An asset
picks this up only if it declares a `colliders[]` or a non-analytic `dynamics[]`; measured exposure
in the Ryzom corpus is 47% of files / 46% of `sfx/magic` — and those are also the effects most
likely to be re-authored by hand anyway.

---

## 9. The Ryzom producer (`tools/ryzom/`) — one converter, not the plugin

### 9.0 Status (measured, see `tools/ryzom/PS-FORMAT.md`)

Wrapper parses on **770/770** files (`ps_probe.py`): `SHAP` → opaque u32 → u32 0 → class name → shape
version (v6 720 / v5 34 / v4 16) → `u32 + bytes` prototype → versioned tail. Prototype prefix is
**generation-dependent**: 657 files start with `u64 id(1) + version(19)`, 113 older ones start
directly at a version byte. Below the framing, payload layouts are *code*, so each class needs its
`serial()` mirrored — the port order is in §9.2 and the field checklists in `PS-FORMAT.md`.

### 9.1 Format reality check

`.ps` = NeL's `CParticleSystemShape`: a `SHAP` header, then the `CParticleSystem` **prototype as a
versioned NeL binary stream** (`serialVersion(19)`), then polymorphic node lists. Verified against
`particle_system.cpp::serial` / `ps_*.cpp`:

- Versions, bitfields and enum ints are in the stream — a reader must mirror **the same
  version-conditional layout** NeL uses (`if (version > 7) { ... }`), exactly like the C++ does.
- Node classes mostly serialize **inline ASCII names** (`CPSLocated`, `CPSEmitterConic`, …) — 57
  distinct names found by string census — which is why the first-pass report is a one-hour job.
- The **default billboard particle has no inline name** (a class-id reference), which is why string
  sniffing undercounts particles by ~400 files. A real reader needs NeL's class registry
  (`ps_register_particles.cpp`), not regex.
- NeL stores attributes **structure-of-arrays** ("each attribute is packed into its own table",
  `ps_edit.h`) — which is exactly the layout our instance pools want.

### 9.2 Port order

| stage | port | why first |
|---|---|---|
| 1 | `IStream` reader + class registry + `CPSLocated` + attrib-maker framework | everything rides on it |
| 2 | 6 emitters + Blender/Memory/BinOp/Gradient/Curve makers | ~90% of the semantic content |
| 3 | quad/dot + `FaceLookAt`/`Face` + texture group | unlocks the ~400-file majority |
| 4 | gravity / directional / drag / brownian | tier A dynamics |
| 5 | taildot, ribbon, ribbonLookAt | 171 files, weapon trails, executions |
| 6 | zones, magnetic, spring, vortex, central gravity | tier B |
| 7 | sounds, shockwave, light/fanLight, `ConstraintMesh` prerotation | polish |
| 8 | mesh particles (`.shape` → GLB) | lowest value, highest cost |

`ps_report.ts` re-runs the census and prints per-file unsupported-node lists, so scope is chosen by
usage, not by guesswork (a 20-line prototype of this already produced §2).

### 9.3 Fidelity policy

Numbers are taken verbatim; anything unrepresentable is approximated **and logged in
`meta.warnings`**, never silently dropped. Two declared approximations: `CPSBrownianForce` →
`dynamics[{type: 'noise'}]`, and `CPSLight` → `glow` quad (+ optional real light for hero casts).
The brownian one is a *unit* difference, not a look choice: NeL's intensity is an **acceleration**
(m/s²) on the path the corpus actually uses — `parametricMotion` is false on 213 of the 214
locateds in `sfx/magic`, so it runs `CPSBrownianForce::computeForces`, `speed += intensity * dt *
rand[-1,1]`, an uncorrelated random acceleration — while `dynamics[].value` is a length in metres.
`ps_bake.py` converts with one constant, `BROWNIAN_METRES_PER_INTENSITY` (½·a·t² over half a second
= 0.125 m per unit; intensity 2 bakes as 0.25 m), and logs it. What remains a texture difference is
the *character* of the wander: NeL random-walks the velocity, so a particle's excursion grows with
age, while our field is a bounded displacement sampled at `(seed, age)` and faded in over the first
15% of life — stateless and frame-rate independent on both sides, and the constant is the single
knob for how wide it reads. Validation is by eye against Ryzom footage — we have no reference
renderer, so `.ps` parameters are the ground truth, not pixels.

---

## 10. Milestones

| # | deliverable | exit criterion |
|---|---|---|
| **P0** | `ps_report.ts` census + coverage CSV | per-file node inventory for 770 files |
| **P1** | runtime skeleton: pools, atlas, `quad` kind, 3 blends, curves, arena, `rParticleFx` | ✅ built — two hand-authored demo effects (`content/particles/demo/`); remaining check: **0 B/frame in a 60 s allocation profile** |
| **P2** | converter v1 + baker (`nodes`/emitters/curves/quad) | `mag_off_missile_fire`, `mag_cur_healhp_loop`, `aura_protection` render from real `.ps` |
| **P3** | `trail` both styles, pose history, soft particles | weapon trails and rooted-cast streams on a moving skeleton |
| **P4** | tier B ping-pong (colliders, force fields) | ≥95% of `sfx/magic` converts with zero unsupported nodes |
| **P5** | LOD, budget system, counting sort, `ring` + `glow` | 500 effects / 30k particles inside the frame budget |
| **P6** | second producer (Blender exporter) or shader-tree tint integration | proves the schema is not Ryzom-shaped |

P1 is the risk-remover: if the pool + analytic eval + atlas path does not feel right at P1, stop
before writing the decoder.

---

## 11. Frame budget (reference target, 1080p, laptop-class GPU)

| item | target |
|---|---|
| live particles, sustained / peak | 30k / 60k |
| simultaneous effect playbacks | 500 (arena records, not draw calls) |
| draw calls | ≤ 12 |
| CPU / frame | ≤ 0.4 ms (spawn writes + pose row + alpha sort) |
| GPU / frame | ≤ 1.2 ms at the above, including overdraw |
| **JS allocations / frame (steady state)** | **0 B** |
| entity create/destroy from particles | 0 |
| VRAM | 2 × 2048² atlases (~32 MB w/ mips), 4.5 MB instance pool, 128 KB curve LUTs, 55 KB pose history |
| per-particle bytes | **132 B** (tier A: 8 × vec4 float + vec4 u8) · 32 B (tier B state texture) |

Overdraw is the only real threat. Controls, in order of effect: sprite pixel-area clamp →
soft-particle depth fade → both-ends alpha ramp on curves → budget-driven instance stride.

---

## 12. Risks / open questions

1. **NeL stream fidelity** — a version-conditional reader is either exact or produces garbage. Gate
   on P2: if three known effects decode to plausible numbers, the reader is right; if not, the bug
   is structural, not local. Mitigation: port `serial()` bodies mechanically and keep a round-trip
   test that re-emits bytes and diffs them.
2. **Genericity drift** — the risk of the schema slowly growing Ryzom-shaped fields. Mitigation:
   P6 requires a non-Ryzom producer; asset fields named after a producer are a review reject.
3. **Attrib-maker chains** (blender/memory/binop over per-particle state) are per-particle
   *programs*. Baking them into curves works when the chain is a pure function of life or another
   attribute; a `Memory` maker fed by events needs per-particle state → those land in tier B.
   Coverage report decides how many.
4. **`CPSMesh` needs `.shape` → GLB** — 59 shape files, no pipeline. Deferred; a `quad` fallback
   keeps telepod/elevator effects legible meanwhile.
5. **Licensing** — baked assets from Ryzom are CC BY-SA 3.0 derivatives. Same handling as
   `content/ryzom-derived/` (CREDITS + share-alike); never let that pack leak into engine assets.
6. **No reference renderer** — fidelity is parameter-true, pixel-approximate. Accept it up front.
7. **GC regressions are invisible until they hurt** — so the P1 criterion is a measured flat
   allocation profile, and the hot-path rules in §8.2 are a review checklist, not advice.

### 12.1 Engine changes considered and rejected (2026-11-20)

Reviewed against `ecs/manager.ts` and `plugins/three/rendererPlugin.ts`. **The plugin needs no
engine change** — the render seams it wants already exist: `rScene` is the active scene singleton
(`rendererPlugin.ts:449`), `rPassTargets` carries the depth target for soft particles, and
`rendererPlugin.checks.canRenderToFloatType` is the tier-B gate. Candidates that came up, with the
condition that would make each worth doing:

| candidate | verdict | trigger |
|---|---|---|
| **Component-type → query index.** Today a new-component write and every `registerEntity` sweep *all* registered queries; a `Map<componentName, Set<queryName>>` built in `createQuery` (with the existing backfill on creation) makes both O(matching). Additive, no API change, ~30 lines — but it changes a core invariant (must never miss a query created later) so it earns its own commit + tests. | **defer** | a profile where entity create/destroy dominates a real workload. Our design keeps particles out of the ECS entirely, so this buys us nothing yet. |
| **Cheaper `EntityId`.** `genId` is already a public field — a project can assign a counter today, and `EntityId` already allows `bigint`. Going further means widening the central type to include `number` (bigints are heap objects too, so they are not free). | **no** | never, unless an entity-heavy feature is measured against it. |
| **`Pool`/`PooledMap` recycling.** `ecs/pool.ts` is `Set`-backed and `Pool.use()` calls `Set.prototype.first()`. Verified working (`object.extensions.ts` — `values().next().value`); the roadmap's "always return undefined" defect is `Map.prototype.first` / `Set.prototype.last`, not this. Use frequency is spawn/unload, not per frame. | **nothing to do** | — |
| **`loaderPlugin` is an empty file** (roadmap #8) and the plugin needs async asset + atlas loading. | **don't wait** | self-load via `LoadingManager`/fetch inside the plugin (~40 lines); a general loader is a separate project. |

Rule of thumb applied: a change lands only if it removes work from a path we actually measure
(P1's allocation profile, P5's frame budget). Everything above is recorded so we do not
re-litigate it, and so the *trigger* is written down rather than remembered.

---

## 13. What landed in P1 (and what E1 changed)

`src/sprixle/plugins/particles/` — engine, zero project dependencies:

| file | role |
|---|---|
| `schema.ts` | producer-neutral asset types + the compiled runtime shape (`layers[]`, `MAX_LAYERS`) |
| `assets.ts` | validation/compile (asset → layers → emitters grouped by layer), asset registry, `loadParticleAsset` |
| `curves.ts` | one global RGBA32F curve atlas (row 0 = identity), sampled with nearest+lerp |
| `pools.ts` | `ParticlePool` (instanced quad, 32-instance block allocator, update ranges) keyed per layer + registry |
| `shaders.ts` | one vertex-program family: quad, trail (billboard/strip), velocity-stretched, + the stateless `NOISE` turbulence field |
| `playbacks.ts` | **the pure lifecycle rules** — handle allocation, per-entity cap/eviction, `seconds` → window, and the start/restart/stop/nothing decision (§6.1) |
| `arena.ts` | playback SoA (`MAX_LAYERS` runs per slot, keyed by `(entity, handle)`) + the deterministic spawn-table writer (no entities, no garbage) |
| `components.ts` | `rParticleFx` (a bounded list) / `rParticleBudget` / `particleSignal` |
| `index.ts` | `sprixlePlugin` entry: spawn/remount systems, scene attach, `play`/`stop`/`stopWhere`/`loadAsset` |

Deliberate limits, each a named follow-up rather than a hidden gap:

- **one entity shows at most 6 playbacks** (`MAX_PLAYBACKS_PER_ENTITY`) — the oldest entry is
  evicted, and eviction frees its arena runs, so this bounds pool consumption too. Not a `Map` keyed
  by anything: the list is the component, because a lookup table per entity would be a second place
  for "what is playing" to be wrong;
- **`seconds` is a lifetime, not a schedule** — a playback has one window from its start. Repeating an
  effect on a beat is the caller's `play`, deliberately: a scheduler in the arena would need a
  per-frame clock comparison per playback for a case no project has asked for;
- **a one-shot never outlives its own particles** even if `seconds` says so (`playbackWindow` caps at
  `duration + maxLife`); a loop's window does bound its repetition. The rejected alternative —
  extending a one-shot to a longer `seconds` — would hold a dead slot's instance run against the
  frame budget for no picture;
- **`bone` and `tint` are carried per playback but not applied**: the arena binds the asset's own
  `nodes[].bone`, and the shader has no tint uniform yet. Both are on the entry so a caller can state
  them once and a later shader/binder pass does not need a component change;
- **at most 4 layers per asset** (`MAX_LAYERS`) — more is a load error, not a clamp, because a
  playback's run bookkeeping (`runStart`/`runCount`/`poolOf`) is fixed at `MAX_LAYERS` per slot. A
  layer with no emitters costs nothing (no run is reserved); layers with identical draw state share
  one pool, so they share one draw call. `render.texture` stays required (it is the document marker)
  even when every layer overrides it;
- **no per-layer budget** — `budget.maxParticles` covers the whole playback, so a clamp thins every
  layer by the same ratio rather than starving the later ones;
- **no per-playback `speed`/`params`** — a live playback cannot be re-timed or re-parameterised;
  changing a request through the component is a *restart* (a new spawn table), and the arena's handle
  is the seam a future live-control API would use;
- **no per-particle sorting** for `alphaBlend` (additive and multiply need none, and are unaffected);
- **no soft-depth fade yet** (`softDepth` is accepted and ignored — the `DepthPass` target exists);
- ~~no bone binding~~ — **landed**: `pose.ts` (16-node × 64-frame × 30 Hz ring), `setNodeResolver`
  seam, node-local authoring for bound emitters, and trails that sample the ring per segment. Still
  missing: carving a swept weapon *mesh* from the same pose data, and the Ryzom node→bone name map
  (the converter's job);
- ~~no noise turbulence~~ — **landed** (stateless `dynamics[].type: 'noise'`, §4.1): 3-octave value
  noise on a 5th instance vec4 (+16 B/instance, 132 B total), gated behind a `NOISE` define. Deliberate
  limits: **not** a true curl field, sampled at `(seed, age)` rather than at the particle's position,
  one amplitude+frequency per layer (several modules collapse), and **no per-located/positional
  dynamics** — a module is a whole-layer property, not a per-particle or per-region one. Still absent:
  colliders/force fields (tier B, P4), and any noise whose amplitude varies over life (a `value`
  curve would need a 2nd curve row);
- **no noise on the Ryzom `parametricFactor` walk shape**: the baker maps the intensity to the
  amplitude and the factor to the frequency, so the *character* of the wobble is noise rather than
  NeL's smoothed random-walk table (§9.3 declares it);
- `tint` is carried per playback (and per asset) but not yet applied in the shader; the same for
  `bone` — a playback cannot override the asset's node bindings yet.

## 14. What this buys

- A neutral particle runtime any project can use, with the Ryzom library as one generated input
  rather than a dependency baked into the engine.
- Zero per-frame buffer traffic and zero steady-state JS allocation in the common case.
- One primitive, five vertex programs, one sort path — small enough a surface to keep correct.
- No WASM, no second renderer, no binary effect format we do not control.
