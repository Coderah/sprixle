// Plain import, not `import type`: deepkit resolves these annotations through the type graph and a
// type-only import erases the module binding it needs (engine roadmap #19a). Same form as
// `plugins/three/shaderTreePlugin.ts`.
import { SingletonComponent, TrackPrevious } from '../../ecs/types';

/**
 * The entire gameplay-facing surface of the particle plugin.
 *
 * One component, written on play/stop only. There is deliberately no per-frame particle state in
 * the ECS: a playback is a slot in the plugin's arena (see `arena.ts`), and the reason is measured
 * — an entity costs a uuid string, a Proxy per component and a registered-query sweep, and a busy
 * fight would pay that hundreds of times a second for data no other system reads.
 */
export type ParticlePluginComponents = {
    /** Play/stop an effect asset on this entity. Writing `playing` is the whole API. */
    rParticleFx: {
        /** Registered asset id (`ParticleAssetRegistry`). */
        asset: string;
        /** Toggling this true restarts the effect; false frees its slots. */
        playing: boolean;
        /** Loop the playback (re-spawns each emission cycle in place). */
        loop?: boolean;
        /** Deterministic spawn seed; identical seeds render identical effects. */
        seed?: number;
        /** Reserved: bind the effect root to a skeleton bone (needs the animation runtime). */
        bone?: string;
        /** Reserved: per-effect colour multiply for gameplay readability (polarity, school). */
        tint?: [number, number, number];
    } & TrackPrevious;

    /** Fill-rate budget. Optional; defaults apply when the singleton is absent. */
    rParticleBudget: {
        maxPlaybacks?: number;
        /** Total live instances across all pools. */
        maxInstances?: number;
        /** Forces every playback to collapse when nearer than this (metres). */
        minLodDistance?: number;
    } & SingletonComponent;

    /**
     * Low-rate side effects (sounds, gameplay hooks) emitted by playbacks. Consumers register on
     * `particleSignal` and deregister it; particles themselves never create entities.
     */
    particleSignal: {
        kind: 'sound' | 'signal' | 'end';
        asset: string;
        name: string;
    };
};
