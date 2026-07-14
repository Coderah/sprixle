# Blender Authoring — practical conventions

*Engine ref: f3f5215 (2026-07-13)*

Companion to `blender.md` (concepts/roadmap). This is the working knowledge needed to author `.blend` content and wire it at runtime. Reference implementations: **lanebreak-tactics** (shaderTree + prefabs + batching, the deepest usage) and **sobelow** (feature-tag-driven scene loading).

## The three channels (plus hot reload)

1. **GLTF export** — geometry, materials (with node trees serialized into `material.userData.shaderTree`), animations, cameras, and exported attributes travel in `.glb` extras (`export_extras: true` in the addon's exporter).
2. **Live websocket — shader/logic trees** — the Blender addon runs a ws server on **port 9001**, pushing debounced `{type: logicTree|shaderTree|sceneChange|export, name, data}` messages. Enable with `enableNodeTreeBlenderConnection()` (dev only); `shaderTreePlugin`/`logicTreePlugin` listen on `blenderEvents` and recompile live.
3. **Live websocket — realtime geometry** — when a MESH object's geometry or transform changes in Blender, the addon debounces (300ms) and exports the changed objects to `<blend>.realtime.glb` next to the blend file, then sends `{type: "realtimeGeometry", name: "<blend>.realtime.glb"}` over the same ws connection. The [`applyRealtimeGeometryPlugin`](../blender/realtimeGeometryPlugin.ts) on the TS side fetches the GLB and swaps geometry/transform on matching scene objects by name. The blend file's directory must be accessible to the web app (e.g. served by the dev server or a symlink into the assets directory).

The same shader tree can arrive both baked-in-GLB and live-over-ws. Gate live events behind initial load with `setBlenderRealtimePromise(loadPromise)` or hot-reload races startup.

**Realtime geometry caveats:** Only MESH objects trigger exports; each export is a full GLB of the changed objects — the TS side matches by object name and replaces geometry + transform in place. Materials are re-exported with each change (a future version should wire through `materialManagerPlugin` for dedup). If you edit a material without touching geometry, only the shader tree ws message fires (not a geometry export).

**Known gaps (see `realtimeGeometryPlugin.ts` header):** (1) `materialManagerPlugin` integration so compiled shaderTree materials survive geometry swaps. (2) A generalized `sceneLoader` plugin suite so every project doesn't roll its own GLB loading + feature-tag dispatch; this plugin should write to an `object3D` component, not the scene graph directly. (3) `object3D` should be an ECS component and scene-graph sync should be a separate reaction — this plugin shortcuts that for now.

## The `+feature(arg)` name DSL — the most important convention

`util/blender.ts` → `getFeaturesFromName(object)` parses **object name + material name concatenated** with `/\+([\w]+)(?:\(([\w-]+)\))?/gi`:

- `MyMesh +compile +light` → `{ compile: true, light: true }`
- `rune+script(wSymbol)+if(finish)` → `{ script: 'wSymbol', if: 'finish' }`
- Everything before the first `+` is the `reference` (clean name).
- A mesh **inherits its material's features** (names are concatenated before parsing).

Engine-consumed features: `+compile` (material → compile its shaderTree), `+logic` (Geometry Nodes tree → logicTree export), `+attribute` (userData key → BufferAttribute), `+ambient` (animation clip auto-plays ping-pong), `+light`.

**Projects define their own features freely** and dispatch on them in their loader — sobelow's whole scene grammar is feature tags (`+above/+below`, `+reflect`, `+water`, `+reveal`, `+script(name)`, `+if(state)`, `+stateOn(state)`, `+prefab`, `+cameraTarget`, …). This is the recommended way to attach gameplay semantics to authored content without custom exporters.

**There is no validation.** A renamed object/collection silently stops matching. Mitigations: keep the feature vocabulary documented per-project; log unrecognized features at load; validate required magic names on startup.

## Geometry-node attribute export

Geometry Nodes modifiers named **`Sprixle: Export Attribute`** / **`Sprixle: Export Instances`** are serialized by the addon's `exporter.py` into custom properties keyed `"<name>+attribute"` (vectors get the Z-up→Y-up swap). At runtime `applyExportedAttributes(object)` parses them back into `BufferAttribute`s. This is the path for baked per-vertex/per-instance data (baked light via vertex colors, instance metadata, …). Caveat: the runtime side currently only reconstructs **scalar** (itemSize-1) attributes — vector lists just `console.warn` — and the exporter's matrix Z-up→Y-up swap is commented out; check `util/blender.ts`/`exporter.py` before relying on non-scalar attributes.

## Shader trees

- Materials tagged `+compile` (or all, per project loader) become entities `{ materialName, shaderTree: JSON }`; `shaderTreePlugin` (a `sprixlePlugin`, depends on materialManagerPlugin) compiles each into a GLSL3 `ShaderMaterial` **plus a matching depth material**, swapping in `material`/`depthMaterial` components. `materialManagerPlugin.reuseMaterial` dedups by `material.name`.
- **Custom nodes**: pass a `methods` object when applying the plugin. Each method name must exactly match a **Blender group-node name**, its body supplies GLSL, and its **deepkit-reflected return type (`GLSL<{...}>`) defines the node's output sockets**. This is how per-instance data (palette data-textures indexed by `gl_DrawID` under `USE_BATCHING`, HUD bars, etc.) gets injected into artist-authored materials.
- Supported nodes: `plugins/shaderTree/supported-nodes.md`. The compiler (`plugins/nodeTrees/createCompiler.ts`) transpiles Blender's own GLSL (voronoi, noise, fresnel, color ramp, map range…).

## Logic trees

Geometry Nodes trees tagged `+logic` compile to runnable systems via `applyLogicTreePlugin(em, methods)` — you implement your node vocabulary 1-to-1 in `methods`. Implemented generic nodes: `plugins/logicTree/implemented-nodes.md`. Note: projects to date author gameplay in TypeScript and use shaderTree only — if a project has no logic trees, that's normal, don't hunt for missing graphs.

## Prefab & scene conventions (lanebreak's proven shape)

- A master `prefabs.blend` → `prefabs.glb` with **top-level collections as prefab categories** (`Cars`, `Items`, `World-Prefabs`, `Effects`, `UI`); immediate children become prefab entities `{ isPrefab, prefabId, prefabCategory, object3D }` keyed `"<Category>-<name> prefab"`. Game data references prefabs by `prefabId` — **the string must exactly match the Blender object name**; keep a manifest/validation because drift is silent.
- A collection named `World` is added straight to the scene; an `OrthographicCamera` in the GLB can be adopted as the game camera; a material literally named `debug` hides its mesh.
- Animation clips become entities; a clip's track name is split on `.` and the prefix resolved as an entity id — Blender object names are coupled to ECS ids here.
- Dedicated offscreen scenes (e.g. `car-preview.glb` with its own camera + anchor empty) are a clean pattern for thumbnail rendering.

## Shader/render library notes (`render/`, `shader/`)

- `glsl` tagged-template (`shader/util.ts`) for readable GLSL with interpolation.
- `render/reflectorCamera.ts` — a geometry-agnostic Reflector: it owns only the virtual camera, render target, texture matrix, and oblique near-plane clipping; **the surface material is your problem** — inject sampling via `onBeforeCompile`. Pair with sobelow's patterns: a shared depth-texture + `depthDiff` injection helper, and an `applyShaderCompile(material, compile)` chainer so multiple injections stack on one material.
- `shader/` contains post shaders (cel, rotoscope, kuwahara, sobel), splat/decal materials, photoshop blend-mode math, and shared includes.

## Checklist for a Blender-integrated project

1. Install the addon (`blender/addon/`, manifest `blender_manifest.toml`); use the asset library in `blender/assets/`.
2. Export via the addon (it wraps the GLTF exporter with extras/attribute handling).
3. Load the GLB, walk children, dispatch on `getFeaturesFromName` — keep the loader table-driven, not a 500-line god-function (sobelow's `worldSystem` is the cautionary tale).
4. Apply `shaderTreePlugin` (+ `materialManagerPlugin`) with your `methods`; call `enableNodeTreeBlenderConnection()` in dev.
5. Document your project's feature vocabulary in the project CLAUDE.md.
