import { DataTexture, FloatType, Matrix4, NearestFilter, RGBAFormat } from 'three';

/**
 * A short ring of world matrices per animated node (bone, socket, prop), sampled **in the vertex
 * shader at an arbitrary past time**.
 *
 * This is what makes bone attachment stateless. Two different questions both reduce to "what was
 * this node's matrix at time t":
 *
 * - a *free* particle emitted from a hand needs the hand's pose **at its birth**, so a swing does
 *   not drag already-emitted sparks along with it;
 * - a *trail* needs the pose at `t - k·Δ` for each segment, because the ribbon **is** the path the
 *   blade swept — that is what makes an attack trail follow the skin animation.
 *
 * The ring is a **2D** RGBA32F texture: `frames × 4` texels wide (four vec4 *columns* per frame,
 * which is exactly a `mat4` in GLSL's constructor order and avoids any transpose) and `maxNodes`
 * texels tall. Upload is whole-texture per frame, which is deliberate: at 32 nodes × 256 frames that
 * is 512 KB, small enough that partial-update bookkeeping would cost more than it saves.
 *
 * **Why 2D and not one tall 1-texel-wide strip** (the first shape, and a real regression): a GPU's
 * `MAX_TEXTURE_SIZE` is 16384 on essentially every desktop driver, and `maxNodes × frames × 4` texels
 * of *height* hits that at 128 frames (32 nodes). Raising the ring to 256 frames for 8.5 s of history
 * silently produced an unloadable texture — every sample returned zero, so every bone-bound particle
 * collapsed to the world origin. Width pays the same limit but has room to spare: 256 frames is 1024
 * texels across.
 *
 * Frame indexing must match the shader exactly: `floor(time * hz) % frames`. Both sides take the
 * same clock (seconds) from the plugin, so they agree by construction.
 */
export class PoseTable {
    readonly texture: DataTexture;
    /** Node slots this ring can track. */
    readonly maxNodes: number;
    /** Frames of history per node. */
    readonly frames: number;
    /** Pose samples per second. */
    readonly hz: number;
    /** Texture height in texels — one per node slot. */
    readonly rows: number;
    /** Texture width in texels — four matrix columns per frame. */
    readonly cols: number;
    readonly window: number;

    private readonly data: Float32Array;
    private readonly currentFrameOf: Int32Array;
    private readonly seen: Uint8Array;
    private readonly free: number[] = [];

    private currentFrame = 0;
    private written = false;

    /**
     * How many times a node's whole history has been overwritten ("primed").
     *
     * Priming is correct exactly once per allocation: it fills the warm-up window so a birth frame
     * never reads zeros. If it happens *every frame* instead, every birth frame holds the current
     * pose — which looks precisely like "the particles are parented to the emitter", and is the
     * second way this symptom appears. Counted so that possibility is measurable rather than argued
     * (`arena.diagnostics()` reports it).
     */
    primes = 0;

    /**
     * Fields are assigned in the body rather than declared as constructor parameter properties:
     * node's strip-only TypeScript loader rejects parameter properties, and
     * `scratchpad/particles-sanity.mjs` has to be able to import this class to test the ring layout.
     * That is the same constraint `combat/abilityFx.ts` documents for the game layer — a module a
     * headless test imports must be parseable by plain node.
     */
    constructor(maxNodes = 16, frames = 64, hz = 30) {
        this.maxNodes = maxNodes;
        this.frames = frames;
        this.hz = hz;
        this.rows = maxNodes;
        this.cols = frames * 4;
        this.data = new Float32Array(this.cols * this.rows * 4);
        this.window = frames / hz;
        this.currentFrameOf = new Int32Array(maxNodes).fill(-1);
        this.seen = new Uint8Array(maxNodes);

        for (let node = maxNodes - 1; node >= 0; node--) this.free.push(node);

        this.texture = new DataTexture(this.data, this.cols, this.rows, RGBAFormat, FloatType);
        this.texture.minFilter = NearestFilter;
        this.texture.magFilter = NearestFilter;
        this.texture.generateMipmaps = false;
        this.texture.needsUpdate = true;
    }

    get usedNodes() {
        return this.maxNodes - this.free.length;
    }

    /** Reserve a node slot. Returns -1 when the table is full (raise `maxNodes`). */
    allocate(): number {
        const node = this.free.pop();

        if (node === undefined) return -1;

        this.seen[node] = 0;
        this.currentFrameOf[node] = -1;

        return node;
    }

    release(node: number) {
        if (node < 0 || node >= this.maxNodes) return;
        if (this.free.includes(node)) return;

        this.seen[node] = 0;
        this.free.push(node);
    }

    beginFrame(time: number) {
        this.currentFrame = ((Math.floor(time * this.hz) % this.frames) + this.frames) % this.frames;
        this.written = false;
    }

    endFrame() {
        if (this.written) this.texture.needsUpdate = true;
    }

    write(node: number, matrix: Matrix4) {
        if (node < 0 || node >= this.maxNodes) return;

        const first = this.seen[node] === 0;

        // First write for this node fills its whole history with the current pose: the alternative
        // is a warm-up window where "pose at birth" reads zeros and attached particles collapse to
        // the origin for the first `window` seconds of a playback.
        if (first) {
            this.primes++;
            this.seen[node] = 1;
            for (let frame = 0; frame < this.frames; frame++) {
                this.writeFrame(node, frame, matrix);
            }
            this.currentFrameOf[node] = this.currentFrame;
            this.written = true;

            return;
        }

        // Fill any skipped frame indices (a dropped frame, or a long stall) with the latest pose
        // rather than leaving a hole that the shader would read as a stale/blank matrix.
        let frame = this.currentFrameOf[node];

        // **A second write inside the same `hz` bucket only restamps that bucket's frame.**
        //
        // The fill loop below stops when it *reaches* `currentFrame`, so when the frame index has not
        // advanced it has nowhere to stop and runs a full lap, stamping the current pose into every
        // historical frame. That state is indistinguishable from a parent relationship at sampling
        // time — "the pose at birth" and "the pose now" become the same matrix — so every bone-bound
        // particle rides the bone and the `uPoseLive` debug switch changes nothing. It is the normal
        // case, not an edge case: any render loop faster than `hz` (60 fps against 30 Hz) and any
        // frame that primes a playback *and* calls `updatePoses` writes twice per bucket.
        if (frame === this.currentFrame) {
            this.writeFrame(node, frame, matrix);
            this.written = true;

            return;
        }

        for (let step = 0; step < this.frames; step++) {
            frame = (frame + 1) % this.frames;
            this.writeFrame(node, frame, matrix);
            if (frame === this.currentFrame) break;
        }

        this.currentFrameOf[node] = this.currentFrame;
        this.written = true;
    }

    /** Used by tests/tools: read back one texel (a matrix column) without touching GPU state. */
    readColumn(node: number, frame: number, row: number, out: Float32Array) {
        const base = (node * this.cols + frame * 4 + row) * 4;
        for (let i = 0; i < 4; i++) out[i] = this.data[base + i];
        return out;
    }

    private writeFrame(node: number, frame: number, matrix: Matrix4) {
        // three's Matrix4.elements is already column-major and GLSL's `mat4(c0, c1, c2, c3)` takes
        // columns, so the 16 floats copy straight through — no transpose on either side.
        // Column `c` of frame `f` of node `n` starts at texel `n * cols + f * 4 + c`, and a texel is
        // four floats, so the 16 matrix floats land as one contiguous run.
        this.data.set(matrix.elements, (node * this.cols + frame * 4) * 4);
    }
}
