import { Matrix4, Texture, Vector3 } from 'three';
import type { CompiledLayer, CompiledParticleAsset } from './schema';
import { DEFAULT_MAX_LAYERS, DEFAULT_MAX_NODES } from './schema';
import type { PoseTable } from './pose';
import {
    bakesAttachment,
    nextCycleEnd,
    playbackKey,
    playbackWindow,
    resolvedNodeBone,
} from './playbacks';
import {
    createInstanceScratch,
    type InstanceScratch,
    type ParticlePool,
    type ParticlePoolRegistry,
} from './pools';

const IDENTITY = new Matrix4();
/** Effect transform × the asset's authored root node, composed per spawn (never per particle). */
const nodeMatrix = new Matrix4();
/** Resolved bone matrix, reused for every pose write. */
const resolvedNode = new Matrix4();

/** Default cap on bound nodes per effect — a sizing decision, tunable via the plugin's `maxNodes`. */
const DEFAULT_NODES_PER_ASSET = DEFAULT_MAX_NODES;

/** Resolves a bone/socket name to a world matrix for the entity that owns a playback. */
export type ParticleNodeResolver = (
    entityKey: string,
    nodeName: string,
    out: Matrix4
) => boolean;

// Scratch objects: the spawn path runs per particle, so it allocates nothing — see the hot-path
// rules in `Sprixle Docs/particles.md` §8.
const tmpPos = new Vector3();
const tmpDir = new Vector3();
const tmpAccel = new Vector3();
const tmpExtent = new Vector3();
const tmpTangent = new Vector3();
const tmpBitangent = new Vector3();
const tmpUp = new Vector3();
const tmpRef = new Vector3();

const scratch: InstanceScratch = createInstanceScratch();
const deadScratch: InstanceScratch = {
    ...createInstanceScratch(),
    life: 0,
    bornAt: -1e9,
    sizeX: 0,
    sizeY: 0,
    noiseAmplitude: 0,
    r: 0,
    g: 0,
    b: 0,
    a: 0,
};

// xorshift32: seeded, deterministic, allocation-free. Same seed + same asset ⇒ same spawn table,
// which is what makes an effect reviewable and a bug reproducible.
let rngState = 1;

function seedRng(seed: number) {
    rngState = (seed >>> 0) || 1;
}

function rand() {
    let x = rngState;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    rngState = x;

    return x / 4294967296;
}

function lerp(a: number, b: number, t: number) {
    return a + (b - a) * t;
}

/**
 * Per-particle phase for the turbulence field, in [0, 1).
 *
 * Golden-ratio stride over the spawn index (maximally spread), offset by the emitter and playback
 * seeds so two casts of one spell do not wobble in step. Derived *without* consuming `rand()`: the
 * spawn table of every existing asset stays byte-identical when a producer adds a noise dynamic.
 * Layers fed by one emitter get the same index and the same seed, so stacked sprites (one Ryzom
 * located with several renderers) move as one particle, which is what they are.
 */
function noisePhase(index: number, seed: number) {
    return ((index + 1) * 0.6180339887498949 + (seed & 1023) * 0.0009765625) % 1;
}

/** Orthonormal basis around the emitter's `direction`, in the module scratch vectors. */
function basis(direction: [number, number, number]) {
    tmpUp.set(direction[0], direction[1], direction[2]);

    if (tmpUp.lengthSq() < 1e-8) tmpUp.set(0, 1, 0);
    tmpUp.normalize();

    // Pick a reference that is not parallel to `up`, or the cross product degenerates.
    if (Math.abs(tmpUp.y) > 0.999) tmpRef.set(1, 0, 0);
    else tmpRef.set(0, 1, 0);

    tmpTangent.copy(tmpRef).cross(tmpUp).normalize();
    tmpBitangent.copy(tmpUp).cross(tmpTangent).normalize();
}

/** Mirrors `emitterParticleCount` in `assets.ts` — kept inline here to stay object-free per emitter. */
function countOf(rate: number, burst: number, duration: number) {
    if (burst > 0) return Math.round(burst);
    if (rate <= 0) return 0;

    return Math.max(1, Math.round(rate * duration));
}

export type PlaybackInfo = {
    /** Arena key: `entityKey\u0000handle` — one playback, not one entity. */
    key: string;
    /** The entity this playback belongs to: what `transformOf` and the node resolver receive. */
    entityKey: string;
    /** The component handle the playback was started from (`ParticlePlayback.id`). */
    handle: number;
    asset: CompiledParticleAsset;
    /** Seconds on the same clock as `uTime`. */
    startedAt: number;
    endsAt: number;
    loop: boolean;
    seed: number;
    /** Instance slots the playback wrote, summed over its layers (already freed when this fires). */
    instances: number;
    /** How many layers owned an instance run. */
    layers: number;
};

