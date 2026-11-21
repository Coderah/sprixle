/**
 * Neutral particle asset schema (`sprixle.particles`).
 *
 * Nothing in this file knows about any specific authoring tool: a producer (Blender exporter,
 * a corpus converter, hand authoring, code) writes this JSON, the runtime consumes it. Fields
 * that only one producer understands belong in `meta`, never in the model.
 *
 * The runtime deliberately supports a *subset* in its first version and refuses the rest loudly
 * at load time rather than rendering something plausible-looking — see `compileParticleAsset`.
 */

export const PARTICLE_ASSET_FORMAT = 'sprixle.particles';

/**
 * Draw layers one playback can own. Fixed because a playback's run bookkeeping is typed arrays
 * indexed by layer (see `ParticleArena`), and because a corpus effect with more than a handful of
 * sprite groups is rare enough to re-author rather than size for.
 */
export const MAX_LAYERS = 4;

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];
/** Linear-ish RGB 0..1, or an `#rrggbb` / `#rrggbbaa` string (both accepted). */
export type ColorLike = Vec3 | string;
export type CurveRef = string;

export type ParticleBlend = 'add' | 'multiply' | 'alphaBlend' | 'alphaTest';

/** How one layer's particles are drawn. */
export type ParticleKind = 'quad' | 'trail';
export type TrailStyle = 'billboard' | 'strip';

/**
 * Billboards face the camera. `velocity` is a camera-facing quad rotated in screen space to the
 * particle's direction of travel (sparks, streaks). `fixed` uses the emitted orientation as-is.
 */
export type ParticleOrient = 'camera' | 'velocity' | 'fixed';

export type EmitterShape =
    | 'point'
    | 'directional'
    | 'omni'
    | 'conic'
    | 'rectangle'
    | 'sphere'
    | 'radial';

/** A curve is either constant, keyframes (scalar) or a gradient (colour), evaluated over life. */
export type CurveDef =
    | { type: 'const'; value: number | ColorLike }
    | { type: 'keys'; stops: Array<[number, number]> }
    | { type: 'gradient'; stops: Array<[number, ColorLike]> };

export type ParticleAssetNode = {
    id: string;
    parent?: string | null;
    /** Column-major 16-float local transform. Defaults to identity. */
    transform?: number[];
    /** Reserved: bind this node to a named bone once the animation runtime lands. */
    bone?: string | null;
};

/** Emits particles into world space, from one of the asset's layers. */
export type ParticleAssetEmitter = {
    /** Node the emission point rides. Defaults to the asset's root node. */
    at?: string;
    /**
     * Node the emitted particles *live on* — the counterpart of `at`, which is only where they come
     * out. Required to scope a `dynamics[]` entry to the layers that draw those particles; a
     * bone-bound emitter usually keeps both on the same node.
     */
    into?: string;
    /** Which `particles[]` layer this emitter feeds. Defaults to layer 0. */
    layer?: number;
    shape?: EmitterShape;
    /** Particles per second while `duration` is running. Ignored when `burst` > 0. */
    rate?: number;
    /** One-shot count emitted across `duration` (staggered), instead of `rate`. */
    burst?: number;
    /** Emission window in seconds; also the asset's playback length when looping. */
    duration?: number;
    /** Emission directions, radians: [azimuthMin, azimuthMax] / [elevationMin, elevationMax]. */
    spread?: [Vec2, Vec2];
    /** Emission direction in local space for `directional`/`conic`/`rectangle`. */
    direction?: Vec3;
    /** Emitter extent in metres, for `rectangle`/`sphere`/`radial`/`omni`. */
    extent?: Vec3;
    velocity?: Vec2;
    life?: Vec2;
    size?: Vec2;
    /** Base colour multiplier, modulated by `curves.color` over life. */
    color?: ColorLike;
    angle?: Vec2;
    spin?: Vec2;
    /** Sprite cell indices (into `render.sprites`), or omitted for a uniform pick. */
    sprites?: number[];
    /** Per-emitter motion. `drag` is 1/s (`dv/dt = a - drag*v`). */
    acceleration?: Vec3;
    drag?: number;
    /** Deterministic seed; identical seeds produce identical spawns. */
    seed?: number;
};

