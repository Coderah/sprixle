import {
    AdditiveBlending,
    BufferAttribute,
    DataTexture,
    DoubleSide,
    DynamicDrawUsage,
    InstancedBufferAttribute,
    InstancedBufferGeometry,
    LinearFilter,
    LinearMipmapLinearFilter,
    Mesh,
    MultiplyBlending,
    NormalBlending,
    RGBAFormat,
    ShaderMaterial,
    SRGBColorSpace,
    Texture,
    TextureLoader,
    Vector2,
} from 'three';
import type { CompiledLayer, ParticleBlend } from './schema';
import type { PoseTable } from './pose';
import { particleFragmentShader, particleVertexShader } from './shaders';
import type { CurveAtlas } from './curves';

const BLOCK_SIZE = 32;

/** Mutable instance row written by the spawner. One scratch object for the whole app — see §8 of
 * `Sprixle Docs/particles.md`: the hot path allocates nothing, so this shape must not be `new`ed
 * per particle. */
export type InstanceScratch = {
    p0x: number;
    p0y: number;
    p0z: number;
    life: number;
    v0x: number;
    v0y: number;
    v0z: number;
    bornAt: number;
    sizeX: number;
    sizeY: number;
    angle: number;
    spin: number;
    sprite: number;
    /** Pose-ring slot for a bone-bound emitter, or -1 for a free particle. */
    nodeId: number;
    segment: number;
    segments: number;
    segmentDelay: number;
    tailFade: number;
    ax: number;
    ay: number;
    az: number;
    drag: number;
    /** Turbulence: displacement amplitude (m), base-octave frequency (cycles/s), per-particle phase. */
    noiseAmplitude: number;
    noiseFrequency: number;
    noiseSeed: number;
    curveSizeX: number;
    curveAlpha: number;
    curveColor: number;
    r: number;
    g: number;
    b: number;
    a: number;
};

export function createInstanceScratch(): InstanceScratch {
    return {
        p0x: 0, p0y: 0, p0z: 0, life: 1,
        v0x: 0, v0y: 0, v0z: 0, bornAt: 0,
        sizeX: 1, sizeY: 1, angle: 0, spin: 0,
        sprite: 0, nodeId: -1, segment: 0, segments: 1, segmentDelay: 0, tailFade: 1,
        ax: 0, ay: 0, az: 0, drag: 0,
        noiseAmplitude: 0, noiseFrequency: 1, noiseSeed: 0,
        curveSizeX: 0, curveAlpha: 0, curveColor: 0,
        r: 1, g: 1, b: 1, a: 1,
    };
}

/** Per-instance bytes: 8 × vec4 float + 1 × vec4 u8 = 132. */
const INSTANCE_BYTES = 4 * 4 * 8 + 4;

function roundUpToBlock(value: number) {
    return Math.max(BLOCK_SIZE, Math.ceil(value / BLOCK_SIZE) * BLOCK_SIZE);
}

/**
 * One draw call's worth of particles, built from one compiled *layer* (`CompiledLayer`) — so a
 * multi-layer effect is several pools and a playback holds one run in each.
 *
 * Instances are handed out as contiguous *runs* (in 32-instance blocks) so a spawn is one upload
 * per attribute rather than one per particle, and a free is a bitmask clear. There is deliberately
 * no per-particle sorting yet: `add`/`multiply` blending do not need it, and per-instance sorting
 * would require a remap attribute or a state texture — see the doc's P5.
 */
export class ParticlePool {
    readonly key: string;
    readonly capacity: number;
    readonly geometry = new InstancedBufferGeometry();
    readonly material: ShaderMaterial;
    readonly mesh: Mesh<InstancedBufferGeometry, ShaderMaterial>;

    readonly sim: Float32Array;
    readonly vel: Float32Array;
    readonly size: Float32Array;
    readonly meta: Float32Array;
    readonly trail: Float32Array;
    readonly dyn: Float32Array;
    readonly noise: Float32Array;
    readonly curves: Float32Array;
    readonly color: Uint8Array;

    private readonly attrs: InstancedBufferAttribute[];
    private readonly blockCount: number;
    private readonly bitmap: Uint32Array;
    private usedBlocks = 0;
    private highWater = 0;

