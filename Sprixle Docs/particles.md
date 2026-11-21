# Particles — GPU-first particle plugin (design)

*Engine ref: 5fd6b1b (2026-11-21)*

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
    /** play/stop an effect on an entity. Writing this is the entire gameplay API. */
    rParticleFx: {
        asset: string;                    // neutral asset id (resolved to an index at load)
        playing: boolean;
        loop: boolean;
        speed: number;
        seed: number;                     // determinism
        bone?: string;                    // bind to an animated node
        tint?: THREE.Color;               // game-side colouring (polarity, damage type, …)
        params?: number[];                // producer/user params (intensity, rage, …)
        handle?: number;                  // out: id of the live playback, if the game needs it
    } & TrackPrevious;

    /** enemies of fill rate: one place to enforce the frame budget */
    rParticleBudget: { maxLive: number; maxEffects: number; minLod: number } & SingletonComponent;

    /** drained by consumers (audio, screen shake); low-rate, gameplay-relevant only */
    particleSignal: { kind: 'sound' | 'end' | 'trigger'; asset: string; name: string };
};
```

`rParticleFx` is written on **play/stop only** — never per frame. Live control (speed/params) goes
through the returned `handle` into the arena, because a component write costs a proxy trap, a
`TrackPrevious` copy and a query sweep (§8.2).

Systems (ordered pipeline, each unaware of the others):

1. `spawnSystem` — `rParticleFx` newOrUpdated → arena record, slot allocation, one instance-run
   write. Emits `particleSignal` for producer-declared events (sounds).
2. `attachmentSystem` — resolves `bone` bindings → writes this frame's pose-history row.
3. `budgetSystem` — enforces `rParticleBudget`, picks LOD, retires the oldest effects on overflow.
4. `particleRenderSystem` — flush dirty runs, set uniforms, set draw order.

Actions layer (game repo): `playAbilityFx(entity, abilityId)` writes `rParticleFx`. Nothing else.

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
(`maxEffects`), free-list of integers, no per-record objects:

```ts
// one flat record set, allocated once
handle     : Int32Array(MAX * LAYERS)  // instance run start, one per layer
total      : Int32Array(MAX)           // instances held, so freeing is one subtraction
+ assetIdx : Int16Array(MAX)
+ bornAt   : Float64Array(MAX)
+ speed    : Float32Array(MAX)
+ params   : Float32Array(MAX * 4)
+ flags    : Uint8Array(MAX)
```

The ECS sees one `rParticleFx` write at play and one at stop. Games that need to steer a live
effect use the numeric `handle` (arena index), not a component rewrite.

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
| `TrackPrevious` on high-frequency components | only on `rParticleFx` (play/stop), never on per-frame data |

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

## 13. What landed in P1

`src/sprixle/plugins/particles/` — engine, zero project dependencies:

| file | role |
|---|---|
| `schema.ts` | producer-neutral asset types + the compiled runtime shape (`layers[]`, `MAX_LAYERS`) |
| `assets.ts` | validation/compile (asset → layers → emitters grouped by layer), asset registry, `loadParticleAsset` |
| `curves.ts` | one global RGBA32F curve atlas (row 0 = identity), sampled with nearest+lerp |
| `pools.ts` | `ParticlePool` (instanced quad, 32-instance block allocator, update ranges) keyed per layer + registry |
| `shaders.ts` | one vertex-program family: quad, trail (billboard/strip), velocity-stretched, + the stateless `NOISE` turbulence field |
| `arena.ts` | playback SoA (`MAX_LAYERS` runs per slot) + the deterministic spawn-table writer (no entities, no garbage) |
| `components.ts` | `rParticleFx` / `rParticleBudget` / `particleSignal` |
| `index.ts` | `sprixlePlugin` entry: spawn/remount systems, scene attach, `play`/`stop`/`loadAsset` |

Deliberate P1 limits, each a named follow-up rather than a hidden gap:

- **at most 4 layers per asset** (`MAX_LAYERS`) — more is a load error, not a clamp, because a
  playback's run bookkeeping (`runStart`/`runCount`/`poolOf`) is fixed at `MAX_LAYERS` per slot. A
  layer with no emitters costs nothing (no run is reserved); layers with identical draw state share
  one pool, so they share one draw call. `render.texture` stays required (it is the document marker)
  even when every layer overrides it;
- **no per-layer budget** — `budget.maxParticles` covers the whole playback, so a clamp thins every
  layer by the same ratio rather than starving the later ones;
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
- `tint` is carried but not yet applied in the shader.

## 14. What this buys

- A neutral particle runtime any project can use, with the Ryzom library as one generated input
  rather than a dependency baked into the engine.
- Zero per-frame buffer traffic and zero steady-state JS allocation in the common case.
- One primitive, five vertex programs, one sort path — small enough a surface to keep correct.
- No WASM, no second renderer, no binary effect format we do not control.