/**
 * Playback bookkeeping — **no entities**.
 *
 * A playback is a slot in a structure-of-arrays arena: no objects, no component writes, no ids
 * allocated. The ECS sees one `rParticleFx` write at play, one at stop, and one when a playback is
 * retired (`playing: false`, written by the plugin so a finished entry does not read as a new
 * request); everything between is integer indices and typed-array writes.
 *
 * Slots are keyed by **(entity, handle)**, never by entity: one pawn runs a cast channel, a missile
 * and a hit burst as three independent slots with three independent lifetimes. `entityOf[slot]` keeps
 * the entity key that `transformOf` and the bone resolver are given, because a bone belongs to the
 * pawn and not to one of its effects.
 *
 * A slot owns **one instance run per layer that has emitters** (`runStart`/`runCount`/`poolOf` are
 * `maxLayers` entries per slot, indexed `slot * maxLayers + layer`), because each layer is its own
 * draw state and therefore its own pool. Multi-texture effects cost several draw calls but still one
 * slot, one pose allocation and one playback.
 *
 * `transformOf(key)` is resolved at spawn time (and again on each loop respawn) so a moving emitter
 * bakes a correct world-space spawn table without any per-particle state: particles that are
 * already alive stay where they were emitted, which is exactly what a trail should do.
 */
export class ParticleArena {
    readonly maxPlaybacks: number;

    private assetOf: (CompiledParticleAsset | undefined)[] = [];
    /** `slot * this.maxLayers + layer`; `undefined` when that layer has no run. */
    private poolOf: (ParticlePool | undefined)[];
    private keyOf: string[] = [];
    /** Entity key per slot — the argument for `transformOf` / `resolveNode`, not the arena key. */
    private entityOf: string[] = [];
    private handleOf: Int32Array;
    /**
     * Playback-level bone override, per slot (`ParticlePlayback.bone`): the bone every *bound* node
     * of the asset resolves against instead of its own. Empty = the asset's own bones.
     */
    private boneOf: (string | undefined)[] = [];
    /** Per slot: bake the bone matrix into the spawn table instead of sampling the pose ring. */
    private bakeOf: boolean[] = [];
    private startedAt: Float64Array;
    private endsAt: Float64Array;
    /** Absolute end of a looping playback's `seconds` window; 0 = unbounded (loops forever). */
    private deadline: Float64Array;
    private loops: Uint8Array;
    private seeds: Int32Array;
    private runStart: Int32Array;
    private runCount: Int32Array;
    private alive: Uint8Array;
    private free: Int32Array;
    private freeTop = 0;
    private slotOfKey = new Map<string, number>();
    /** Pose-ring slot per (playback × asset node); -1 when unbound or unavailable. */
    private poseSlots: Int32Array;
    /** Diagnostics: how many times each slot's spawn table was (re)written. */
    private spawnWrites: Int32Array;
    /** Diagnostics: the oldest and newest `birthAt` in the last write, as offsets from it. */
    private birthOldest: Float32Array;
    private birthNewest: Float32Array;

    /** Live instance total, for the budget system. */
    totalInstances = 0;
    /** Live playback total. */
    totalPlaybacks = 0;
    /** Called when a playback is retired, for audio/UI hang-offs. */
    onFinished?: (info: PlaybackInfo) => void;
    /**
     * Called once per (entity, bone) that a resolver never resolved. Silent failure here looks like
     * "nothing rendered", so the plugin surfaces it instead of leaving it to guesswork.
     */
    onMissingNode?: (entityKey: string, bone: string) => void;

    private readonly reportedMissing = new Set<string>();

    // Explicit fields, not parameter properties: node's strip-only loader rejects the latter and the
    // particle sanity scripts import real modules (`PoseTable`, and now `ParticlePool`).
    private readonly pools: ParticlePoolRegistry;
    private readonly transformOf: (key: string) => Matrix4 | null;
    private readonly textureFactory: (layer: CompiledLayer) => Texture;
    private readonly pose: PoseTable;
    readonly resolveNode: ParticleNodeResolver | null;
    /** Draw layers one playback can own (see the plugin's `maxLayers` option). */
    readonly maxLayers: number;
    /** Bound nodes one asset may carry (see the plugin's `maxNodes` option). */
    readonly maxNodesPerAsset: number;