    constructor(
        layer: CompiledLayer,
        texture: Texture,
        curveAtlas: CurveAtlas,
        pose: PoseTable,
        timeUniform: { value: number },
        capacity = 2048
    ) {
        this.key = layer.poolKey;
        this.capacity = roundUpToBlock(capacity);
        this.blockCount = this.capacity / BLOCK_SIZE;
        this.bitmap = new Uint32Array(Math.ceil(this.blockCount / 32));

        this.sim = new Float32Array(this.capacity * 4);
        this.vel = new Float32Array(this.capacity * 4);
        this.size = new Float32Array(this.capacity * 4);
        this.meta = new Float32Array(this.capacity * 4);
        this.trail = new Float32Array(this.capacity * 4);
        this.dyn = new Float32Array(this.capacity * 4);
        this.noise = new Float32Array(this.capacity * 4);
        this.curves = new Float32Array(this.capacity * 4);
        this.color = new Uint8Array(this.capacity * 4);

        // Base quad as a triangle strip; three injects the `position` declaration for ShaderMaterial.
        this.geometry.setAttribute(
            'position',
            new BufferAttribute(
                new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, -0.5, 0.5, 0, 0.5, 0.5, 0]),
                3
            )
        );

        this.attrs = [
            this.addAttribute('aSim', this.sim),
            this.addAttribute('aVel', this.vel),
            this.addAttribute('aSize', this.size),
            this.addAttribute('aMeta', this.meta),
            this.addAttribute('aTrail', this.trail),
            this.addAttribute('aDyn', this.dyn),
            this.addAttribute('aNoise', this.noise),
            this.addAttribute('aCurves', this.curves),
            this.addAttribute('aColor', this.color, true),
        ];

        this.geometry.instanceCount = 0;

        const defines: Record<string, string> = {};
        if (layer.kind === 'quad') defines.KIND_QUAD = '';
        else defines[layer.trailStyle === 'strip' ? 'KIND_TRAIL_STRIP' : 'KIND_TRAIL_BILLBOARD'] = '';
        if (layer.orient === 'velocity') defines.ORIENT_VELOCITY = '';
        // Turbulence is a program specialization, not a uniform: a quiet asset never runs the noise
        // path (see `poolKey` in assets.ts — noise is part of the pool identity for this reason).
        if (layer.noiseAmplitude > 0) defines.NOISE = '';

        this.material = new ShaderMaterial({
            defines,
            vertexShader: particleVertexShader,
            fragmentShader: particleFragmentShader,
            transparent: layer.blend !== 'alphaTest',
            depthWrite: layer.blend === 'alphaTest',
            depthTest: true,
            side: DoubleSide,
            blending: blendToThree(layer.blend),
            uniforms: {
                // Shared objects: one write per frame updates every pool.
                uTime: timeUniform,
                uCurves: { value: curveAtlas.texture },
                uCurveRows: { value: curveAtlas.rowCount },
                // Per-pool:
                uMap: { value: texture },
                uGrid: { value: new Vector2(layer.grid[0], layer.grid[1]) },
                uAlphaTest: { value: layer.blend === 'alphaTest' ? 0.5 : 0 },
                // Shared: the whole app has one pose ring.
                uPose: { value: pose.texture },
                uPoseFrames: { value: pose.frames },
                uPoseHz: { value: pose.hz },
                uPoseRows: { value: pose.rows },
            },
        });

        // Blending is the pool's identity, so the material is too.
        this.material.name = `particles:${this.key}`;

        this.mesh = new Mesh(this.geometry, this.material);
        this.mesh.name = `particles:${layer.id}`;
        this.mesh.frustumCulled = false;
        this.mesh.matrixAutoUpdate = false;
        this.mesh.renderOrder = 10;
        this.mesh.visible = false;
    }

    private addAttribute(
        name: string,
        array: Float32Array | Uint8Array,
        normalized = false
    ) {
        const attribute = new InstancedBufferAttribute(array, 4, normalized);
        attribute.setUsage(DynamicDrawUsage);
        this.geometry.setAttribute(name, attribute);
        return attribute;
    }

    get instanceBytes() {
        return this.capacity * INSTANCE_BYTES;
    }

    get usedInstances() {
        return this.usedBlocks * BLOCK_SIZE;
    }

    /** Reserve `instances` contiguous instances. Returns the first instance index, or -1. */
    reserve(instances: number): number {
        const blocks = Math.ceil(instances / BLOCK_SIZE);

        if (blocks <= 0) return -1;
        if (blocks > this.blockCount || this.usedBlocks + blocks > this.blockCount) {
            return -1;
        }

        for (let start = 0; start + blocks <= this.blockCount; ) {
            let blocked = -1;

            for (let i = 0; i < blocks; i++) {
                if (this.isUsed(start + i)) {
                    blocked = i;
                    break;
                }
            }

            if (blocked === -1) {
                for (let i = 0; i < blocks; i++) this.setUsed(start + i, true);

                this.usedBlocks += blocks;
                this.highWater = Math.max(this.highWater, start + blocks);
                this.geometry.instanceCount = this.highWater * BLOCK_SIZE;
                this.mesh.visible = true;

                return start * BLOCK_SIZE;
            }

            // Skip past the blocked bit: no run can start inside an occupied block.
            start += blocked + 1;
        }

        return -1;
    }

    release(instanceStart: number, instances: number) {
        if (instanceStart < 0 || instances <= 0) return;

        const startBlock = instanceStart / BLOCK_SIZE;
        const blocks = Math.ceil(instances / BLOCK_SIZE);

        for (let i = 0; i < blocks; i++) this.setUsed(startBlock + i, false);

        this.usedBlocks = Math.max(0, this.usedBlocks - blocks);

        // Shrink the draw only when the topmost blocks are free — the common case for a pool with
        // several effects alive, and it keeps `instanceCount` a plain high-water mark.
        while (this.highWater > 0 && !this.isUsed(this.highWater - 1)) this.highWater--;

        this.geometry.instanceCount = this.highWater * BLOCK_SIZE;
        if (this.highWater === 0) this.mesh.visible = false;
    }

    writeInstance(index: number, r: InstanceScratch) {
        const i4 = index * 4;

        this.sim[i4] = r.p0x;
        this.sim[i4 + 1] = r.p0y;
        this.sim[i4 + 2] = r.p0z;
        this.sim[i4 + 3] = r.life;

        this.vel[i4] = r.v0x;
        this.vel[i4 + 1] = r.v0y;
        this.vel[i4 + 2] = r.v0z;
        this.vel[i4 + 3] = r.bornAt;

        this.size[i4] = r.sizeX;
        this.size[i4 + 1] = r.sizeY;
        this.size[i4 + 2] = r.angle;
        this.size[i4 + 3] = r.spin;

        this.meta[i4] = r.sprite;
        this.meta[i4 + 1] = r.noiseSeed;
        this.meta[i4 + 2] = r.nodeId;
        this.meta[i4 + 3] = r.segment;

        this.trail[i4] = r.segments;
        this.trail[i4 + 1] = r.segmentDelay;
        this.trail[i4 + 2] = r.tailFade;
        this.trail[i4 + 3] = 0;

        this.dyn[i4] = r.ax;
        this.dyn[i4 + 1] = r.ay;
        this.dyn[i4 + 2] = r.az;
        this.dyn[i4 + 3] = r.drag;

        this.noise[i4] = r.noiseAmplitude;
        this.noise[i4 + 1] = r.noiseFrequency;
        this.noise[i4 + 2] = 0;
        this.noise[i4 + 3] = 0;

        this.curves[i4] = r.curveSizeX;
        this.curves[i4 + 1] = r.curveAlpha;
        this.curves[i4 + 2] = r.curveColor;
        this.curves[i4 + 3] = 0;

        this.color[i4] = (r.r * 255) | 0;
        this.color[i4 + 1] = (r.g * 255) | 0;
        this.color[i4 + 2] = (r.b * 255) | 0;
        this.color[i4 + 3] = (r.a * 255) | 0;
    }

    /**
     * Upload a freshly written run. `addUpdateRange` keeps the upload proportional to what actually
     * changed instead of re-sending the whole pool (megabytes per spawn).
     *
     * Units: three's `WebGLAttributes` treats a range as *array element* indices
     * (`bufferSubData(type, range.start * BYTES_PER_ELEMENT, array, range.start, range.count)`), and
     * every instance attribute here has itemSize 4 — hence the ×4. Getting this wrong silently
     * uploads from the wrong offset.
     */
    flush(instanceStart: number, count: number) {
        if (count <= 0) return;

        for (const attribute of this.attrs) {
            attribute.addUpdateRange(instanceStart * 4, count * 4);
            attribute.needsUpdate = true;
        }
    }

    dispose() {
        this.geometry.dispose();
        this.material.dispose();
    }

    private isUsed(block: number) {
        return (this.bitmap[block >> 5] & (1 << (block & 31))) !== 0;
    }

    private setUsed(block: number, used: boolean) {
        if (used) this.bitmap[block >> 5] |= 1 << (block & 31);
        else this.bitmap[block >> 5] &= ~(1 << (block & 31));
    }
}

