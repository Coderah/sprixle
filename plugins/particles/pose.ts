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
 * One 1-texel-wide RGBA32F texture holds `maxNodes × frames × 4` rows — four vec4 *columns*, which
 * is exactly a `mat4` in GLSL's constructor order and avoids any transpose. Upload is
 * whole-texture per frame, which is deliberate: at the defaults that is 16 × 64 × 4 × 16 B = 64 KB,
 * small enough that partial-update bookkeeping would cost more than it saves.
 *
 * Frame indexing must match the shader exactly: `floor(time * hz) % frames`. Both sides take the
 * same clock (seconds) from the plugin, so they agree by construction.
 */
export class PoseTable {
    readonly texture: DataTexture;
    readonly rows: number;
    readonly window: number;

    private readonly data: Float32Array;
    private readonly currentFrameOf: Int32Array;
    private readonly seen: Uint8Array;
    private readonly free: number[] = [];

    private currentFrame = 0;
    private written = false;

    constructor(
        readonly maxNodes = 16,
        readonly frames = 64,
        readonly hz = 30
    ) {
        this.rows = maxNodes * frames * 4;
        this.data = new Float32Array(this.rows * 4);
        this.window = frames / hz;
        this.currentFrameOf = new Int32Array(maxNodes).fill(-1);
        this.seen = new Uint8Array(maxNodes);

        for (let node = maxNodes - 1; node >= 0; node--) this.free.push(node);

        this.texture = new DataTexture(this.data, 1, this.rows, RGBAFormat, FloatType);
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
        const base = ((node * this.frames + frame) * 4 + row) * 4;
        for (let i = 0; i < 4; i++) out[i] = this.data[base + i];
        return out;
    }

    private writeFrame(node: number, frame: number, matrix: Matrix4) {
        // three's Matrix4.elements is already column-major and GLSL's `mat4(c0, c1, c2, c3)` takes
        // columns, so the 16 floats copy straight through — no transpose on either side.
        this.data.set(matrix.elements, (node * this.frames + frame) * 16);
    }
}
