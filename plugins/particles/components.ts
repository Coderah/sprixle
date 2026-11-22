// Plain import, not `import type`: deepkit resolves these annotations through the type graph and a
// type-only import erases the module binding it needs (engine roadmap #19a). Same form as
// `plugins/three/shaderTreePlugin.ts`.
import { SingletonComponent, TrackPrevious } from '../../ecs/types';
import { type ParticlePlayback } from './playbacks';

/**
 * The entire gameplay-facing surface of the particle plugin.
 *
 * `rParticleFx` is a **list of playbacks on one entity** — not one effect. An entity can show several
 * at once, each with its own lifetime: a cast channel on the hand while the missile it launched is
 * still in the air, a held aura under a hit burst, a shield bubble and its own impact flash. The list
 * is bounded at `MAX_PLAYBACKS_PER_ENTITY` (6) and the oldest entry is evicted on overflow
 * (`playbacks.ts` owns every one of those rules; this file is the shape).
 *
 * Written on play/stop only — never per frame. There is deliberately no per-frame particle state in
 * the ECS: an entry is an *instruction* (`asset`, `playing`, `seconds`), the playback itself is a
 * slot in the plugin's arena (`arena.ts`), and the reason is measured — an entity costs a uuid
 * string, a Proxy per component and a registered-query sweep, and a busy fight would pay that
 * hundreds of times a second for data no other system reads. A list does not weaken that: it is
 * still play/stop state, and the only writes the plugin itself makes are one `playing: false` per
 * playback *end* (so a finished entry does not reconcile as a new start request).
 */
export type ParticlePluginComponents = {
    /** Play/stop particle effects on this entity. Appending an entry is the whole API. */
    rParticleFx: {
        /** Live-or-finished playbacks, oldest first. `play` appends; `stop` flips `playing`. */
        playbacks: ParticlePlayback[];
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