function blendToThree(blend: ParticleBlend) {
    switch (blend) {
        case 'add':
            return AdditiveBlending;
        case 'multiply':
            return MultiplyBlending;
        case 'alphaBlend':
        case 'alphaTest':
        default:
            return NormalBlending;
    }
}

/**
 * Textures are loaded once per pool. Headless (server, node) there is no `document`, so the pool
 * gets a 1×1 white texture instead of throwing — importing the plugin must stay safe outside the
 * browser (engine rule, roadmap #18).
 */
export function loadPoolTexture(url: string, onReady: () => void): Texture {
    if (typeof document === 'undefined') {
        const data = new Uint8Array([255, 255, 255, 255]);
        const texture = new DataTexture(data, 1, 1, RGBAFormat);
        texture.needsUpdate = true;
        return texture;
    }

    const texture = new TextureLoader().load(url, () => onReady());
    texture.colorSpace = SRGBColorSpace;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.magFilter = LinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = 1;

    return texture;
}

export { BLOCK_SIZE };

/**
 * Pools are keyed by draw identity `(kind, trailStyle, orient, blend, texture, grid)` — one key per
 * compiled *layer*, so two layers of one effect that look the same share a single draw call. Capacity
 * is per pool, sized from the largest run that has used it; when a layer cannot fit even an empty
 * pool (a long trail with many segments), a second pool with the same key is created rather than
 * reallocating attribute buffers in place — growing a live `InstancedBufferGeometry` would invalidate
 * in-flight update ranges for no visual gain, and this path is rare by construction.
 */