    constructor(
        pools: ParticlePoolRegistry,
        transformOf: (key: string) => Matrix4 | null,
        textureFactory: (layer: CompiledLayer) => Texture,
        pose: PoseTable,
        resolveNode: ParticleNodeResolver | null,
        maxPlaybacks = 256,
        maxLayers = DEFAULT_MAX_LAYERS,
        maxNodesPerAsset = DEFAULT_NODES_PER_ASSET
    ) {
        this.maxLayers = Math.max(1, Math.floor(maxLayers));
        this.maxNodesPerAsset = Math.max(1, Math.floor(maxNodesPerAsset));
        this.pools = pools;
        this.transformOf = transformOf;
        this.textureFactory = textureFactory;
        this.pose = pose;
        this.resolveNode = resolveNode;
        this.maxPlaybacks = maxPlaybacks;
        this.startedAt = new Float64Array(maxPlaybacks);
        this.endsAt = new Float64Array(maxPlaybacks);
        this.deadline = new Float64Array(maxPlaybacks);
        this.handleOf = new Int32Array(maxPlaybacks);
        this.loops = new Uint8Array(maxPlaybacks);
        this.seeds = new Int32Array(maxPlaybacks);
        this.runStart = new Int32Array(maxPlaybacks * this.maxLayers);
        this.runCount = new Int32Array(maxPlaybacks * this.maxLayers);
        this.poolOf = new Array<ParticlePool | undefined>(maxPlaybacks * this.maxLayers).fill(
            undefined
        );
        this.alive = new Uint8Array(maxPlaybacks);
        this.free = new Int32Array(maxPlaybacks);
        this.poseSlots = new Int32Array(maxPlaybacks * this.maxNodesPerAsset).fill(-1);
        this.spawnWrites = new Int32Array(maxPlaybacks);
        this.birthOldest = new Float32Array(maxPlaybacks);
        this.birthNewest = new Float32Array(maxPlaybacks);

        for (let i = 0; i < maxPlaybacks; i++) this.free[i] = maxPlaybacks - 1 - i;
        this.freeTop = maxPlaybacks;
    }

    has(key: string) {
        return this.slotOfKey.has(key);
    }

    slotOf(key: string) {
        return this.slotOfKey.get(key);
    }

    /**
     * Starts (or restarts) one playback. Keyed by `(entityKey, handle)`; returns false when it could not
     * be allocated.
     *
     * `seconds` is the playback's lifetime, 0 meaning the asset's own `duration + maxLife`. A looping
     * playback respawns in place every natural cycle but never past that window, so `loop: true` with
     * `seconds: 0.6` on a 31 s held state is a 0.6 s effect, not a 31 s one (`playbacks.ts` documents
     * the rule; this is where it becomes two numbers).
     *
     * `bone` is the playback-level override (`ParticlePlayback.bone`): every node the asset binds
     * resolves against it instead of its own bone, so one baked right-hand cast effect can play on
     * the left hand. Nothing in the asset changes — the arena simply asks
     * `playbacks.resolvedNodeBone` instead of reading `node.bone` directly.
     */
    play(
        entityKey: string,
        handle: number,
        asset: CompiledParticleAsset,
        now: number,
        seed = 0,
        loop = false,
        seconds = 0,
        bone?: string,
        attachMode?: 'pose' | 'bake'
    ): boolean {
        const key = playbackKey(entityKey, handle);

        this.stopKey(key);

        const slot = this.takeSlot();
        if (slot < 0) return false;

        const base = slot * this.maxLayers;

        // One run per layer that emits, each in that layer's own pool. A failure anywhere releases
        // what has already been reserved, so a half-allocated playback never leaks a run.
        for (let layer = 0; layer < asset.layers.length; layer++) {
            const compiled = asset.layers[layer];

            if (compiled.emitterCount === 0 || compiled.maxInstances <= 0) continue;

            const pool = this.acquirePool(compiled, compiled.maxInstances);
            const runStart = pool ? pool.reserve(compiled.maxInstances) : -1;

            if (!pool || runStart < 0) {
                this.releaseRuns(slot);
                this.releaseSlot(slot);

                return false;
            }

            this.poolOf[base + layer] = pool;
            this.runStart[base + layer] = runStart;
            this.runCount[base + layer] = compiled.maxInstances;
            this.totalInstances += compiled.maxInstances;
        }

        // A one-shot always ends when its own particles do; a loop's window bounds the repetition.
        const natural = asset.duration + asset.maxLife;
        const window = playbackWindow(
            { id: handle, asset: asset.id, playing: true, loop, seconds },
            natural,
            now
        );

        this.assetOf[slot] = asset;
        this.keyOf[slot] = key;
        this.entityOf[slot] = entityKey;
        this.handleOf[slot] = handle;
        this.startedAt[slot] = now;
        this.loops[slot] = loop ? 1 : 0;
        this.seeds[slot] = seed;
        this.alive[slot] = 1;
        this.deadline[slot] = window.deadline;
        this.endsAt[slot] = window.endsAt;
        this.boneOf[slot] = bone;
        this.bakeOf[slot] = bakesAttachment(attachMode);

        this.slotOfKey.set(key, slot);
        this.totalPlaybacks++;

        this.allocatePoseSlots(slot, asset);

        /**
         * **Resolve the attached nodes once, before the first spawn.**
         *
         * An attached emitter authors in *node* space and lets the vertex shader apply the pose at
         * each particle's own birth time. The spawn table written below therefore does not carry the
         * bone matrix itself — it carries the birth time, and the shader samples the pose ring for
         * it. On the frame a playback starts, that ring has **no entry for these slots yet** (the
         * first `updatePoses` runs on the next tick), so the sample reads the zeroed texture and the
         * whole burst lands at the world origin instead of in the hand. That is the bug the first
         * playtest reported as "everything is in the crotch": a one-shot never gets a second chance,
         * because its only spawn is this one.
         *
         * `PoseTable.write`'s first write fills the node's whole history, so priming here makes the
         * sample valid for every particle of the first cycle, not just its first frame.
         */
        this.primePose(slot, now);

        this.writeRun(slot, now);

        return true;
    }

