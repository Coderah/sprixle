import { Matrix4, Scene, Texture, Vector2 } from 'three';
import { defaultComponentTypes, EntityId, Manager } from '../../ecs/manager';
import { sprixlePlugin } from '../../ecs/plugin';
import { now } from '../../util/now';
import type { ParticlePluginComponents } from './components';
import { CurveAtlas } from './curves';
import {
    compileParticleAsset,
    loadParticleAsset,
    ParticleAssetRegistry,
} from './assets';
import { defaultParticleTexture, loadPoolTexture, ParticlePool, ParticlePoolRegistry } from './pools';
import { ParticleArena, type ParticleNodeResolver, type PlaybackInfo } from './arena';
import { PoseTable } from './pose';
import {
    markPlaybackFinished,
    planPlaybackChanges,
    routePlaybackEvent,
    startPlayback,
    stopPlaybacks,
    stopPlaybacksWhere,
    type ParticlePlayback,
    type ParticleTravel,
} from './playbacks';
import type { ParticleAsset } from './schema';

export * from './components';
export type {
    ColorLike,
    CompiledEmitter,
    CompiledLayer,
    CompiledParticleAsset,
    CurveDef,
    ParticleAsset,
    ParticleAssetDynamic,
    ParticleAssetEmitter,
    ParticleAssetLayer,
    ParticleBlend,
    ParticleKind,
    ParticleOrient,
    TrailStyle,
    Vec2,
    Vec3,
} from './schema';
export { MAX_LAYERS } from './schema';
export { CurveAtlas } from './curves';
export {
    MAX_PLAYBACKS_PER_ENTITY,
    markPlaybackFinished,
    nextCycleEnd,
    nextPlaybackId,
    normalizeOffset,
    normalizeScale,
    normalizeTint,
    normalizeTravel,
    playbackKey,
    playbackSeconds,
    playbackWindow,
    planPlaybackChanges,
    routePlaybackEvent,
    sameOffset,
    samePlaybackRequest,
    sameTravel,
    startPlayback,
    stopPlaybacks,
    stopPlaybacksWhere,
    travelProgress,
    type ParticlePlayback,
    type ParticleTravel,
    type PlaybackAction,
    type PlaybackChange,
    type PlaybackRequest,
    type PlaybackWindow,
} from './playbacks';
export {
    compileParticleAsset,
    loadParticleAsset,
    ParticleAssetRegistry,
} from './assets';
export { ParticlePool, ParticlePoolRegistry } from './pools';
export { ParticleArena, type ParticleNodeResolver, type PlaybackInfo } from './arena';
export { PoseTable } from './pose';

const IDENTITY = new Matrix4();
const outMatrix = new Matrix4();
const DEFAULT_MAX_INSTANCES = 30000;