export class ParticlePoolRegistry {
    /** Called once per created pool so the plugin can mount its mesh (and re-mount late scenes). */
    onPoolCreated?: (pool: ParticlePool) => void;

    private poolsByKey = new Map<string, ParticlePool[]>();

    constructor(
        private readonly curveAtlas: CurveAtlas,
        private readonly pose: PoseTable,
        private readonly timeUniform: { value: number },
        private readonly defaultCapacity = 2048
    ) {}

    /** All pools for a draw identity (used by the budget system and for diagnostics). */
    poolsForKey(key: string) {
        return this.poolsByKey.get(key) ?? [];
    }

    all(): ParticlePool[] {
        const all: ParticlePool[] = [];
        this.poolsByKey.forEach((pools) => all.push(...pools));
        return all;
    }

    /**
     * A pool with room for `instances`, reusing an existing one when possible. `textureFactory` is
     * only called when a pool is actually created, so asset registration never touches the GPU.
     */
    acquire(
        layer: CompiledLayer,
        instances: number,
        textureFactory: () => Texture
    ): ParticlePool | undefined {
        const existing = this.poolsByKey.get(layer.poolKey);

        if (existing) {
            for (const pool of existing) {
                if (pool.capacity - pool.usedInstances >= instances) return pool;
            }
        }

        // Never make a pool smaller than one playback can fill, or an effect with a single legal
        // size could never be spawned. Otherwise: the default, with room for a few concurrent
        // playbacks of the same effect (several casters on one spell is the common fight case).
        const capacity = Math.max(
            this.defaultCapacity,
            roundUpToBlock(instances * 4),
            roundUpToBlock(instances)
        );

        const pool = new ParticlePool(
            layer,
            textureFactory(),
            this.curveAtlas,
            this.pose,
            this.timeUniform,
            capacity
        );

        if (existing) existing.push(pool);
        else this.poolsByKey.set(layer.poolKey, [pool]);

        this.onPoolCreated?.(pool);

        return pool;
    }

    dispose() {
        this.poolsByKey.forEach((pools) => pools.forEach((pool) => pool.dispose()));
        this.poolsByKey.clear();
    }
}
