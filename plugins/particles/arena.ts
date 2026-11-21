import { Matrix4, Texture, Vector3 } from 'three';
import type { CompiledLayer, CompiledParticleAsset } from './schema';
import { MAX_LAYERS } from './schema';
import type { PoseTable } from './pose';
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

/** Pose slots are indexed per asset node, so this caps bound nodes per effect. */
const MAX_NODES_PER_ASSET = 8;

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
    /** Entity key the playback belongs to (see `transformOf`). */
    key: string;
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
 * allocated. The ECS sees one `rParticleFx` write at play and one at stop; everything between is
 * integer indices and typed-array writes.
 *
 * A slot owns **one instance run per layer that has emitters** (`runStart`/`runCount`/`poolOf` are
 * `MAX_LAYERS` entries per slot, indexed `slot * MAX_LAYERS + layer`), because each layer is its own
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
    /** `slot * MAX_LAYERS + layer`; `undefined` when that layer has no run. */
    private poolOf: (ParticlePool | undefined)[];
    private keyOf: string[] = [];
    private startedAt: Float64Array;
    private endsAt: Float64Array;
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

    constructor(
        private readonly pools: ParticlePoolRegistry,
        private readonly transformOf: (key: string) => Matrix4 | null,
        private readonly textureFactory: (layer: CompiledLayer) => Texture,
        private readonly pose: PoseTable,
        private readonly resolveNode: ParticleNodeResolver | null,
        maxPlaybacks = 256
    ) {
        this.maxPlaybacks = maxPlaybacks;
        this.startedAt = new Float64Array(maxPlaybacks);
        this.endsAt = new Float64Array(maxPlaybacks);
        this.loops = new Uint8Array(maxPlaybacks);
        this.seeds = new Int32Array(maxPlaybacks);
        this.runStart = new Int32Array(maxPlaybacks * MAX_LAYERS);
        this.runCount = new Int32Array(maxPlaybacks * MAX_LAYERS);
        this.poolOf = new Array<ParticlePool | undefined>(maxPlaybacks * MAX_LAYERS).fill(
            undefined
        );
        this.alive = new Uint8Array(maxPlaybacks);
        this.free = new Int32Array(maxPlaybacks);
        this.poseSlots = new Int32Array(maxPlaybacks * MAX_NODES_PER_ASSET).fill(-1);

        for (let i = 0; i < maxPlaybacks; i++) this.free[i] = maxPlaybacks - 1 - i;
        this.freeTop = maxPlaybacks;
    }

    has(key: string) {
        return this.slotOfKey.has(key);
    }

    slotOf(key: string) {
        return this.slotOfKey.get(key);
    }

    /** Starts (or restarts) the playback for `key`. Returns false when it could not be allocated. */
    play(
        key: string,
        asset: CompiledParticleAsset,
        now: number,
        seed = 0,
        loop = false
    ): boolean {
        this.stopKey(key);

        const slot = this.takeSlot();
        if (slot < 0) return false;

        const base = slot * MAX_LAYERS;

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

        this.assetOf[slot] = asset;
        this.keyOf[slot] = key;
        this.startedAt[slot] = now;
        this.loops[slot] = loop ? 1 : 0;
        this.seeds[slot] = seed;
        this.alive[slot] = 1;
        this.endsAt[slot] = now + asset.duration + asset.maxLife;

        this.slotOfKey.set(key, slot);
        this.totalPlaybacks++;

        this.allocatePoseSlots(slot, asset);

        this.writeRun(slot, now);

        return true;
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

        this.releaseSlot(slot);
    }

    /** Frees every layer run a playback owns and takes it off `totalInstances`. */
    private releaseRuns(slot: number) {
        const base = slot * MAX_LAYERS;

        for (let layer = 0; layer < MAX_LAYERS; layer++) {
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

            if (this.loops[slot]) {
                // Re-spawn in the same runs: one upload per cycle, nothing on the frame's other 99 %.
                this.endsAt[slot] = now + asset.duration + asset.maxLife;
                this.startedAt[slot] = now;
                this.writeRun(slot, now);
                continue;
            }

            const info: PlaybackInfo = {
                key: this.keyOf[slot],
                asset,
                startedAt: this.startedAt[slot],
                endsAt: this.endsAt[slot],
                loop: false,
                seed: this.seeds[slot],
                instances: this.instancesOf(slot),
                layers: this.layersOf(slot),
            };

            this.stop(slot);
            this.onFinished?.(info);
        }
    }

    private allocatePoseSlots(slot: number, asset: CompiledParticleAsset) {
        const base = slot * MAX_NODES_PER_ASSET;

        for (let i = 0; i < MAX_NODES_PER_ASSET; i++) this.poseSlots[base + i] = -1;

        if (!this.resolveNode) return;

        for (let i = 0; i < asset.nodes.length && i < MAX_NODES_PER_ASSET; i++) {
            if (!asset.nodes[i].bone) continue;
            this.poseSlots[base + i] = this.pose.allocate();
        }
    }

    private releasePoseSlots(slot: number) {
        const base = slot * MAX_NODES_PER_ASSET;

        for (let i = 0; i < MAX_NODES_PER_ASSET; i++) {
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
            const key = this.keyOf[slot];
            const base = slot * MAX_NODES_PER_ASSET;

            for (let i = 0; i < asset.nodes.length && i < MAX_NODES_PER_ASSET; i++) {
                const nodeSlot = this.poseSlots[base + i];
                const bone = asset.nodes[i].bone;

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
        const base = slot * MAX_LAYERS;

        for (let layer = 0; layer < MAX_LAYERS; layer++) {
            if (this.poolOf[base + layer] === pool) return true;
        }

        return false;
    }

    /** Instance slots a playback owns, summed over its layer runs. */
    private instancesOf(slot: number) {
        const base = slot * MAX_LAYERS;
        let instances = 0;

        for (let layer = 0; layer < MAX_LAYERS; layer++) instances += this.runCount[base + layer];

        return instances;
    }

    /** How many layers of a playback own a run. */
    private layersOf(slot: number) {
        const base = slot * MAX_LAYERS;
        let layers = 0;

        for (let layer = 0; layer < MAX_LAYERS; layer++) {
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
        const run = slot * MAX_LAYERS + layerIndex;
        const pool = this.poolOf[run];

        if (!pool) return;

        const effectMatrix = this.transformOf(this.keyOf[slot]) ?? IDENTITY;
        const poseBase = slot * MAX_NODES_PER_ASSET;

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
            const nodeSlot = node.bone ? this.poseSlots[poseBase + emitter.nodeIndex] : -1;

            // Attached emitters author in *node* space and let the shader apply the pose ring at each
            // particle's own time. Free emitters bake world space once, here.
            if (nodeSlot >= 0) {
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

    private takeSlot() {
        if (this.freeTop <= 0) return -1;

        return this.free[--this.freeTop];
    }

    private releaseSlot(slot: number) {
        this.free[this.freeTop++] = slot;
    }
}