    /**
     * Write this playback's attached nodes into the pose ring at `now`.
     *
     * Extracted from `updatePoses` (which loops every live playback) so `play` can prime a single
     * slot; the resolution rules are identical by construction because both call `resolveNode` with
     * the same `nodeBone`/`poseSlots` pairs.
     */
    private primePose(slot: number, now: number) {
        if (!this.resolveNode) return;

        const asset = this.assetOf[slot];
        if (!asset) return;

        const key = this.entityOf[slot];
        const base = slot * this.maxNodesPerAsset;

        this.pose.beginFrame(now);

        for (let i = 0; i < asset.nodes.length && i < this.maxNodesPerAsset; i++) {
            const nodeSlot = this.poseSlots[base + i];
            const bone = this.nodeBone(slot, i);
            if (nodeSlot < 0 || !bone) continue;
            if (this.resolveNode(key, bone, resolvedNode)) this.pose.write(nodeSlot, resolvedNode);
        }

        this.pose.endFrame();
    }

    stop(slot: number) {
        if (!this.alive[slot]) return;

        this.releasePoseSlots(slot);
        this.releaseRuns(slot);

        const key = this.keyOf[slot];
        if (this.slotOfKey.get(key) === slot) this.slotOfKey.delete(key);

        this.totalPlaybacks--;
        this.alive[slot] = 0;
        this.assetOf[slot] = undefined;
        this.keyOf[slot] = '';
        this.entityOf[slot] = '';
        this.deadline[slot] = 0;
        this.boneOf[slot] = undefined;

        this.releaseSlot(slot);
    }

    /** Frees every layer run a playback owns and takes it off `totalInstances`. */
    private releaseRuns(slot: number) {
        const base = slot * this.maxLayers;

        for (let layer = 0; layer < this.maxLayers; layer++) {
            const pool = this.poolOf[base + layer];

            if (!pool) continue;

            pool.release(this.runStart[base + layer], this.runCount[base + layer]);

            this.totalInstances -= this.runCount[base + layer];
            this.poolOf[base + layer] = undefined;
            this.runStart[base + layer] = 0;
            this.runCount[base + layer] = 0;
        }
    }

    stopKey(key: string) {
        const slot = this.slotOfKey.get(key);
        if (slot !== undefined) this.stop(slot);
    }

    /**
     * Frees every playback of an entity, at once. A linear scan (256 slots) because entity teardown is
     * rare and a second `Map<entityKey, Set<key>>` would allocate per play to save nothing.
     */
    stopEntity(entityKey: string) {
        for (let slot = 0; slot < this.maxPlaybacks; slot++) {
            if (this.alive[slot] && this.entityOf[slot] === entityKey) this.stop(slot);
        }
    }

    /**
     * Handles this entity currently holds, written into `out` (a caller-owned scratch array, so the
     * reconcile pass allocates nothing). This is the authority on "what is actually playing", as
     * opposed to "what the component last asked for" — the two differ after a budget eviction.
     */
    handlesOf(entityKey: string, out: number[]): number[] {
        out.length = 0;

        for (let slot = 0; slot < this.maxPlaybacks; slot++) {
            if (this.alive[slot] && this.entityOf[slot] === entityKey) out.push(this.handleOf[slot]);
        }

        return out;
    }

