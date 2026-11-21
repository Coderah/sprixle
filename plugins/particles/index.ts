import { Matrix4, Scene, Texture } from 'three';
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
import { loadPoolTexture, ParticlePool, ParticlePoolRegistry } from './pools';
import { ParticleArena, type ParticleNodeResolver, type PlaybackInfo } from './arena';
import { PoseTable } from './pose';
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
    bone?: string;
    tint?: [number, number, number];
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
    poolCapacity?: number;
    /** Bones/sockets the pose ring can track simultaneously across all live effects. */
    poseNodes?: number;
    /** Pose-history resolution: `frames / hz` seconds of history (default 64 / 30 ≈ 2.1 s). */
    poseFrames?: number;
    poseHz?: number;
    /** Playback events. Without this a `particleSignal` entity is created instead. */
    onEvent?: (event: { kind: string; asset: string; name: string }) => void;
    /** Assets bundled with the app — registered at init, no fetch needed. */
    assets?: ParticleAsset[];
};

/**
 * GPU-first particle plugin.
 *
 * The whole flow is data: gameplay writes `rParticleFx`, `particleSpawnSystem` turns that into an
 * arena record + one instance-run upload per layer, `particleRenderSystem` advances the clock, and
 * three draws one instanced quad mesh per `(kind, blend, texture)` pool. No entities, no per-particle
 * state in the ECS, no per-frame attribute traffic.
 *
 * Headless-safe: importing this module touches no DOM, and using it without a scene or a renderer
 * simply spawns into pools nothing draws.
 */
export default sprixlePlugin(function particlePlugin<
    C extends defaultComponentTypes & ParticlePluginComponents
>(em: Manager<C>, options: ParticlePluginOptions = {}) {
    const curves = new CurveAtlas();
    const registry = new ParticleAssetRegistry();
    const timeUniform = { value: 0 };
    const textures = new Map<string, Texture>();
    const pose = new PoseTable(
        options.poseNodes ?? 16,
        options.poseFrames ?? 64,
        options.poseHz ?? 30
    );
    const poolRegistry = new ParticlePoolRegistry(
        curves,
        pose,
        timeUniform,
        options.poolCapacity ?? 2048
    );

    /** Set by the client once a skeleton resolver exists (see `setNodeResolver`). */
    let nodeResolver: ParticleNodeResolver | null = null;

    let scene: Scene | null = options.scene ?? null;
    const pendingMount: ParticlePool[] = [];
    const warned = new Set<string>();

    const seconds = () => now() * 0.001;

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

    function transformOf(key: string): Matrix4 | null {
        const entity = em.getEntity(key as EntityId);

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
        options.maxPlaybacks ?? 256
    );

    function emitEvent(kind: 'sound' | 'signal' | 'end', asset: string, name: string) {
        if (options.onEvent) {
            options.onEvent({ kind, asset, name });

            return;
        }

        em.quickEntity({
            particleSignal: { kind, asset, name },
        } as any);
    }

    arena.onFinished = (info: PlaybackInfo) => emitEvent('end', info.asset.id, info.key);

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

    /**
     * Turns component writes into playback. Deliberately the only system that knows about
     * `rParticleFx`, and the only place the arena is started/stopped.
     */
    const particleSpawnSystem = em.createSystem(fxQuery.createConsumer(), {
        newOrUpdated(entity) {
            const fx = entity.components.rParticleFx;
            const previous = entity.previousComponents.rParticleFx;
            const key = String(entity.id);

            if (!fx) return;

            if (!fx.playing) {
                arena.stopKey(key);

                return;
            }

            const restart =
                !previous ||
                !previous.playing ||
                previous.asset !== fx.asset ||
                previous.loop !== fx.loop ||
                previous.seed !== fx.seed;

            if (!restart) return;

            const asset = registry.get(fx.asset);

            if (!asset) {
                warnOnce(
                    `asset "${fx.asset}" is not registered (entity ${key}); the effect was not played. ` +
                        `Registered: ${registeredIds()}`
                );

                return;
            }

            if (asset.nodes.some((node) => node.bone) && asset.poseWindow > pose.window) {
                warnOnce(
                    `"${asset.id}" needs ${asset.poseWindow.toFixed(2)}s of pose history but the ring ` +
                        `holds ${pose.window.toFixed(2)}s (raise poseFrames/poseHz, or shorten the effect)`
                );
            }

            const started = arena.play(
                key,
                asset,
                seconds(),
                fx.seed ?? 0,
                !!fx.loop
            );

            if (!started) {
                warnOnce(
                    `could not start "${asset.id}": no pool capacity or no free playback slot ` +
                        `(raise poolCapacity / maxPlaybacks, or lower the effect's particle count)`
                );

                return;
            }

            for (const event of asset.events) {
                if (event.type === 'sound') emitEvent('sound', asset.id, event.name);
                else emitEvent('signal', asset.id, event.name);
            }
        },

        removed(entity) {
            arena.stopKey(String(entity.id));
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
                arena.stop(victim);
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
        fxQuery,
        particleSpawnSystem,
        particleRenderSystem,

        /** Compile + register an in-memory asset (bundled JSON, tests, code-authored effects). */
        registerAsset(raw: ParticleAsset) {
            const { asset, warnings } = compileParticleAsset(raw, curves);

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
            return loadParticleAsset(url, registry, curves);
        },

        /** Start (or restart) an effect on an entity. Replaces the component, so it fires queries. */
        play(entity: any, asset: string, playOptions: ParticlePlayOptions = {}) {
            entity.components.rParticleFx = {
                asset,
                playing: true,
                loop: playOptions.loop ?? false,
                seed: playOptions.seed ?? ((Math.random() * 0xffffffff) | 0),
                bone: playOptions.bone,
                tint: playOptions.tint,
            };
        },

        stop(entity: any) {
            const fx = entity.components.rParticleFx;
            if (!fx) return;

            entity.components.rParticleFx = { ...fx, playing: false };
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