/** How one layer's particles look over their life, and which draw state they use. */
export type ParticleAssetLayer = {
    kind: ParticleKind;
    trailStyle?: TrailStyle;
    orient?: ParticleOrient;
    /** Segments per trail particle (kind === 'trail'). Each segment is one instance. */
    segments?: number;
    /** Trail colour/alpha fade toward the tail. Default true. */
    tailFade?: boolean;
    /**
     * Draw-state overrides. `render` holds the asset-wide defaults; a layer that names its own
     * `blend`/`texture`/`grid`/`spriteCount` is what lets one effect mix an additive spark layer with
     * an alpha-blended smoke layer drawn from a different sprite sheet.
     */
    blend?: ParticleBlend;
    texture?: string;
    grid?: Vec2;
    spriteCount?: number;
    /** Curve references, evaluated over normalised life. */
    curves?: {
        sizeX?: CurveRef;
        sizeY?: CurveRef;
        alpha?: CurveRef;
        color?: CurveRef;
    };
};

export type ParticleAssetRender = {
    blend?: ParticleBlend;
    /** Texture URL. Cells are addressed by `grid` + `sprites`. */
    texture: string;
    /** [columns, rows] sprite grid inside `texture`. Omit for a single sprite. */
    grid?: Vec2;
    /** Number of usable cells (defaults to the whole grid); `emitters[].sprites` picks among them. */
    spriteCount?: number;
    softDepth?: boolean;
    zBias?: number;
};

/**
 * A motion module, applied to the particles of the layers it resolves to.
 *
 * `noise` is the only type this version implements: stateless turbulence, evaluated in the vertex
 * shader from the instance's own seed and age — no feedback, no per-frame upload (see
 * `shaders.ts`). A type the runtime cannot evaluate is a load error rather than a silent downgrade.
 */
export type ParticleAssetDynamic = {
    /**
     * Node whose particles this dynamic moves: the node a layer draws its particles on, spelled on
     * the producer side as `emitters[].into`. Omitted ⇒ every layer of the asset.
     */
    at?: string;
    type: 'noise';
    /**
     * Peak displacement in metres (each axis spans ±value). Default 0.25, and clamped at
     * `MAX_NOISE_AMPLITUDE` (1 m) by the compiler: past that it is a unit error, not a look.
     */
    value?: number;
    /** Base octave, in field cycles per second. Default 1, clamped at 10 (see `assets.ts`). */
    frequency?: number;
    /** Multiplier on `frequency` — a producer's "how fast the sequence walks" value. Default 1. */
    speed?: number;
};

export type ParticleAssetEvent = {
    at?: string;
    type: 'sound' | 'signal';
    name: string;
    /** Seconds after playback start. */
    atTime?: number;
};

export type ParticleAsset = {
    format?: string;
    version?: number;
    id: string;
    render: ParticleAssetRender;
    budget?: { maxParticles?: number; maxViewDist?: number };
    nodes?: ParticleAssetNode[];
    emitters?: ParticleAssetEmitter[];
    /** Draw layers, at most `MAX_LAYERS`; each one gets its own pool draw and instance run. */
    particles: ParticleAssetLayer[];
    /** Motion modules, resolved to layers at compile time (a layer carries one noise). */
    dynamics?: ParticleAssetDynamic[];
    events?: ParticleAssetEvent[];
    curves?: Record<string, CurveDef>;
    meta?: { source?: string; generator?: string; warnings?: string[] } & Record<
        string,
        unknown
    >;
};