    /**
     * Retires finished playbacks and respawns looping ones in place (no allocation).
     *
     * Pose resolution runs first, once per bound node per playback per frame — the cost is
     * `playbacks × bound nodes`, not `particles`. The result is what lets every attached particle ask
     * the vertex shader for "your matrix at time t".
     */
    tick(now: number) {
        this.updatePoses(now);

        for (let slot = 0; slot < this.maxPlaybacks; slot++) {
            if (!this.alive[slot] || now < this.endsAt[slot]) continue;

            const asset = this.assetOf[slot]!;

            // A loop ends only by its window: `endsAt` is capped at `deadline`, so reaching it *is*
            // the last cycle. Without this test a windowed loop respawns forever `Min(cycle, deadline)`
            // always resolves to the past deadline — which is the exact leak the ledger used to hide.
            const windowed = this.deadline[slot] > 0 && now >= this.deadline[slot];

            if (this.loops[slot] && !windowed) {
                // Re-spawn in the same runs: one upload per cycle, nothing on the frame's other 99 %.
                this.endsAt[slot] = nextCycleEnd(
                    now,
                    asset.duration + asset.maxLife,
                    this.deadline[slot]
                );
                this.startedAt[slot] = now;
                this.writeRun(slot, now);
                continue;
            }

            const info: PlaybackInfo = {
                key: this.keyOf[slot],
                entityKey: this.entityOf[slot],
                handle: this.handleOf[slot],
                asset,
                startedAt: this.startedAt[slot],
                endsAt: this.endsAt[slot],
                loop: this.loops[slot] === 1,
                seed: this.seeds[slot],
                instances: this.instancesOf(slot),
                layers: this.layersOf(slot),
            };

            this.stop(slot);
            this.onFinished?.(info);
        }
    }

    private allocatePoseSlots(slot: number, asset: CompiledParticleAsset) {
        const base = slot * this.maxNodesPerAsset;

        for (let i = 0; i < this.maxNodesPerAsset; i++) this.poseSlots[base + i] = -1;

        if (!this.resolveNode) return;

        for (let i = 0; i < asset.nodes.length && i < this.maxNodesPerAsset; i++) {
            // A node needs a pose slot when it is *attached*, and `nodeBone` is the answer to that:
            // the playback's override if it has one, else the asset's own bone, `null` for a free
            // node. Reading `asset.nodes[i].bone` here would give a re-pointed node no slot at all.
            if (!this.nodeBone(slot, i)) continue;
            this.poseSlots[base + i] = this.pose.allocate();
        }
    }

    /**
     * The bone a playback resolves for one asset node — the playback's override, else the asset's
     * own, `null` for a free node. The single place the arena makes that decision.
     */
    private nodeBone(slot: number, nodeIndex: number): string | null {
        const node = this.assetOf[slot]?.nodes[nodeIndex];

        // An out-of-range index is "no node", not "attach the override": the pose-slot lookup below
        // indexes by the same number and would read a neighbouring playback's slot.
        if (!node) return null;

        return resolvedNodeBone(this.boneOf[slot], node.bone);
    }

    private releasePoseSlots(slot: number) {
        const base = slot * this.maxNodesPerAsset;

        for (let i = 0; i < this.maxNodesPerAsset; i++) {
            const node = this.poseSlots[base + i];
            if (node >= 0) this.pose.release(node);
            this.poseSlots[base + i] = -1;
        }
    }

    private updatePoses(now: number) {
        if (!this.resolveNode) return;

        this.pose.beginFrame(now);

        for (let slot = 0; slot < this.maxPlaybacks; slot++) {
            if (!this.alive[slot]) continue;

            const asset = this.assetOf[slot]!;
            const key = this.entityOf[slot];
            const base = slot * this.maxNodesPerAsset;

            for (let i = 0; i < asset.nodes.length && i < this.maxNodesPerAsset; i++) {
                const nodeSlot = this.poseSlots[base + i];
                const bone = this.nodeBone(slot, i);

                if (nodeSlot < 0 || !bone) continue;

                // A failed resolve keeps the previous pose instead of snapping to the origin: a
                // bone that briefly disappears should freeze its trail, not teleport it.
                if (this.resolveNode(key, bone, resolvedNode)) {
                    this.pose.write(nodeSlot, resolvedNode);
                    continue;
                }

                const reportKey = `${key}\u0000${bone}`;

                if (!this.reportedMissing.has(reportKey)) {
                    this.reportedMissing.add(reportKey);
                    this.onMissingNode?.(key, bone);
                }
            }
        }

        this.pose.endFrame();
    }

