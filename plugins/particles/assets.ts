import type {
    ColorLike,
    CompiledEmitter,
    CompiledLayer,
    CompiledNode,
    CompiledParticleAsset,
    EmitterShape,
    ParticleAsset,
    ParticleAssetEmitter,
    ParticleAssetLayer,
    ParticleBlend,
    ParticleOrient,
    TrailStyle,
    Vec2,
    Vec3,
} from './schema';
import { DEFAULT_MAX_LAYERS, DEFAULT_MAX_NODES, isParticleAsset } from './schema';
import { colorOf, CurveAtlas } from './curves';

const TWO_PI = Math.PI * 2;

const DEFAULT_MAX_PARTICLES = 4096;
/** Node slots a single asset may bind (each costs a pose-ring slot per playback). */
/** Default bound-node ceiling for a *registration* that does not pass limits (see `CompileLimits`). */
const DEFAULT_NODE_LIMIT = DEFAULT_MAX_NODES;
const IDENTITY_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
/** A `dynamics[]` entry that names no numbers still means "some turbulence": 0/0 would be silent. */
const DEFAULT_NOISE_AMPLITUDE = 0.25;
const DEFAULT_NOISE_FREQUENCY = 1;
/**
 * Turbulence is a *displacement* (`value`, metres) and a *rate* (`frequency`, cycles/s), and past
 * these orders of magnitude the author has crossed a unit rather than chosen a look: a particle that
 * jumps 2 m or wobbles at 40 Hz reads as sparks being teleported, not as turbulence. That is exactly
 * what a producer hands us when it puts a **force magnitude** (m/s²) into a length field, so the
 * compiler refuses the number instead of rendering it.
 *
 * The frequency is the base octave; the shader's third octave runs at 2.03² ≈ 4.1× that, so 10 Hz is
 * already a 41 Hz flicker in the finest detail — faster than any frame rate can show.
 */
const MAX_NOISE_AMPLITUDE = 1;
const MAX_NOISE_FREQUENCY = 10;

function fail(message: string): never {
    throw new Error(`[particles] ${message}`);
}