/** A node of the asset's transform graph, with the binding it resolves against at runtime. */
export type CompiledNode = {
    id: string;
    /** Skeleton bone / socket name. `null` for a node that rides the effect transform. */
    bone: string | null;
    /** Column-major local transform (authored offset inside the effect or the bone). */
    matrix: number[];
};

/**
 * One draw layer, fully resolved. A playback allocates one instance run per layer that has
 * emitters, so every field that shapes an instance or the draw state lives here rather than on the
 * asset: two layers of one effect routinely differ in texture, blend and kind.
 */
export type CompiledLayer = {
    /** `<assetId>` for layer 0, `<assetId>#<index>` for the rest — pool and mesh naming only. */
    id: string;
    /** Pool identity: same key ⇒ same draw call. */
    poolKey: string;
    blend: ParticleBlend;
    kind: ParticleKind;
    trailStyle: TrailStyle;
    orient: ParticleOrient;
    segments: number;
    tailFade: boolean;
    textureUrl: string;
    grid: Vec2;
    spriteCount: number;
    /** Curve atlas rows; 0 is the identity row, so "unused" needs no special case. */
    curveRows: { sizeX: number; sizeY: number; alpha: number; color: number };
    /**
     * Turbulence from `dynamics[]`: displacement amplitude in metres (0 ⇒ the shader compiles
     * without the noise path) and its base-octave frequency in cycles per second.
     */
    noiseAmplitude: number;
    noiseFrequency: number;
    /** Particle slots one playback of this layer writes: `maxParticles`, or × `segments` for trails. */
    maxInstances: number;
    maxParticles: number;
    /** This layer's emitters are `emitters[emitterStart ..< emitterStart + emitterCount]`. */
    emitterStart: number;
    emitterCount: number;
};

/** The parts of the asset the runtime actually uses, fully resolved and unit-normalised. */
export type CompiledParticleAsset = {
    id: string;
    softDepth: boolean;
    zBias: number;
    /** Playback length in seconds (emission window, or 0 for a pure burst). */
    duration: number;
    /** Longest particle life, so callers know when a playback is finished. */
    maxLife: number;
    /** Instance slots one playback writes, summed over layers (each layer's run is separate). */
    maxInstances: number;
    /** How far back the pose ring must reach for this effect: `duration + maxLife`. */
    poseWindow: number;
    /** Particles one playback writes, summed over layers. */
    maxParticles: number;
    maxViewDist: number;
    /** Node graph, `nodes[0]` being the asset root. */
    nodes: CompiledNode[];
    /** `nodes[0].matrix`, i.e. the authored offset applied to a free (unbound) effect. */
    rootMatrix: number[];
    layers: CompiledLayer[];
    /** Emitters, grouped by layer (ascending) so playback can walk them run by run. */
    emitters: CompiledEmitter[];
    events: ParticleAssetEvent[];
    /** Human-readable notes from compilation (unsupported producer features, clampings). */
    warnings: string[];
};

export type CompiledEmitter = {
    at: string;
    /** Index into `CompiledParticleAsset.nodes` this emitter emits from. */
    nodeIndex: number;
    /** Index into `CompiledParticleAsset.layers` this emitter writes into. */
    layer: number;
    shape: EmitterShape;
    rate: number;
    burst: number;
    duration: number;
    azimuth: Vec2;
    elevation: Vec2;
    direction: Vec3;
    extent: Vec3;
    velocity: Vec2;
    life: Vec2;
    size: Vec2;
    color: Vec3;
    angle: Vec2;
    spin: Vec2;
    sprites: number[];
    acceleration: Vec3;
    drag: number;
    seed: number;
};

export function isParticleAsset(value: unknown): value is ParticleAsset {
    return (
        !!value &&
        typeof value === 'object' &&
        typeof (value as ParticleAsset).id === 'string' &&
        !!(value as ParticleAsset).render &&
        typeof (value as ParticleAsset).render.texture === 'string'
    );
}