    /** Oldest live playback on a given pool — the eviction candidate when that pool is full. */
    oldestSlotOn(pool: ParticlePool): number {
        let oldest = -1;

        for (let slot = 0; slot < this.maxPlaybacks; slot++) {
            if (!this.alive[slot] || !this.usesPool(slot, pool)) continue;
            if (oldest === -1 || this.startedAt[slot] < this.startedAt[oldest]) oldest = slot;
        }

        return oldest;
    }

    private usesPool(slot: number, pool: ParticlePool) {
        const base = slot * this.maxLayers;

        for (let layer = 0; layer < this.maxLayers; layer++) {
            if (this.poolOf[base + layer] === pool) return true;
        }

        return false;
    }

    /** Instance slots a playback owns, summed over its layer runs. */
    private instancesOf(slot: number) {
        const base = slot * this.maxLayers;
        let instances = 0;

        for (let layer = 0; layer < this.maxLayers; layer++) instances += this.runCount[base + layer];

        return instances;
    }

    /** How many layers of a playback own a run. */
    private layersOf(slot: number) {
        const base = slot * this.maxLayers;
        let layers = 0;

        for (let layer = 0; layer < this.maxLayers; layer++) {
            if (this.runCount[base + layer] > 0) layers++;
        }

        return layers;
    }

    /** Oldest live playback, period (global budget eviction). */
    oldestSlot(): number {
        let oldest = -1;

        for (let slot = 0; slot < this.maxPlaybacks; slot++) {
            if (!this.alive[slot]) continue;
            if (oldest === -1 || this.startedAt[slot] < this.startedAt[oldest]) oldest = slot;
        }

        return oldest;
    }

    infoOf(slot: number): PlaybackInfo | undefined {
        if (!this.alive[slot]) return undefined;

        return {
            key: this.keyOf[slot],
            entityKey: this.entityOf[slot],
            handle: this.handleOf[slot],
            asset: this.assetOf[slot]!,
            startedAt: this.startedAt[slot],
            endsAt: this.endsAt[slot],
            loop: this.loops[slot] === 1,
            seed: this.seeds[slot],
            instances: this.instancesOf(slot),
            layers: this.layersOf(slot),
        };
    }

    /** Reserves a pool for one layer run, retiring the oldest occupant of a full one first. */
    private acquirePool(
        layer: CompiledLayer,
        instances: number
    ): ParticlePool | undefined {
        let pool = this.pools.acquire(layer, instances, () => this.textureFactory(layer));

        if (!pool) return undefined;

        let guard = 0;

        // A full pool is the expected steady state in a busy fight: retry the oldest victim rather
        // than dropping the newest spell (newest is what the player just pressed).
        //
        // **This stop does not write `playing: false` back to the component**, unlike the two ends in
        // `index.ts`: it is unreachable today (`pools.acquire` only returns a pool that already has
        // room, so the loop never runs), and routing it through `finishPlayback` would need the
        // entity key the arena deliberately does not keep at this level. If pool sizing ever changes
        // so a full pool is returned, that is the fix — do not paper over a replayed victim.
        while (pool.capacity - pool.usedInstances < instances && guard++ < this.maxPlaybacks) {
            const victim = this.oldestSlotOn(pool);
            if (victim < 0) break;
            this.stop(victim);
        }

        if (pool.capacity - pool.usedInstances >= instances) return pool;

        // Still no room (the pool is empty but too small): the registry adds a second pool.
        pool = this.pools.acquire(layer, instances, () => this.textureFactory(layer));

        return pool && pool.capacity >= instances ? pool : undefined;
    }

    /**
     * The spawn table, layer by layer. Everything below is deterministic from
     * `(asset, emitter.seed, playback seed)` and writes straight into the pool's attribute arrays —
     * no intermediate arrays, no garbage.
     */
    private writeRun(slot: number, baseTime: number) {
        const asset = this.assetOf[slot]!;
        const playbackSeed = this.seeds[slot] || 1;

        this.spawnWrites[slot]++;
        this.birthOldest[slot] = 0;
        this.birthNewest[slot] = 0;

        for (let layerIndex = 0; layerIndex < asset.layers.length; layerIndex++) {
            this.writeLayer(slot, asset.layers[layerIndex], layerIndex, baseTime, playbackSeed);
        }
    }

