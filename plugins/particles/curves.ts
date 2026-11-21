import { DataTexture, FloatType, NearestFilter, RGBAFormat } from 'three';
import type { ColorLike, CurveDef, Vec3 } from './schema';

/**
 * All curve data for the whole app lives in one RGBA32F texture so that a particle pool never
 * needs a per-asset uniform (per-asset uniforms would force one draw call per asset, which is the
 * thing this renderer exists to avoid).
 *
 * Layout: 64 texels wide (the curve domain, 0..1 of particle life), one row per curve.
 *
 * - Row 0 is the identity row (1,1,1,1) and every "no curve" reference points at it, so the
 *   shaders multiply unconditionally and the common case costs no branch.
 * - Scalar rows (keyframes/const) carry the value in R **and** G/B, with A = 1. A scalar row
 *   accidentally sampled as a colour therefore reads grey instead of black — a visible bug rather
 *   than a silent one.
 * - Gradient rows carry RGB + A.
 *
 * Sampling is `NearestFilter` + a manual lerp in the vertex shader: RGBA32F linear filtering needs
 * `OES_texture_float_linear`, which is not guaranteed on WebGL2 and is not worth a capability gate
 * for six texture fetches per instance.
 */
/** Curve domain resolution. Single source of truth: the shader interpolates this value in. */
export const CURVE_TEXTURE_WIDTH = 64;
const WIDTH = CURVE_TEXTURE_WIDTH;
const ROWS = 512;
const IDENTITY_ROW = 0;

function parseColor(value: ColorLike): [number, number, number, number] {
    if (typeof value !== 'string') {
        return [value[0], value[1], value[2], 1];
    }

    const hex = value.trim().replace(/^#/, '');
    const expand = (s: string) =>
        s.length === 1 ? parseInt(s + s, 16) : parseInt(s, 16);

    if (hex.length === 3 || hex.length === 4) {
        return [
            expand(hex[0]) / 255,
            expand(hex[1]) / 255,
            expand(hex[2]) / 255,
            hex.length === 4 ? expand(hex[3]) / 255 : 1,
        ];
    }

    if (hex.length === 6 || hex.length === 8) {
        return [
            parseInt(hex.slice(0, 2), 16) / 255,
            parseInt(hex.slice(2, 4), 16) / 255,
            parseInt(hex.slice(4, 6), 16) / 255,
            hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
        ];
    }

    return [1, 0, 1, 1]; // magenta: an unparseable colour is loud, not black
}

/** Piecewise-linear evaluation over `stops`, clamped at both ends. */
function sampleStops(stops: Array<[number, number]>, t: number): number {
    if (stops.length === 0) return 0;
    if (t <= stops[0][0]) return stops[0][1];

    for (let i = 1; i < stops.length; i++) {
        const [t1, v1] = stops[i];
        if (t <= t1) {
            const [t0, v0] = stops[i - 1];
            const span = t1 - t0;
            if (span <= 0) return v1;
            return v0 + ((v1 - v0) * (t - t0)) / span;
        }
    }

    return stops[stops.length - 1][1];
}

export class CurveAtlas {
    readonly data = new Float32Array(WIDTH * ROWS * 4);
    readonly texture: DataTexture;

    private rows = 0;
    private keys = new Map<string, number>();

    constructor() {
        // Identity row: multiply-by-one for size/alpha, white for colour.
        for (let x = 0; x < WIDTH; x++) {
            const o = x * 4;
            this.data[o] = 1;
            this.data[o + 1] = 1;
            this.data[o + 2] = 1;
            this.data[o + 3] = 1;
        }
        this.rows = 1;

        this.texture = new DataTexture(
            this.data,
            WIDTH,
            ROWS,
            RGBAFormat,
            FloatType
        );
        this.texture.minFilter = NearestFilter;
        this.texture.magFilter = NearestFilter;
        this.texture.generateMipmaps = false;
        this.texture.needsUpdate = true;
    }

    get rowCount() {
        return ROWS;
    }

    /** Bake (or reuse) a curve, returning its row index. Row 0 for "no curve". */
    add(def: CurveDef | undefined): number {
        if (!def) return IDENTITY_ROW;

        const key = JSON.stringify(def);
        const existing = this.keys.get(key);
        if (existing !== undefined) return existing;

        if (this.rows >= ROWS) {
            throw new Error(
                `[particles] curve atlas is full (${ROWS} rows) — raise ROWS or split the app's assets`
            );
        }

        const row = this.rows++;
        this.writeRow(row, def);
        this.keys.set(key, row);
        this.texture.needsUpdate = true;

        return row;
    }

    private writeRow(row: number, def: CurveDef) {
        const base = row * WIDTH * 4;

        for (let x = 0; x < WIDTH; x++) {
            const t = WIDTH === 1 ? 0 : x / (WIDTH - 1);
            const o = base + x * 4;

            if (def.type === 'const') {
                if (typeof def.value === 'string' || Array.isArray(def.value)) {
                    const [r, g, b, a] = parseColor(def.value as ColorLike);
                    this.data[o] = r;
                    this.data[o + 1] = g;
                    this.data[o + 2] = b;
                    this.data[o + 3] = a;
                } else {
                    this.data[o] = def.value;
                    this.data[o + 1] = def.value;
                    this.data[o + 2] = def.value;
                    this.data[o + 3] = 1;
                }
                continue;
            }

            if (def.type === 'keys') {
                const v = sampleStops(def.stops, t);
                this.data[o] = v;
                this.data[o + 1] = v;
                this.data[o + 2] = v;
                this.data[o + 3] = 1;
                continue;
            }

            // gradient: interpolate in RGBA, stop lists are small so a linear scan is fine
            const stops = def.stops;
            let c: [number, number, number, number];
            if (stops.length === 0) {
                c = [1, 1, 1, 1];
            } else if (t <= stops[0][0]) {
                c = parseColor(stops[0][1]);
            } else if (t >= stops[stops.length - 1][0]) {
                c = parseColor(stops[stops.length - 1][1]);
            } else {
                let i = 1;
                while (i < stops.length && stops[i][0] < t) i++;
                const [t0, c0] = stops[i - 1];
                const [t1, c1] = stops[i];
                const a = parseColor(c0);
                const b = parseColor(c1);
                const span = t1 - t0;
                const f = span <= 0 ? 1 : (t - t0) / span;
                c = [
                    a[0] + (b[0] - a[0]) * f,
                    a[1] + (b[1] - a[1]) * f,
                    a[2] + (b[2] - a[2]) * f,
                    a[3] + (b[3] - a[3]) * f,
                ];
            }

            this.data[o] = c[0];
            this.data[o + 1] = c[1];
            this.data[o + 2] = c[2];
            this.data[o + 3] = c[3];
        }
    }
}

export function colorOf(value: ColorLike | undefined, fallback: Vec3): Vec3 {
    if (value === undefined) return fallback;
    if (typeof value === 'string') {
        const [r, g, b] = parseColor(value);
        return [r, g, b];
    }
    return value;
}