function num(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function range(value: Vec2 | undefined, fallback: Vec2): Vec2 {
    if (!value || value.length < 2) return fallback;
    const a = num(value[0], fallback[0]);
    const b = num(value[1], fallback[1]);
    return a <= b ? [a, b] : [b, a];
}

function vec3(value: Vec3 | undefined, fallback: Vec3): Vec3 {
    if (!value || value.length < 3) return fallback;
    return [num(value[0], fallback[0]), num(value[1], fallback[1]), num(value[2], fallback[2])];
}

function spreadFor(shape: EmitterShape, spread: ParticleAssetEmitter['spread']) {
    const spherical = shape === 'omni' || shape === 'sphere' || shape === 'radial';
    const azimuth = range(spread?.[0], spherical ? [0, TWO_PI] : [0, 0]);
    const elevation = range(spread?.[1], spherical ? [-Math.PI / 2, Math.PI / 2] : [0, 0]);
    return { azimuth, elevation };
}

/**
 * Particle counts are fixed at compile time — that is what makes the per-frame cost independent of
 * how many effects are playing. `rate` × `duration` (or an explicit `burst`) becomes a table of
 * concrete spawns that the runtime writes once and never touches again.
 */
export function emitterParticleCount(emitter: ParticleAssetEmitter, duration: number): number {
    const burst = Math.max(0, num(emitter.burst, 0));
    if (burst > 0) return Math.round(burst);
    const rate = Math.max(0, num(emitter.rate, 0));
    if (rate <= 0) return 0;
    return Math.max(1, Math.round(rate * duration));
}

export type CompileResult = {
    asset: CompiledParticleAsset;
    warnings: string[];
};

/**
 * One `particles[]` entry → its draw state, curves and pool identity. Runtime-sized fields
 * (`maxInstances`/`maxParticles`/emitter range) are filled in once the emitters have been counted.
 */
/**
 * A fixed layer's plane is part of its draw identity: two ground layers with different planes must not
 * share a pool, because the basis is a uniform. Rounded to 3 decimals — a basis is a direction, not a
 * measurement.
 */
function basisKeyFor(basis: [Vec3, Vec3] | null): string {
    if (!basis) return '';

    const round = (vector: Vec3) => vector.map((component) => component.toFixed(3)).join(',');
    return `|b${round(basis[0])}|${round(basis[1])}`;
}

function compileLayer(
    raw: ParticleAsset,
    layer: ParticleAssetLayer,
    index: number,
    curves: CurveAtlas,
    warnings: string[]
): CompiledLayer {
    const where = `asset "${raw.id}" layer ${index}`;
    const kind = layer.kind ?? 'quad';

    if (kind !== 'quad' && kind !== 'trail') {
        fail(`${where} has unsupported kind "${kind}" (quad | trail)`);
    }

    const trailStyle: TrailStyle = layer.trailStyle ?? 'billboard';

    if (kind === 'trail' && trailStyle !== 'billboard' && trailStyle !== 'strip') {
        fail(`${where} has unsupported trailStyle "${trailStyle}"`);
    }

    const orient: ParticleOrient = layer.orient ?? 'camera';

    if (orient !== 'camera' && orient !== 'velocity' && orient !== 'fixed') {
        fail(`${where} has unsupported orient "${orient}"`);
    }

    /**
     * The authored plane for a fixed quad. Validated as two non-degenerate vectors: a zero basis would
     * collapse every particle to a point, which is a producer bug worth failing on rather than
     * rendering as nothing.
     */
    let basis: [Vec3, Vec3] | null = null;

    if (orient === 'fixed') {
        if (!layer.basis) {
            // No basis authored: Ryzom's identity plane is the ground (Z-up), i.e. the engine's XZ.
            basis = [
                [1, 0, 0],
                [0, 0, -1],
            ];
        } else {
            const [x, y] = layer.basis;
            const lengthX = Math.hypot(x[0], x[1], x[2]);
            const lengthY = Math.hypot(y[0], y[1], y[2]);

            if (lengthX < 1e-4 || lengthY < 1e-4) {
                fail(`${where} has a degenerate fixed-orientation basis`);
            }

            basis = [
                [x[0] / lengthX, x[1] / lengthX, x[2] / lengthX],
                [y[0] / lengthY, y[1] / lengthY, y[2] / lengthY],
            ];
        }
    }

    const blend: ParticleBlend = layer.blend ?? raw.render.blend ?? 'add';

    if (!['add', 'multiply', 'alphaBlend', 'alphaTest'].includes(blend)) {
        fail(`${where} has unsupported blend "${blend}"`);
    }

    /**
     * Depth test on unless the asset says otherwise — `true` is what every asset written before the
     * field existed means, and it is also the source default (`CMaterial::_ZFunction = lessequal`,
     * `nel/src/3d/material.cpp:47`). A non-boolean is a producer bug, not a truthy value.
     */
    const rawZTest = layer.zTest ?? raw.render.zTest;

    if (rawZTest !== undefined && typeof rawZTest !== 'boolean') {
        fail(`${where} has a non-boolean zTest (${JSON.stringify(rawZTest)})`);
    }

    const zTest = rawZTest ?? true;

    // No texture is legal: the pool falls back to the built-in soft dot (see `pools.ts`).
    const textureUrl = layer.texture ?? raw.render.texture ?? '';
    const rawGrid = range(layer.grid ?? raw.render.grid, [1, 1]);
    const grid: Vec2 = [
        Math.max(1, Math.round(num(rawGrid[0], 1))),
        Math.max(1, Math.round(num(rawGrid[1], 1))),
    ];
    const spriteCount = Math.max(
        1,
        Math.round(num(layer.spriteCount ?? raw.render.spriteCount, grid[0] * grid[1]))
    );

    if (spriteCount > grid[0] * grid[1]) {
        fail(
            `${where} declares ${spriteCount} sprites but its ${grid[0]}x${grid[1]} grid ` +
                `only addresses ${grid[0] * grid[1]} cells`
        );
    }

    const curveRows = {
        sizeX: curves.add(layer.curves?.sizeX ? raw.curves?.[layer.curves.sizeX] : undefined),
        sizeY: curves.add(layer.curves?.sizeY ? raw.curves?.[layer.curves.sizeY] : undefined),
        alpha: curves.add(layer.curves?.alpha ? raw.curves?.[layer.curves.alpha] : undefined),
        color: curves.add(layer.curves?.color ? raw.curves?.[layer.curves.color] : undefined),
    };

    for (const ref of [
        layer.curves?.sizeX,
        layer.curves?.sizeY,
        layer.curves?.alpha,
        layer.curves?.color,
    ]) {
        if (ref && !raw.curves?.[ref]) {
            warnings.push(`curve "${ref}" is referenced but not defined; using the identity curve`);
        }
    }

    return {
        id: index === 0 ? raw.id : `${raw.id}#${index}`,
        // Everything that changes the compiled program or the draw state is part of the identity,
        // so two layers with the same look share one pool (one draw call).
        poolKey:
            `${kind}|${trailStyle}|${orient}|${blend}|${textureUrl}|${grid[0]}x${grid[1]}` +
            `${basisKeyFor(basis)}${(layer.softDepth ?? raw.render.softDepth) ? '|soft' : ''}` +
            `${num(layer.zBias ?? raw.render.zBias, 0) !== 0 ? '|z' : ''}` +
            // A no-z-test layer compiles a different material state (and takes no soft fade), so it
            // must not share a draw call with a depth-tested layer of the same look.
            `${zTest ? '' : '|noztest'}`,
        blend,
        kind,
        trailStyle,
        orient,
        segments: kind === 'trail' ? Math.max(2, Math.round(num(layer.segments, 6))) : 1,
        basis,
        // Default ON: absent means "fade me if the project supplied a depth pass" (the pool only
        // compiles the define when both the capability and this flag are true). An asset that must not
        // fade says `softDepth: false`.
        softDepth: layer.softDepth ?? raw.render.softDepth ?? true,
        zTest,
        zBias: num(layer.zBias ?? raw.render.zBias, 0),
        tailFade: layer.tailFade ?? true,
        textureUrl,
        grid,
        spriteCount,
        curveRows,
        noiseAmplitude: 0,
        noiseFrequency: DEFAULT_NOISE_FREQUENCY,
        maxInstances: 0,
        maxParticles: 0,
        emitterStart: 0,
        emitterCount: 0,
    };
}

/**
 * `dynamics[]` → per-layer noise parameters.
 *
 * A dynamic names the node whose *particles* it moves, and the asset's only link from a node to the
 * layers that draw it is `emitters[].into` — so one located with several renderers (the common
 * Ryzom case: a ball *and* a fire plume over the same particles) legitimately resolves to several
 * layers, and every one of them gets the motion. What cannot be resolved is reported: a node no
 * emitter emits into, or a layer whose particles come from more than one node.
 */
function resolveDynamics(
    raw: ParticleAsset,
    layers: CompiledLayer[],
    emittersByLayer: ParticleAssetEmitter[][],
    nodeIds: Set<string>,
    warnings: string[]
) {
    const dynamics = raw.dynamics ?? [];

    if (dynamics.length === 0) return;

    const intoOfLayer: Set<string>[] = layers.map(() => new Set());

    for (let index = 0; index < layers.length; index++) {
        for (const emitter of emittersByLayer[index]) {
            if (!emitter.into) continue;

            if (!nodeIds.has(emitter.into)) {
                warnings.push(
                    `emitter at "${emitter.at ?? 'root'}" emits into node "${emitter.into}" which ` +
                        `the asset does not declare; the reference is ignored`
                );
                continue;
            }

            intoOfLayer[index].add(emitter.into);
        }
    }

    const noiseCount: number[] = layers.map(() => 0);
    const ambiguous = new Set<number>();

    for (const dynamic of dynamics) {
        if (dynamic.type !== 'noise') {
            fail(
                `asset "${raw.id}" declares dynamics type "${dynamic.type}", which this version ` +
                    `cannot evaluate (only "noise"). Constant acceleration and drag are emitter ` +
                    `fields; force fields and colliders are tier B and not built yet.`
            );
        }

        let targets: number[];

        if (dynamic.at === undefined) {
            targets = layers.map((_, index) => index);
        } else {
            if (!nodeIds.has(dynamic.at)) {
                warnings.push(
                    `dynamics "${dynamic.at}" names a node the asset does not declare; the ` +
                        `${dynamic.type} is dropped`
                );
                continue;
            }

            targets = [];

            for (let index = 0; index < layers.length; index++) {
                if (intoOfLayer[index].has(dynamic.at)) targets.push(index);
            }

            if (targets.length === 0) {
                warnings.push(
                    `dynamics "${dynamic.at}" names a node no emitter emits into (emitters[].into), ` +
                        `so no layer draws its particles; the ${dynamic.type} is dropped`
                );
                continue;
            }
        }

        const authored = num(dynamic.value, DEFAULT_NOISE_AMPLITUDE);

        if (authored < 0) {
            warnings.push(
                `dynamics "${dynamic.at ?? raw.id}": negative ${dynamic.type} amplitude ` +
                    `${authored}; baked as its magnitude`
            );
        }

        let amplitude = Math.abs(authored);

        if (amplitude > MAX_NOISE_AMPLITUDE) {
            warnings.push(
                `dynamics "${dynamic.at ?? raw.id}": ${dynamic.type} amplitude ${amplitude} m ` +
                    `is not a particle displacement (limit ${MAX_NOISE_AMPLITUDE} m); clamped. A ` +
                    `displacement that large is a unit error — a force magnitude (m/s²) written ` +
                    `into a length field — not a look choice.`
            );
            amplitude = MAX_NOISE_AMPLITUDE;
        }

        let frequency = num(dynamic.frequency, DEFAULT_NOISE_FREQUENCY) * num(dynamic.speed, 1);

        if (!Number.isFinite(frequency)) {
            warnings.push(
                `dynamics "${dynamic.at ?? raw.id}": ${dynamic.type} frequency is not a finite ` +
                    `number; using ${DEFAULT_NOISE_FREQUENCY}`
            );
            frequency = DEFAULT_NOISE_FREQUENCY;
        } else if (Math.abs(frequency) > MAX_NOISE_FREQUENCY) {
            warnings.push(
                `dynamics "${dynamic.at ?? raw.id}": ${dynamic.type} frequency ` +
                    `${Math.abs(frequency)} Hz is not a particle wobble (limit ` +
                    `${MAX_NOISE_FREQUENCY} Hz base octave); clamped.`
            );
            frequency = MAX_NOISE_FREQUENCY;
        }

        for (const index of targets) {
            const layer = layers[index];
            noiseCount[index]++;

            // Independent displacement fields add; one instance vec4 can carry one amplitude and
            // one rate, so a second field on the same layer only widens and speeds up the first.
            layer.noiseAmplitude += amplitude;
            layer.noiseFrequency = Math.max(layer.noiseFrequency, Math.abs(frequency));

            if (intoOfLayer[index].size > 1) ambiguous.add(index);
        }
    }

    // A layer whose particles come from two nodes cannot be scoped to one of them, so a dynamic that
    // names either node is applied to the layer as a whole. Reported once per layer, not per module.
    for (const index of ambiguous) {
        warnings.push(
            `layer ${layers[index].id} draws particles from ${intoOfLayer[index].size} nodes ` +
                `(${[...intoOfLayer[index]].join(', ')}), so a dynamics entry naming one of them ` +
                `covers the whole layer`
        );
    }

    for (let index = 0; index < layers.length; index++) {
        if (noiseCount[index] > 1) {
            warnings.push(
                `${layers[index].id}: ${noiseCount[index]} noise dynamics collapse into one ` +
                    `(amplitudes summed, frequency = the fastest)`
            );
        }

        // The sum is what the instance carries, so the bound has to hold for it too.
        if (layers[index].noiseAmplitude > MAX_NOISE_AMPLITUDE) {
            warnings.push(
                `${layers[index].id}: turbulence modules sum to ${layers[index].noiseAmplitude} m ` +
                    `(limit ${MAX_NOISE_AMPLITUDE} m); clamped`
            );
            layers[index].noiseAmplitude = MAX_NOISE_AMPLITUDE;
        }

        // Noise compiles a different program, so it belongs in the pool identity (one draw call per
        // pool): a noisy layer must never share a pool with a quiet one.
        if (layers[index].noiseAmplitude > 0) layers[index].poolKey += '|noise';
    }
}

/**
 * Turn an authored asset into exactly what the runtime needs, or throw.
 *
 * Supported in this version: up to `maxLayers` layers (`quad` or `trail`), each with its own
 * texture, sprite grid and blend; emitters attributed to a layer by `emitters[].layer`; shaped
 * spawns, analytic motion (constant acceleration + exponential drag), `dynamics[]` noise turbulence,
 * and life curves. Anything else is an explicit error, not a silent downgrade — a converter that
 * meets an unsupported feature must record it in `meta.warnings` (which we surface here too) rather
 * than shipping a broken effect.
 */
export type CompileLimits = {
    /** Draw layers one asset may declare. Defaults to `DEFAULT_MAX_LAYERS`. */
    maxLayers?: number;
    /** Bound nodes one asset may carry. Defaults to `DEFAULT_MAX_NODES`. */
    maxNodes?: number;
};

export function compileParticleAsset(
    raw: ParticleAsset,
    curves: CurveAtlas,
    limits: CompileLimits = {}
): CompileResult {
    if (!isParticleAsset(raw)) {
        fail('asset is not a sprixle.particles document (needs `id` and `render.texture`)');
    }

    const maxLayers = Math.max(1, Math.floor(limits.maxLayers ?? DEFAULT_MAX_LAYERS));
    const maxNodes = Math.max(1, Math.floor(limits.maxNodes ?? DEFAULT_MAX_NODES));

    const warnings: string[] = [...(raw.meta?.warnings ?? [])];
    const layersRaw = raw.particles ?? [];

    if (layersRaw.length === 0) fail(`asset "${raw.id}" declares no particles[] layer`);
    if (layersRaw.length > maxLayers) {
        fail(
            `asset "${raw.id}" declares ${layersRaw.length} particle layers but the runtime plays ` +
                `${maxLayers} (raise the plugin's maxLayers): a playback owns one instance run per layer. ` +
                `Split the effect into several assets.`
        );
    }

    const layers: CompiledLayer[] = layersRaw.map((layer, index) =>
        compileLayer(raw, layer, index, curves, warnings)
    );

    const emittersRaw = raw.emitters ?? [];
    if (emittersRaw.length === 0) fail(`asset "${raw.id}" declares no emitters[]`);

    const nodesRaw = raw.nodes?.length ? raw.nodes : [{ id: 'root' }];

    if (nodesRaw.length > maxNodes) {
        warnings.push(
            `asset declares ${nodesRaw.length} nodes but only ${maxNodes} are supported; ` +
                `nodes beyond that are ignored`
        );
    }

    const nodes: CompiledNode[] = nodesRaw.slice(0, maxNodes).map((node) => ({
        id: node.id,
        bone: node.bone ?? null,
        matrix:
            node.transform && node.transform.length === 16 ? node.transform : IDENTITY_MATRIX,
    }));

    const rootNode = nodes[0];
    const rootMatrix = rootNode.matrix;

    const nodeIndexOf = (name: string | undefined): number => {
        if (!name) return 0;
        const index = nodes.findIndex((node) => node.id === name);
        if (index >= 0) return index;
        warnings.push(`emitter references node "${name}" which the asset does not declare; using root`);
        return 0;
    };

    const layerIndexOf = (value: number | undefined): number => {
        if (value === undefined) return 0;

        const index = Math.round(value);
        if (index >= 0 && index < layers.length) return index;

        warnings.push(
            `emitter references layer ${value} but the asset declares ${layers.length}; using layer 0`
        );

        return 0;
    };

    // Group by layer before compiling, so `emitters[]` comes out grouped in layer order: playback
    // then walks it run by run with no per-frame bucketing (see `ParticleArena.writeRun`).
    const emittersByLayer: ParticleAssetEmitter[][] = layers.map(() => []);
    for (const emitter of emittersRaw) emittersByLayer[layerIndexOf(emitter.layer)].push(emitter);

    const emitters: CompiledEmitter[] = [];
    const layerParticles: number[] = layers.map(() => 0);
    const layerBound: boolean[] = layers.map(() => false);
    let duration = 0;
    let maxLife = 0;
    let total = 0;

    for (let layerIndex = 0; layerIndex < layers.length; layerIndex++) {
        const compiledLayer = layers[layerIndex];
        compiledLayer.emitterStart = emitters.length;

        for (const emitter of emittersByLayer[layerIndex]) {
            const shape = (emitter.shape ?? 'point') as EmitterShape;
            const { azimuth, elevation } = spreadFor(shape, emitter.spread);
            const emitterDuration = Math.max(0, num(emitter.duration, 0));
            const life = range(emitter.life, [1, 1]);
            const count = emitterParticleCount(emitter, emitterDuration);

            duration = Math.max(duration, emitterDuration);
            maxLife = Math.max(maxLife, life[1]);
            layerParticles[layerIndex] += count;
            total += count;

            const nodeIndex = nodeIndexOf(emitter.at);
            if (nodes[nodeIndex].bone) layerBound[layerIndex] = true;

            emitters.push({
                at: nodes[nodeIndex].id,
                nodeIndex,
                layer: layerIndex,
                shape,
                rate: num(emitter.rate, 0),
                burst: num(emitter.burst, 0),
                duration: emitterDuration,
                azimuth,
                elevation,
                direction: vec3(emitter.direction, [0, 1, 0]),
                extent: vec3(emitter.extent, [0.5, 0.5, 0.5]),
                velocity: range(emitter.velocity, [0, 0]),
                life,
                size: range(emitter.size, [1, 1]),
                color: colorOf(emitter.color, [1, 1, 1]),
                angle: range(emitter.angle, [0, 0]),
                spin: range(emitter.spin, [0, 0]),
                sprites: (emitter.sprites ?? []).filter(
                    (s) => s >= 0 && s < compiledLayer.spriteCount
                ),
                acceleration: vec3(emitter.acceleration, [0, 0, 0]),
                drag: Math.max(0, num(emitter.drag, 0)),
                seed: Math.round(num(emitter.seed, 0x9e3779b9 + emitters.length * 2654435761)) >>> 0,
            });
        }

        compiledLayer.emitterCount = emitters.length - compiledLayer.emitterStart;
    }

    resolveDynamics(raw, layers, emittersByLayer, new Set(nodes.map((node) => node.id)), warnings);

    const budget = Math.max(0, Math.round(num(raw.budget?.maxParticles, DEFAULT_MAX_PARTICLES)));
    if (total > budget) {
        warnings.push(
            `clamped ${total} particles to budget.maxParticles = ${budget} (raise the budget to keep ` +
                `the authored density)`
        );
    }
    if (total === 0) {
        fail(
            `asset "${raw.id}" emits nothing — each emitter needs a positive \`rate\` with ` +
                `\`duration\`, or a \`burst\` count`
        );
    }

    // `budget.maxParticles` covers the whole playback, so a clamp thins every layer by the same
    // ratio rather than starving the later ones. With one layer this is exactly `min(total, budget)`.
    const scale = total > budget ? budget / total : 1;
    let maxInstances = 0;
    let maxParticles = 0;

    for (let index = 0; index < layers.length; index++) {
        const layer = layers[index];
        const authored = layerParticles[index];
        const allocated =
            authored <= 0
                ? 0
                : scale >= 1
                  ? authored
                  : budget > 0
                    ? Math.max(1, Math.floor(authored * scale))
                    : 0;

        layer.maxParticles = allocated;
        layer.maxInstances = allocated * layer.segments;
        maxInstances += layer.maxInstances;
        maxParticles += allocated;

        if (layerBound[index] && layer.kind === 'quad') {
            warnings.push(
                `${layer.id}: node is bone-bound, so quad particles spawn with node-local motion ` +
                    `(velocity/acceleration are interpreted in the bone's frame, not world space)`
            );
        }
    }

    const compiled: CompiledParticleAsset = {
        id: raw.id,
        softDepth: raw.render.softDepth ?? false,
        zBias: num(raw.render.zBias, 0),
        duration,
        maxLife,
        maxInstances,
        poseWindow: duration + maxLife,
        maxParticles,
        // A playback is only "finished" once the last emitted particle has died.
        maxViewDist: num(raw.budget?.maxViewDist, 0),
        nodes,
        rootMatrix,
        layers,
        emitters,
        events: raw.events ?? [],
        warnings,
    };

    return { asset: compiled, warnings };
}

/**
 * Asset lookup by id. Kept deliberately dumb: no watching, no hot reload — a project that wants
 * live editing can re-register a recompiled asset and existing playbacks keep their instance data.
 */
export class ParticleAssetRegistry {
    private assets = new Map<string, CompiledParticleAsset>();

    register(asset: CompiledParticleAsset) {
        this.assets.set(asset.id, asset);
        return asset;
    }

    get(id: string): CompiledParticleAsset | undefined {
        return this.assets.get(id);
    }

    has(id: string) {
        return this.assets.has(id);
    }

    list(): CompiledParticleAsset[] {
        return [...this.assets.values()];
    }

    clear() {
        this.assets.clear();
    }
}

/**
 * Fetch + validate + register. `curves` is shared by the whole app so that every asset's curves
 * live in one texture (see `curves.ts`).
 */
export async function loadParticleAsset(
    url: string,
    registry: ParticleAssetRegistry,
    curves: CurveAtlas
): Promise<CompiledParticleAsset> {
    const response = await fetch(url);

    if (!response.ok) {
        fail(`failed to fetch "${url}" (${response.status} ${response.statusText})`);
    }

    const raw = (await response.json()) as ParticleAsset;
    const { asset, warnings } = compileParticleAsset(raw, curves);

    if (warnings.length) {
        console.warn(`[particles] ${asset.id}:\n  - ${warnings.join('\n  - ')}`);
    }

    return registry.register(asset);
}

export type { ColorLike, Vec3 };