    /** One layer's run: its own emitters, in that layer's own pool, then one upload. */
    private writeLayer(
        slot: number,
        layer: CompiledLayer,
        layerIndex: number,
        baseTime: number,
        playbackSeed: number
    ) {
        const asset = this.assetOf[slot]!;
        const run = slot * this.maxLayers + layerIndex;
        const pool = this.poolOf[run];

        if (!pool) return;

        const key = this.entityOf[slot];
        const effectMatrix = this.transformOf(key) ?? IDENTITY;
        const poseBase = slot * this.maxNodesPerAsset;

        const runStart = this.runStart[run];
        const runEnd = runStart + this.runCount[run];
        const segments = layer.segments;

        let index = runStart;

        for (let e = layer.emitterStart; e < layer.emitterStart + layer.emitterCount; e++) {
            const emitter = asset.emitters[e];
            const count = countOf(emitter.rate, emitter.burst, emitter.duration);
            if (count <= 0) continue;

            seedRng(Math.imul(emitter.seed ^ playbackSeed, 2654435761));
            basis(emitter.direction);

            const node = asset.nodes[emitter.nodeIndex] ?? asset.nodes[0];
            // Attached at all? The same rule the pose ring uses, so a node cannot be attached for
            // the pose pass and free for the spawn pass (or the reverse).
            const bone = this.nodeBone(slot, emitter.nodeIndex);
            let nodeSlot = bone ? this.poseSlots[poseBase + emitter.nodeIndex] : -1;

            // Attached emitters author in *node* space and let the shader apply the pose ring at each
            // particle's own time. Free emitters bake world space once, here.
            if (nodeSlot >= 0 && this.bakeOf[slot]) {
                // Bake mode: resolve the bone **now** and store the particle as free. No ring, no
                // per-particle pose sampling — the emitter gives birth and the particle is then an
                // independent world-space thing, which is the only shape that cannot follow the bone.
                if (this.resolveNode && this.resolveNode(key, bone!, resolvedNode)) {
                    nodeMatrix.fromArray(node.matrix).premultiply(resolvedNode);
                    nodeSlot = -1;
                } else {
                    // Unresolvable bone: fall back to the pose path rather than to the effect origin.
                    nodeMatrix.fromArray(node.matrix);
                }
            } else if (nodeSlot >= 0) {
                nodeMatrix.fromArray(node.matrix);
            } else {
                nodeMatrix.fromArray(node.matrix).premultiply(effectMatrix);
            }
            tmpExtent.set(emitter.extent[0], emitter.extent[1], emitter.extent[2]);

            for (let i = 0; i < count; i++) {
                const azimuth = lerp(emitter.azimuth[0], emitter.azimuth[1], rand());
                const elevation = lerp(emitter.elevation[0], emitter.elevation[1], rand());
                const cosEl = Math.cos(elevation);

                // Direction in the emitter's local basis.
                tmpDir
                    .copy(tmpTangent)
                    .multiplyScalar(cosEl * Math.cos(azimuth))
                    .addScaledVector(tmpBitangent, cosEl * Math.sin(azimuth))
                    .addScaledVector(tmpUp, Math.sin(elevation));

                tmpPos.set(0, 0, 0);

                if (emitter.shape === 'rectangle') {
                    tmpPos
                        .addScaledVector(tmpTangent, (rand() - 0.5) * emitter.extent[0])
                        .addScaledVector(tmpBitangent, (rand() - 0.5) * emitter.extent[1])
                        .addScaledVector(tmpUp, (rand() - 0.5) * emitter.extent[2]);
                } else if (emitter.shape === 'sphere' || emitter.shape === 'radial') {
                    tmpPos.copy(tmpDir).multiply(tmpExtent);
                }

                const birthAt =
                    baseTime + (emitter.duration > 0 ? (i / count) * emitter.duration : 0);
                // Offsets from the write time, so the diagnostic reads as "-6.5…0 s ago".
                const birthOffset = birthAt - baseTime;
                if (birthOffset < this.birthOldest[slot]) this.birthOldest[slot] = birthOffset;
                if (birthOffset > this.birthNewest[slot]) this.birthNewest[slot] = birthOffset;
                const life = lerp(emitter.life[0], emitter.life[1], rand());
                const speed = lerp(emitter.velocity[0], emitter.velocity[1], rand());
                const sizeX = lerp(emitter.size[0], emitter.size[1], rand());
                const sizeY = lerp(emitter.size[0], emitter.size[1], rand());
                const angle = lerp(emitter.angle[0], emitter.angle[1], rand());
                const spin = lerp(emitter.spin[0], emitter.spin[1], rand());
                const sprite =
                    emitter.sprites.length > 0
                        ? emitter.sprites[i % emitter.sprites.length]
                        : Math.min(layer.spriteCount - 1, Math.floor(rand() * layer.spriteCount));

                // A radial emitter pushes outward from its surface point.
                if (emitter.shape === 'radial' && tmpPos.lengthSq() > 1e-8) {
                    tmpDir.copy(tmpPos).normalize();
                }

                tmpAccel.set(
                    emitter.acceleration[0],
                    emitter.acceleration[1],
                    emitter.acceleration[2]
                );

                // Local → world, baked once: particles already alive must not follow the emitter.
                tmpPos.applyMatrix4(nodeMatrix);
                tmpDir.transformDirection(nodeMatrix);
                tmpAccel.transformDirection(nodeMatrix);

                scratch.p0x = tmpPos.x;
                scratch.p0y = tmpPos.y;
                scratch.p0z = tmpPos.z;
                scratch.life = life;
                scratch.v0x = tmpDir.x * speed;
                scratch.v0y = tmpDir.y * speed;
                scratch.v0z = tmpDir.z * speed;
                scratch.bornAt = birthAt;
                scratch.sizeX = sizeX;
                scratch.sizeY = sizeY;
                scratch.angle = angle;
                scratch.spin = spin;
                scratch.sprite = sprite;
                scratch.segments = segments;
                scratch.segmentDelay = life / segments;
                scratch.tailFade = layer.tailFade ? 1 : 0;
                scratch.ax = tmpAccel.x;
                scratch.ay = tmpAccel.y;
                scratch.az = tmpAccel.z;
                scratch.drag = emitter.drag;
                scratch.nodeId = nodeSlot;
                scratch.noiseAmplitude = layer.noiseAmplitude;
                scratch.noiseFrequency = layer.noiseFrequency;
                scratch.noiseSeed = noisePhase(i, emitter.seed ^ playbackSeed);
                scratch.curveSizeX = layer.curveRows.sizeX;
                scratch.curveAlpha = layer.curveRows.alpha;
                scratch.curveColor = layer.curveRows.color;
                scratch.r = emitter.color[0];
                scratch.g = emitter.color[1];
                scratch.b = emitter.color[2];
                scratch.a = 1;

                for (let segment = 0; segment < segments; segment++) {
                    if (index >= runEnd) break;
                    scratch.segment = segment;
                    pool.writeInstance(index++, scratch);
                }

                if (index >= runEnd) break;
            }

            if (index >= runEnd) break;
        }

        // Slots the authored counts did not fill die immediately (life 0), so a mis-sized budget
        // clamp shows as a thinner effect rather than as garbage quads.
        while (index < runEnd) pool.writeInstance(index++, deadScratch);

        // One upload per layer run, so a respawn is one `bufferSubData` per attribute per layer.
        pool.flush(runStart, this.runCount[run]);
    }