export type ParticlePlayOptions = {
    loop?: boolean;
    seed?: number;
    /**
     * Bind every node the asset itself binds to this bone instead of its own (`ParticlePlayback.bone`).
     *
     * The asset's bones are art; which hand plays an effect is gameplay, and one baked cast effect
     * should serve either hand. Free nodes are untouched, and an asset with no bound node ignores it.
     */
    bone?: string;
    /**
     * `'pose'` (default) samples the bone at each particle's birth through the pose ring; `'bake'`
     * multiplies the bone's world matrix in at spawn time and marks the particles free. See
     * `ParticlePlayback.attachMode` — bake is the mode that cannot, even in principle, move with the
     * emitter.
     */
    attachMode?: 'pose' | 'bake';
    /**
     * RGB multiply on every particle this playback emits — a look override for one play (`1, 1, 1` =
     * as authored). Spent as the per-instance `aTint` column, so two playbacks of one asset in the same
     * pool can carry different colours (a fire hit and a water hit of the same burst).
     *
     * Editing it on a live playback does not restart the effect (`playbacks.samePlaybackRequest`
     * ignores it); the new value reaches the particles emitted after the edit, while those already in
     * flight keep the colour they were born with.
     */
    tint?: [number, number, number];
    /**
     * Displace the effect's origin from its anchor, in metres **in the anchor's own axes**
     * (`ParticlePlayback.offset`).
     *
     * This is the field that stops a body-anchored effect from rendering inside the character: a
     * spine bone is in the middle of the torso, so an effect placed *at* it is buried in the mesh, and
     * Ryzom's own answer is an authored offset from the bone (`CFXStickMode` + `StickOffset`,
     * `attached_fx.cpp:154-168`). The vector goes through the anchor's matrix, so it is not a world
     * direction: `(0.34, 0, 0)` on a spine bone is 0.34 m along that bone's local +X, which turns
     * with the character. Absent = at the anchor, exactly as before.
     */
    offset?: readonly [number, number, number];
    /**
     * Uniform scale of the effect, 1 = as authored (`ParticlePlayback.scale`).
     *
     * Multiplies the asset's node offsets and its sprite sizes — Ryzom's `ScaleFX` — so a body-sized
     * burst can be made to read at body size. Emitter motion is not scaled. Absent or malformed = 1.
     */
    scale?: number;
    /**
     * Lifetime in seconds; 0/absent = the asset's own `duration + maxLife`.
     *
     * The gameplay window is authoritative, not the art: several baked effects are held states that
     * naturally run ~31 s, and a 0.6 s press must not leave one glowing for half a minute. This
     * replaces the client-side expiry ledger projects had to keep (wroth's
     * `particleAbilityFxSystem` did exactly that before this field existed).
     */
    seconds?: number;
    /**
     * Make the emitter travel in world space — a missile from a hand to a target (`ParticleTravel`).
     *
     * The origin of the asset's nodes interpolates from `from` to `to` over `seconds`, evaluated at
     * each particle's own **birth time** and baked into the spawn table, so a stream leaves a trail
     * and the frame path is unchanged. The caller that wants the stream to stop on arrival sets this
     * playback's `seconds` to the flight time (wroth's missile does). Absent = the playback is
     * exactly what it was before the field existed.
     */
    travel?: ParticleTravel;
};

export type ParticlePluginOptions = {
    /**
     * Scene to mount pools in. Optional: when omitted the plugin resolves the `rScene` singleton
     * (which `rendererPlugin` renders), so either renderer setup works without engine changes.
     */
    scene?: Scene;
    /**
     * World matrix for the entity a playback belongs to, written into `out`. Return false to leave
     * it at the origin. Called once per spawn (and per loop cycle), never per particle — that is
     * what keeps the spawn table a pure function of authoring data.
     */
    getTransform?: (entity: any, out: Matrix4) => boolean;
    maxPlaybacks?: number;
    /**
     * Draw layers one playback can own (default 4). The Ryzom corpus stacks up to 13 renderers on one
     * located, so a converter for it sets this higher; the arena's run bookkeeping grows with it.
     */
    maxLayers?: number;
    /** Bound nodes one asset may carry (default 8) — the pose ring allocates a slot per node. */
    maxNodes?: number;
    poolCapacity?: number;
    /** Bones/sockets the pose ring can track simultaneously across all live effects. */
    poseNodes?: number;
    /** Pose-history resolution: `frames / hz` seconds of history (default 64 / 30 ≈ 2.1 s). */
    poseFrames?: number;
    poseHz?: number;
    /**
     * Playback events (`CPSSound` sounds, gameplay signals, playback ends).
     *
     * The handler is the only way an event leaves the plugin: without it nothing is emitted at all
     * unless `emitSignalEntities` is turned on, because a `particleSignal` entity has no owner until a
     * project registers the component *and* destroys it — emitting one by default leaked an ECS entity
     * per cast, hit and resist (issue 001).
     */
    onEvent?: (event: { kind: string; asset: string; name: string }) => void;
    /**
     * Emit a `particleSignal` ECS entity per playback event instead of calling `onEvent`.
     *
     * **Off by default, and opt-in on purpose.** The entity is a hand-off: the consumer is expected to
     * register the `particleSignal` component, read it and destroy the entity. A project that never
     * registered it leaked one entity per event forever — every cast, every hit, every resist — so the
     * default is now "no entity". Set this (and destroy what you read) or pass `onEvent`.
     */
    emitSignalEntities?: boolean;
    /** Assets bundled with the app — registered at init, no fetch needed. */
    assets?: ParticleAsset[];
    /**
     * Enable the soft-depth fade (see `shaders.ts`). The *pass* is the project's: this only makes
     * every pool material sample a depth texture the project supplies through `softDepthUniforms`.
     * Off by default, because a project with no depth pass would compile a shader that samples an
     * unbound texture and fade everything out.
     */
    softDepth?: boolean;
    /** Feathering width in metres for that fade (default 0.35). */
    softDistance?: number;
};