    /**
     * Spawn-table diagnostics for one entity's live playbacks — *not* a frame-path cost.
     *
     * Added because "the particles follow the emitter" has three possible causes and only one of them
     * is in the shader: a re-primed pose ring, a spawn table rewritten every frame, or live pose
     * sampling. `writes` climbing means the table is being re-baked; `now - oldestBirth` growing past
     * the ring window means the birth frames are gone; a flat `writes` with births stayed put means the
     * animation is right and the impression came from the stream itself.
     */
    diagnostics(entityKey: string, now: number) {
        const rows = [];

        for (let slot = 0; slot < this.maxPlaybacks; slot++) {
            if (!this.alive[slot] || this.entityOf[slot] !== entityKey) continue;

            const asset = this.assetOf[slot]!;
            let boundNodes = 0;
            for (let i = 0; i < asset.nodes.length; i++) if (this.nodeBone(slot, i)) boundNodes++;

            rows.push({
                key: this.keyOf[slot],
                asset: asset.id,
                writes: this.spawnWrites[slot],
                oldestBirthAgo: now - (this.startedAt[slot] + this.birthOldest[slot]),
                newestBirthAgo: now - (this.startedAt[slot] + this.birthNewest[slot]),
                age: now - this.startedAt[slot],
                boundNodes,
                /** Ring primes since boot: one per allocation is normal, per frame is the bug. */
                ringPrimes: this.pose.primes,
                poseSlots: (() => {
                    let live = 0;
                    const base = slot * this.maxNodesPerAsset;
                    for (let i = 0; i < this.maxNodesPerAsset; i++) if (this.poseSlots[base + i] >= 0) live++;
                    return live;
                })(),
            });
        }

        return rows;
    }

    private takeSlot() {
        if (this.freeTop <= 0) return -1;

        return this.free[--this.freeTop];
    }

    private releaseSlot(slot: number) {
        this.free[this.freeTop++] = slot;
    }
}