/**
 * GPU-first particle plugin.
 *
 * The whole flow is data: gameplay writes `rParticleFx` (a bounded **list** of playbacks per entity,
 * each with its own asset and lifetime), `particleSpawnSystem` turns the list's changes into arena
 * records + one instance-run upload per layer per playback, `particleRenderSystem` advances the clock,
 * and three draws one instanced quad mesh per `(kind, blend, texture)` pool. No entities, no
 * per-particle state in the ECS, no per-frame attribute traffic.
 *
 * Headless-safe: importing this module touches no DOM, and using it without a scene or a renderer
 * simply spawns into pools nothing draws. The lifecycle *rules* live in `playbacks.ts`, which imports
 * neither three nor the ECS, so a node script can prove them (`particles-lifecycle-sanity.mjs`).
 */
export default sprixlePlugin(function particlePlugin<
    C extends defaultComponentTypes & ParticlePluginComponents
>(em: Manager<C>, options: ParticlePluginOptions = {}) {
    const curves = new CurveAtlas();
    const registry = new ParticleAssetRegistry();
    const timeUniform = { value: 0 };
    /** `uPoseLive`: 0 = pose at birth (shipping), 1 = pose now (debug, see the shader). */
    const poseLiveUniform = { value: 0 };
    const textures = new Map<string, Texture>();
    const pose = new PoseTable(
        options.poseNodes ?? 16,
        options.poseFrames ?? 64,
        options.poseHz ?? 30
    );
    /**
     * The shared soft-depth uniforms, or `undefined` when the option is off. The project owns the
     * values — it is the only layer that can render a depth pass and knows the camera — so they are
     * created here and written from outside each frame.
     */
    const softDepthUniforms = options.softDepth
        ? {
              uSceneDepth: { value: null as Texture | null },
              uResolution: { value: new Vector2(1, 1) },
              uCameraNear: { value: 0.1 },
              uCameraFar: { value: 100 },
              uSoftDistance: { value: options.softDistance ?? 0.35 },
          }
        : undefined;

    const poolRegistry = new ParticlePoolRegistry(
        curves,
        pose,
        timeUniform,
        poseLiveUniform,
        softDepthUniforms,
        options.poolCapacity ?? 2048
    );

    /** Set by the client once a skeleton resolver exists (see `setNodeResolver`). */
    let nodeResolver: ParticleNodeResolver | null = null;

    let scene: Scene | null = options.scene ?? null;
    const pendingMount: ParticlePool[] = [];
    const warned = new Set<string>();

    /**
     * Inspection aid: the particle clock can run slower than wall time.
     *
     * Every time-shaped value in the plugin comes from `seconds()` — `bornAt` when a playback starts,
     * `uTime` in the shader, the playback deadlines — so scaling it here keeps all of them mutually
     * consistent, which is the only version of slow motion that is not a lie about the animation. What
     * it cannot do is rescale particles *already* in flight: change it and they jump. Set it while
     * nothing is playing (the studio stops the effect, changes the scale, then replays).
     */
    let timeScale = 1;
    const seconds = () => now() * 0.001 * timeScale;

    /** Reads a singleton without `getSingletonEntityComponent`, which *creates* a missing one. */
    function readSingleton<K extends keyof C & string>(name: K): C[K] | undefined {
        const entity = em.getEntity(name as EntityId);

        return entity?.components[name];
    }

    function mountPending() {
        while (pendingMount.length) {
            const pool = pendingMount.pop()!;
            if (!scene) return;
            scene.add(pool.mesh);
        }
    }

    function resolveScene(): Scene | null {
        if (scene) return scene;

        const fromEcs = readSingleton('rScene') as unknown as Scene | undefined;
        if (fromEcs) {
            scene = fromEcs;
            mountPending();
        }

        return scene;
    }

    function textureFor(source: { textureUrl: string }): Texture {
        // An untextured layer draws the built-in dot; nothing to fetch, nothing to cache.
        if (!source.textureUrl) return defaultParticleTexture();

        let texture = textures.get(source.textureUrl);

        if (!texture) {
            texture = loadPoolTexture(source.textureUrl, () => {
                // three uploads on first use; nothing else to do when the image arrives.
            });
            textures.set(source.textureUrl, texture);
        }

        return texture;
    }

    poolRegistry.onPoolCreated = (pool) => {
        const active = resolveScene();

        if (active) active.add(pool.mesh);
        else pendingMount.push(pool);
    };

    function transformOf(entityKey: string): Matrix4 | null {
        const entity = em.getEntity(entityKey as EntityId);

        if (!entity) return null;
        if (options.getTransform && options.getTransform(entity, outMatrix)) {
            return outMatrix;
        }

        return IDENTITY;
    }

    const arena = new ParticleArena(
        poolRegistry,
        transformOf,
        (layer) => textureFor(layer),
        pose,
        (key, nodeName, out) =>
            nodeResolver ? nodeResolver(key, nodeName, out) : false,
        options.maxPlaybacks ?? 256,
        options.maxLayers ?? 4,
        options.maxNodes ?? 8
    );

    function emitEvent(kind: 'sound' | 'signal' | 'end', asset: string, name: string) {
        // One rule, in the pure module, so the default is testable: "no handler, no opt-in" = nothing
        // is created. A `particleSignal` entity has no owner until a project registers the component
        // *and* destroys it, so emitting one by default leaked an entity per event — every cast, hit
        // and resist (issue 001).
        const route = routePlaybackEvent(options);

        if (route === 'handler') {
            options.onEvent!({ kind, asset, name });

            return;
        }

        if (route === 'entity') {
            em.quickEntity({
                particleSignal: { kind, asset, name },
            } as any);

            return;
        }

        // Never silent, but said once (the message carries no asset/event names for that reason — a
        // corpus with 113 assets of `CPSSound` events would otherwise print one warning per event).
        warnOnce(
            'a playback event was dropped (sound/signal/end): pass the plugin an `onEvent` handler, ' +
                'or `emitSignalEntities: true` to spawn a `particleSignal` entity for a consumer to ' +
                'read and destroy.'
        );
    }

    arena.onFinished = (info: PlaybackInfo) => finishPlayback(info);

    /**
     * Retires a playback in the ECS as well as in the arena.
     *
     * The component write is not cosmetic: without it the entry stays `playing: true`, and any later
     * component write on that entity (a new effect, a stop of a sibling) reconciles the unchanged entry
     * as a start request — so a playback that ended on its own would replay forever. One `playing:
     * false` per end, and `markPlaybackFinished` returns `null` if it was already written.
     */
    function finishPlayback(info: PlaybackInfo) {
        const entity = em.getEntity(info.entityKey as EntityId);
        const state = entity?.components.rParticleFx as { playbacks: ParticlePlayback[] } | undefined;

        if (state) {
            const playbacks = markPlaybackFinished(state.playbacks, info.handle);

            if (playbacks) entity.components.rParticleFx = { playbacks };
        }

        emitEvent('end', info.asset.id, info.key);
    }

    arena.onMissingNode = (entityKey, bone) =>
        warnOnce(
            `bone "${bone}" never resolved for entity ${entityKey}: attached particles fall back to ` +
                `the previous pose (or the origin). Check the name against the skeleton — three ` +
                `rewrites spaces to underscores (roadmap: GLTFLoader sanitizeNodeName).`
        );

    function warnOnce(message: string) {
        if (warned.has(message)) return;

        warned.add(message);
        console.warn(`[particles] ${message}`);
    }

    /**
     * Diagnostics only (a failed spawn, never the frame path): a "not registered" warning that does
     * not say what *is* registered sends the reader to the loader when the missing piece is usually
     * the call site — nothing ever called `loadAsset` for that id.
     */
    function registeredIds() {
        const ids = registry.list().map((known) => known.id);

        return ids.length ? ids.join(', ') : '(none)';
    }

    const fxQuery = em.createQuery({ includes: ['rParticleFx'] });

    /** Scratch for the live handles the reconcile pass asks the arena for; never escapes a call. */
    const liveHandles: number[] = [];

    /**
     * Turns component writes into playback. Deliberately the only system that knows about
     * `rParticleFx`'s reconcile rules, and the only place the arena is started/stopped.
     *
     * `playbacks.planPlaybackChanges` decides (pure and testable in node); this only executes: the
     * arena call per decision, plus the warnings a silent failure would turn into a mystery.
     */
    const particleSpawnSystem = em.createSystem(fxQuery.createConsumer(), {
        newOrUpdated(entity) {
            const fx = entity.components.rParticleFx;
            const previous = entity.previousComponents.rParticleFx;
            const key = String(entity.id);

            if (!fx) return;

            // Reused scratch: the reconcile runs on every component write, which is play/stop
            // frequency, but "the handle list is empty" is also the common case.
            const live = arena.handlesOf(key, liveHandles);
            const changes = planPlaybackChanges(key, previous?.playbacks, fx.playbacks, live);

            for (const change of changes) {
                if (change.action === 'stop') {
                    arena.stopKey(change.key);

                    continue;
                }

                const playback = change.playback;
                const asset = registry.get(playback.asset);

                if (!asset) {
                    warnOnce(
                        `asset "${playback.asset}" is not registered (entity ${key}); the effect was not ` +
                            `played. Registered: ${registeredIds()}`
                    );

                    continue;
                }

                const boundNodes = asset.nodes.some((node) => node.bone);
                // Both warnings below are about *bone* attachment, which a travelling playback does
                // not use: its origin is the line, and the bone in the request only told the caller
                // where the line starts. Warning there would be noise about a mechanism that is off.
                //
                // A playback-level bone override attaches *every* node, so the ring-window check has to
                // run for it as well — an unbound asset played on a bone is the case that used to slip
                // through and then appear to follow the hand once the ring recycled its birth frame.
                if (!playback.travel && (boundNodes || playback.bone) && asset.poseWindow > pose.window) {
                    warnOnce(
                        `"${asset.id}" needs ${asset.poseWindow.toFixed(2)}s of pose history but the ring ` +
                            `holds ${pose.window.toFixed(2)}s (raise poseFrames/poseHz, or shorten the effect)`
                    );
                }
                if (!playback.travel && playback.bone && !boundNodes) {
                    warnOnce(
                        `"${asset.id}" binds no bone; the override "${playback.bone}" moves every node into ` +
                            `that bone's frame, so the whole effect is displaced by the hand`
                    );
                }

                const started = arena.play(
                    key,
                    playback.id,
                    asset,
                    seconds(),
                    playback.seed ?? 0,
                    !!playback.loop,
                    playback.seconds ?? 0,
                    playback.bone,
                    playback.attachMode,
                    playback.travel,
                    playback.offset,
                    playback.scale,
                    playback.tint
                );

                if (!started) {
                    warnOnce(
                        `could not start "${asset.id}": no pool capacity or no free playback slot ` +
                            `(raise poolCapacity / maxPlaybacks, or lower the effect's particle count)`
                    );

                    continue;
                }

                for (const event of asset.events) {
                    if (event.type === 'sound') emitEvent('sound', asset.id, event.name);
                    else emitEvent('signal', asset.id, event.name);
                }
            }

            // `tint` is a look override rather than a request change (`samePlaybackRequest` ignores it,
            // so a colour edit never restarts the effect), which means the arena has to be told about it
            // here or it would never reach the draw state at all. Runs at component-write frequency
            // (play/stop), and `setTint` returns immediately when nothing changed.
            for (const playback of fx.playbacks) {
                if (playback.playing) arena.setTint(key, playback.id, playback.tint);
            }
        },

        removed(entity) {
            arena.stopEntity(String(entity.id));
        },

        tick() {
            const time = seconds();

            // The shader's only time input. Set here (simulation) rather than at draw so a
            // playback that starts mid-frame ages from the frame that spawned it.
            timeUniform.value = time;

            arena.tick(time);

            const budget = readSingleton('rParticleBudget') as
                | { maxInstances?: number }
                | undefined;
            const maxInstances = budget?.maxInstances ?? DEFAULT_MAX_INSTANCES;

            // Evict oldest first: the newest effect is what the player just triggered.
            let guard = 0;

            while (arena.totalInstances > maxInstances && guard++ < 32) {
                const victim = arena.oldestSlot();
                if (victim < 0) break;

                // A budget eviction is an end like any other: the component entry is retired too, or
                // the next unrelated write on that entity would reconcile it as a start request.
                const info = arena.infoOf(victim);
                arena.stop(victim);
                if (info) finishPlayback(info);
            }
        },
    });

    /** Advances the shared clock and mounts pools into a scene that appeared late. */
    const particleRenderSystem = em.createSystem({
        tag: 'particleRenderSystem',
        tick() {
            timeUniform.value = seconds();

            if (pendingMount.length) resolveScene();
        },
    });

    return {
        curves,
        registry,
        pose,
        pools: poolRegistry,
        arena,
        timeUniform,
        softDepthUniforms,

        /**
         * Run the particle clock at `scale`× wall time (1 = real time). Inspection only: see the
         * `timeScale` note near `seconds()`.
         */
        setTimeScale(scale: number) {
            timeScale = Number.isFinite(scale) && scale > 0.01 ? scale : 1;
        },

        /** The current clock scale, so a panel can show it without keeping its own copy. */
        getTimeScale() {
            return timeScale;
        },

        /**
         * Debug: sample a bone-bound emitter's pose **now** instead of at each particle's birth.
         *
         * Shipping behaviour is birth-sampling (`shaders.ts`): the bone gives a particle its origin and
         * the particle is free afterwards. Turning this on glues every live particle to the bone, which
         * is what "the emitter is parenting the particles" looks like — so a report of that can be
         * checked with one click instead of an argument. Never enable it in gameplay.
         */
        setPoseLive(live: boolean) {
            poseLiveUniform.value = live ? 1 : 0;
        },

        getPoseLive() {
            return poseLiveUniform.value === 1;
        },
        fxQuery,
        particleSpawnSystem,
        particleRenderSystem,

        /** Compile + register an in-memory asset (bundled JSON, tests, code-authored effects). */
        registerAsset(raw: ParticleAsset) {
            const { asset, warnings } = compileParticleAsset(raw, curves, {
                maxLayers: options.maxLayers,
                maxNodes: options.maxNodes,
            });

            if (warnings.length) {
                console.warn(`[particles] ${asset.id}:\n  - ${warnings.join('\n  - ')}`);
            }

            return registry.register(asset);
        },

        /**
         * Provide the bone/socket resolver. Called once per bound node per playback per frame, so it
         * must be cheap and must not allocate; returning false keeps the last known pose.
         *
         * Client-side by nature (it needs the posed skeleton), which is why the plugin takes it as a
         * seam instead of importing an animation system.
         */
        setNodeResolver(resolver: ParticleNodeResolver | null) {
            nodeResolver = resolver;
        },

        /**
         * Mount the pools into a scene. Called automatically the first time an effect spawns
         * (usually via the `rScene` singleton); call it explicitly when the project owns its scene
         * (as wroth does) so the first effect does not wait for the resolve.
         */
        attachScene(next: Scene) {
            if (scene === next) return;

            scene = next;
            mountPending();

            for (const pool of poolRegistry.all()) {
                if (pool.mesh.parent !== next) next.add(pool.mesh);
            }
        },

        /** Fetch + compile + register (a URL, not a webpack import). */
        loadAsset(url: string) {
            // The same compile ceilings `registerAsset` passes: an asset fetched from a URL must not be
            // held to a different `maxLayers` / `maxNodes` than an in-memory one.
            return loadParticleAsset(url, registry, curves, {
                maxLayers: options.maxLayers,
                maxNodes: options.maxNodes,
            });
        },

        /**
         * Append a playback to this entity and return its handle (`ParticlePlayback.id`).
         *
         * Never replaces: two assets on one pawn are two slots with two lifetimes. The oldest entry is
         * evicted past `MAX_PLAYBACKS_PER_ENTITY`, and its arena slot is freed by the reconcile pass —
         * this method only writes the component, so a caller can compose a sequence of plays in one
         * frame and have them all start on the same beat.
         *
         * `play`-with-`seconds` is the replacement for a project-side expiry map: the plugin retires the
         * playback on its own deadline (see `playbacks.ts`).
         */
        play(entity: any, asset: string, playOptions: ParticlePlayOptions = {}) {
            const state = entity.components.rParticleFx as
                | { playbacks: ParticlePlayback[] }
                | undefined;

            const { playbacks, playback } = startPlayback(state?.playbacks ?? [], {
                asset,
                loop: playOptions.loop,
                seed: playOptions.seed ?? ((Math.random() * 0xffffffff) | 0),
                bone: playOptions.bone,
                attachMode: playOptions.attachMode,
                tint: playOptions.tint,
                offset: playOptions.offset,
                scale: playOptions.scale,
                seconds: playOptions.seconds,
                travel: playOptions.travel,
            });

            entity.components.rParticleFx = { playbacks };

            return playback.id;
        },

        /** Mark one playback (`id`) or every playback on the entity not-playing. */
        stop(entity: any, id?: number) {
            const state = entity.components.rParticleFx as
                | { playbacks: ParticlePlayback[] }
                | undefined;

            if (!state) return;

            const playbacks = stopPlaybacks(state.playbacks, id);

            if (playbacks) entity.components.rParticleFx = { playbacks };
        },

        /**
         * Stop the playbacks a predicate selects, leaving their siblings alive.
         *
         * The caller that needs it is wroth's FX adaptor: its ability layer sends "stop" for a pawn
         * with no way to name one playback, so the only way to end a cast *channel* without killing the
         * impact it just fired is "stop the looping ones". `stop(entity)` would take both.
         */
        stopWhere(entity: any, predicate: (playback: ParticlePlayback) => boolean) {
            const state = entity.components.rParticleFx as
                | { playbacks: ParticlePlayback[] }
                | undefined;

            if (!state) return;

            const playbacks = stopPlaybacksWhere(state.playbacks, predicate);

            if (playbacks) entity.components.rParticleFx = { playbacks };
        },

        dispose() {
            for (const [url, texture] of textures) {
                texture.dispose();
                textures.delete(url);
            }

            for (const pool of poolRegistry.all()) scene?.remove(pool.mesh);

            poolRegistry.dispose();
        },
    };
});
