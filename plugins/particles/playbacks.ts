/**
 * The decision half of the particle plugin's playback list — **pure**: no `three`, no ECS, no module
 * state. `index.ts` (the API + the reconcile pass) and `arena.ts` (handle → slot) call in here, and
 * `scratchpad/particles-lifecycle-sanity.mjs` imports it directly in node, which is the whole point
 * of the split: the lifecycle rules are provable without WebGL.
 *
 * ### Why a list, and why copies
 *
 * One entity shows several effects at once (a cast channel on the hand, a missile leaving it, a hit
 * burst on the target), each with its own lifetime, so `rParticleFx` holds a bounded **list** of
 * playbacks instead of one asset. The entries are instructions (`asset`, `playing`, `seconds`), not
 * particle state — every particle still lives in the arena's typed arrays (design argument in
 * `Sprixle Docs/particles.md` §6/§8.1).
 *
 * Every function here is a **pure transform returning new arrays and copies**, never an in-place
 * edit, and that is load-bearing rather than stylistic: `TrackPrevious` stores the component
 * *reference*
 * (`ecs/manager.ts` — `previousComponents[componentType] = target[componentType]`), so mutating an
 * entry after the write would make "previous" and "current" the same object and every
 * playing → finished transition invisible to the reconcile pass — which is exactly the bug that
 * makes a finished effect replay forever (see `planPlaybackChanges`).
 */

/**
 * Playbacks one entity may show at once before the oldest is evicted.
 *
 * 6 rather than the roadmap's first guess of 4: a layered ability moment already needs three (cast
 * channel, missile, impact), a held aura and a hit reaction want two more, and a list of this size is
 * six small objects per entity — allocation happens at play/stop frequency, never per frame, so the
 * cap exists to bound *pool* consumption and the component's size, not to save bytes.
 */
export const MAX_PLAYBACKS_PER_ENTITY = 6;

/**
 * A playback whose emitter **travels**, in world space: the origin of every node the asset places
 * interpolates linearly from `from` to `to` over `seconds`.
 *
 * ### Why the interpolation rides the spawn table and not the frame loop
 *
 * "A missile flies" is one origin moving over time, and the whole plugin already has a mechanism for
 * "a per-particle value that is a function of when the particle was born": the spawn table. Each
 * particle's `birthAt` is a spawn-table column (`aVel.w`), the emitter's world matrix is baked into
 * `p0` at spawn, and a stream is a *spread of birth times* rather than a cloud. So travel is applied
 * there, per particle, once: a particle born 0.4 s into a 1.0 s flight starts 40 % along the line and
 * then lives its own life — the trail, with no history, no second attribute channel and **no
 * per-frame work at all**. The pose ring does the same thing for a bone (sample the emitter at the
 * particle's own birth); this is the analytic version of it, exact rather than 30 Hz-quantised,
 * because the birth time is known when the row is written.
 *
 * The alternative — a per-playback row in the pose ring written once per frame — was rejected: it
 * costs a ring row per moving playback (a scarce resource: every bone-bound node holds one), adds a
 * per-instance `rowIndex` channel, and quantises the line at `poseHz` for no gain.
 *
 * ### The rules
 *
 * - `travel` absent = the playback behaves exactly as it did before this field existed.
 * - The asset's own node offsets are **added on top** of the travelled origin (`node.matrix` is kept):
 *   travel moves the emitter, it does not rescale or re-author the effect.
 * - After `seconds` the origin **stays at `to`**; it never snaps back to `from`. The playback
 *   retires on its own `seconds` as always, so a caller that wants the stream to *stop on arrival*
 *   sets the playback `seconds` to the flight time — that is the intended pairing (wroth's missile
 *   does exactly that, `particleAbilityFxSystem`).
 * - **Travel supersedes node binding**: the origin is the line, not a bone, so a travelling playback
 *   bakes its nodes in world space and ignores `bone`/`attachMode` (`arena.play`). The client still
 *   resolves `from` *from* the caster's bone, which is where the bone names the missile's start point.
 * - A **looping** travelling playback replays the flight on each cycle (`startedAt` is restarted by
 *   the respawn). No caller loops one today; it is stated so the behaviour is not a surprise.
 */
export type ParticleTravel = {
    /** Launch point in world space — the caster's bone, resolved by the client when the cast fires. */
    from: readonly [number, number, number];
    /**
     * Arrival point in world space — the target's aiming bone, **kept live**: a homing bolt is
     * re-aimed every frame (`ParticleArena.setTravel`), because a bolt aimed at where the target was
     * detonates in empty air while the impact burst lands on the body it actually hit
     * (`ryzom/client/src/projectile_manager.cpp:205` calls `updateTargetPos()` for exactly this).
     */
    to: readonly [number, number, number];
    /** Flight time. The line is traversed linearly over it, then the origin holds at `to`. */
    seconds: number;
    /**
     * Apex height above the chord, in metres: `0`/absent = a straight line, non-zero = a **parabolic
     * arc** that leaves and arrives on the chord and bulges `arcHeight` above it at the midpoint.
     *
     * The shape is the `MAGICFX::Bomb` trajectory (`ryzom/client/src/projectile_manager.cpp:247-251,
     * 275-280`). The *value* is `Authored`: that file is not on this machine, so the constant Ryzom
     * used for a bomb's apex cannot be read — what is ported is the trajectory and the fact that the
     * emitter's frame follows the parabola's tangent rather than its chord (`arena.ts` →
     * `flightBasis`), so a lobbed bolt noses up on the way out and down on the way in.
     *
     * It is *presentation*: `seconds` still comes from the gameplay's flight time, so an arcing bolt
     * arrives on the frame the Form loss does.
     */
    arcHeight?: number;
};

/** One live-or-finished playback on an entity. */
export type ParticlePlayback = {
    /** Handle, unique per entity, allocated by the plugin. The arena keys a slot by (entity, id). */
    id: number;
    /** Registered asset id (`ParticleAssetRegistry`). */
    asset: string;
    /**
     * True while the playback should exist. The plugin writes `false` when the arena retires it, so a
     * later component update reconciles as "nothing to do" instead of as a start request.
     */
    playing: boolean;
    /** Loop the emission cycle (respawns in place) until `seconds` runs out. */
    loop?: boolean;
    /** Deterministic spawn seed; identical seeds render identical effects. */
    seed?: number;
    /**
     * Per-playback bind: **overrides the bone of every node the asset itself binds**.
     *
     * The field was reserved for exactly this (W32). A baked asset names one bone per node and that
     * is a property of the *art*, not of the ability that plays it — Ryzom's four hand-bound cast
     * effects are all `Bip01 R Hand`, so a left-hand or two-handed cast was inexpressible without
     * editing the asset. An override says it per playback instead, so one asset serves either hand.
     *
     * Only *bound* nodes are re-pointed: a free emitter in the same asset keeps riding the effect
     * transform, because "play this on that hand" is not "attach everything to that hand". An asset
     * with no bound node at all ignores the override, and the plugin warns once (`index.ts`).
     */
    bone?: string;
    /**
     * How a bone-bound particle gets its origin.
     *
     * - `'pose'` (default) — the spawn table stores **node-local** positions and the vertex shader
     *   multiplies by the pose ring's matrix for each particle's own birth time. This is what lets a
     *   stream follow a swinging hand: particles born later get later poses, without touching the CPU
     *   per frame. It costs the ring (`poseFrames / poseHz` of history) and it is the only mode that
     *   can express "emitted along the path".
     * - `'bake'` — the bone's world matrix **at spawn time** is multiplied in on the CPU and the
     *   particle is stored as free (world-space). No ring, no sampling, no history: the emitter gives
     *   birth once and every particle is then an independent world-space thing. A stream in this mode
     *   originates from where the bone was when the playback started.
     *
     * The distinction is the one that keeps being asked about: "on a bone" is *permission to emit
     * from it*, not a parent relationship. `'bake'` makes that structurally true.
     */
    attachMode?: 'pose' | 'bake';
    /**
     * Per-playback RGB multiply on the emitted colour — a *look* override, not a request change.
     *
     * Absent = `(1, 1, 1)` = as authored. It is spent as the per-instance `aTint` column, written
     * into the spawn table beside every other spawn column, so a tint costs one multiply per particle
     * at spawn and nothing per frame, and two playbacks of one asset in the same pool can be tinted
     * differently. A non-finite component is dropped to the identity (`normalizeTint`) for the same
     * reason `normalizeOffset` drops one: a NaN in the spawn table is silent and total.
     *
     * **It never restarts a playback** (`samePlaybackRequest` ignores it — restarting would drop
     * every particle in flight), so a change reaches the arena as `ParticleArena.setTint` instead,
     * which rewrites the live run's `aTint` column and uploads it: the colour the caller asks for is
     * the colour on screen, for the particles already emitted as much as for the next spawn.
     */
    tint?: [number, number, number];
    /**
     * Displace the effect's origin from its anchor, in metres **in the anchor's own space**.
     *
     * Applied *after* the anchor matrix, so the vector is not a world direction: `(0.35, 0, 0)`
     * played on a bone is 0.35 m along **that bone's local +X**, which for the homin rig's spine is
     * the character's own forward — it turns when the character turns and follows the spine when the
     * spine bends. Which local axis is "forward" is the rig's business, not the engine's; the
     * caller that fills this in states where it measured it (`abilities.ts` → `fxChestOffset`).
     *
     * Why a playback needs one at all: a bone at the centre of a body (a spine, a pelvis) is *inside*
     * the mesh, so an effect placed at it renders inside the character. Ryzom's answer is the same
     * one and is where the shape comes from: `CFXStickMode` places the instance at an authored
     * `StickOffset` from the bone, not at the bone (`mat.setPos(buildInfo.StickOffset)`,
     * `ryzom/client/src/attached_fx.cpp:154-168`). The offsets themselves live in the
     * `.animation_fx_set` sheet family, which is not in our corpus — so the *mechanism* is ported and
     * every value on top of it is authored by the game layer, not read.
     *
     * **Cost: one matrix write per playback per frame, never per particle.** The position is baked
     * into the anchor matrix the engine already produces:
     *
     * - a `'pose'`-attached bone folds into the pose ring's write (`anchor * T(offset)`), which is one
     *   extra 4×4 multiply per bound node per frame and nothing at all when `offset` is absent;
     * - a `'bake'` playback, a free node and the effect transform fold it in at spawn, in the same
     *   per-emitter matrix that already composes the anchor — no per-frame cost, no extra attribute.
     *
     * **A travelling playback displaces the whole line**: `offset` shifts `from` *and* `to`, because
     * the flight is one displaced emitter moving between two points, not a line with one end nudged.
     * It is rotated by the effect transform there, since a travelling playback supersedes the bone
     * binding and that transform is the only anchor it has.
     *
     * Absent = exactly the behaviour before the field existed. A malformed value (a non-finite
     * component) is dropped rather than trusted, for the reason `normalizeTravel` documents: one NaN
     * in the spawn table is silent and total.
     */
    offset?: readonly [number, number, number];
    /**
     * Uniform scale of the effect, 1 = as authored. This is Ryzom's `ScaleFX`
     * (`CAnimationFXSheet::ScaleFX`), not a per-particle size edit: it multiplies the asset's **node
     * offsets** and its **sprite sizes**, so a 0.30 m burst becomes a 0.78 m burst whose sprites sit
     * the same *relative* distance from the anchor. Particle motion (velocity, acceleration, drag)
     * is deliberately untouched — a bigger burst must not also fly further.
     *
     * It is spent in two places, neither of them a per-particle CPU loop: the node offset is scaled
     * once per emitter in the spawn matrix the arena already composes, and the sprite size is a
     * per-instance attribute (`aScale`, written once at spawn beside every other spawn column) that
     * the vertex shader multiplies into `sizeX`/`sizeY`. The z-bias and the soft-depth fade are
     * clip-space and per-fragment respectively, so neither is affected by a world-space size change.
     *
     * Why it exists: Ryzom instances every cast and impact sheet once per power tier with four
     * `userParam` floats progressively switched on (`CCharacterCL::playCastFX`) — that parameter
     * system is still absent (engine roadmap gap 26), but the *uniform scale* half of it is what a
     * body-anchored burst needs to read at all, and it is one number rather than four.
     *
     * Absent = 1 = exactly the behaviour before the field existed. A non-finite or non-positive
     * value is dropped to 1 (`normalizeScale`).
     */
    scale?: number;
    /** A travelling emitter — see `ParticleTravel` (a missile from a hand to a target). */
    travel?: ParticleTravel;
    /**
     * Lifetime in seconds; 0 or absent = the asset's own `duration + maxLife`.
     *
     * This is what lets a held state (a baked Ryzom loop that naturally runs ~31 s) decorate a 0.6 s
     * gameplay window without the caller keeping an expiry map.
     */
    seconds?: number;
};

/** What a caller asks for: a playback entry minus the plugin-allocated handle. */
export type PlaybackRequest = Omit<ParticlePlayback, 'id' | 'playing'>;

/** One thing the arena should do, derived from a component write. */
export type PlaybackAction = 'start' | 'restart' | 'stop';

export type PlaybackChange = {
    action: PlaybackAction;
    /** Arena key — `${entityKey}\u0000${id}`. */
    key: string;
    /**
     * The **entity** key. `transformOf` and the node resolver take this, never `key`: a bone belongs
     * to the pawn, not to one of its playbacks.
     */
    entityKey: string;
    playback: ParticlePlayback;
    previous?: ParticlePlayback;
};

/** Arena key for one playback. The separator cannot occur in a generated entity id. */
export function playbackKey(entityKey: string, id: number): string {
    return `${entityKey}\u0000${id}`;
}

/** Next handle for a list: one past the highest in use, so handles are never reused on an entity. */
export function nextPlaybackId(playbacks: readonly ParticlePlayback[]): number {
    let highest = 0;

    for (const playback of playbacks) if (playback.id > highest) highest = playback.id;

    return highest + 1;
}

/**
 * The bone one node resolves against: the playback's override wins, **including for nodes the asset
 * left free**, else the asset's own bone, else `null` (unattached).
 *
 * Pure and shared by the three places the arena asks (pose allocation, per-frame pose resolution,
 * spawn-time attachment), so "the override beats the asset" is one rule rather than three.
 *
 * **The override adopts free nodes** (changed 2026-11-21, first playtest). The earlier rule — "a free
 * node stays free, an override only re-points the art's sockets" — meant an ability could not say
 * "put this burst on the target's chest", because none of the impact assets bind a bone: the whole
 * effect stayed at the entity's capsule centre, i.e. hip height. A gameplay request is about **where
 * the effect belongs**, not about which sockets the artist happened to use, so an override now
 * attaches every node of the asset.
 */
/**
 * Does this playback bake the bone into the spawn table instead of sampling the pose ring?
 * One rule, used by the arena's spawn pass.
 */
export function bakesAttachment(attachMode: 'pose' | 'bake' | undefined): boolean {
    return attachMode === 'bake';
}

export function resolvedNodeBone(
    override: string | undefined,
    nodeBone: string | null | undefined
): string | null {
    return override || nodeBone || null;
}

/**
 * A travel request as the arena stores it, or `undefined` when it cannot be honoured.
 *
 * A `NaN` reaching the spawn table is silent and total — every particle of the effect lands at
 * `(NaN, NaN, NaN)` and nothing draws — so the engine drops a malformed line instead of trusting the
 * caller. `seconds <= 0` is kept (it means "already arrived": `travelProgress` answers 1) and a
 * non-finite one is not.
 */
export function normalizeTravel(travel: ParticleTravel | undefined): ParticleTravel | undefined {
    if (!travel) return undefined;

    const { from, to, seconds, arcHeight } = travel;
    const values = [from[0], from[1], from[2], to[0], to[1], to[2], seconds];

    for (const value of values) if (!Number.isFinite(value)) return undefined;

    // A non-finite arc is dropped rather than the whole line: the flight is still a flight, and a
    // straight bolt is the behaviour every caller had before the field existed.
    if (arcHeight !== undefined && (!Number.isFinite(arcHeight) || arcHeight <= 0)) {
        return { from, to, seconds };
    }

    return travel;
}

/**
 * An offset as the arena stores it, or `undefined` when it cannot be honoured.
 *
 * The same rule `normalizeTravel` applies and for the same reason: a `NaN` component displaces every
 * particle of the effect to `(NaN, NaN, NaN)` — silent, total, and impossible to see as anything but
 * "nothing drew". `undefined` means "no offset", which is exactly the old behaviour.
 */
export function normalizeOffset(
    offset: readonly [number, number, number] | undefined
): readonly [number, number, number] | undefined {
    if (!offset) return undefined;

    for (const component of offset) if (!Number.isFinite(component)) return undefined;

    return offset;
}

/**
 * A scale as the arena stores it: the caller's number when it is usable, else 1 ("as authored").
 *
 * `0` and negatives are not "make it invisible": a zero scale collapses the sprite quad to a point
 * and the node offsets to the anchor, which is a malformed request wearing a legal-looking value.
 * Dropping to 1 keeps a bad number from silently deleting an effect.
 */
export function normalizeScale(scale: number | undefined): number {
    return typeof scale === 'number' && Number.isFinite(scale) && scale > 0 ? scale : 1;
}

/**
 * A tint as the arena stores it: the caller's RGB, or `undefined` (= `(1, 1, 1)`, as authored) when
 * any component is not a finite number.
 *
 * `undefined` rather than a black or a white stand-in: "no tint" has to stay distinguishable from
 * "tint to black", which is a legal request (a fully black multiply is how a layer is hidden).
 */
export function normalizeTint(
    tint: readonly [number, number, number] | undefined
): [number, number, number] | undefined {
    if (!tint) return undefined;

    const [r, g, b] = tint;

    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return undefined;

    return [r, g, b];
}

/**
 * How far along its line a particle **born** at `birthAt` starts, in [0, 1] — the one rule travel
 * rests on.
 *
 * Clamped at both ends: a playback cannot emit before it started (`0`) and, once `seconds` has
 * elapsed, the origin holds at `to` (`1`) rather than snapping back. `seconds <= 0` is "already
 * there", which is what a degenerate zero-length flight means; the caller decides whether to ask for
 * a travel at all (`combat/abilityFx.ts` → `projectileFlightSeconds` answers 0 for a 0 m gap).
 */
export function travelProgress(
    travel: ParticleTravel,
    startedAt: number,
    birthAt: number
): number {
    if (!(travel.seconds > 0)) return 1;

    const progress = (birthAt - startedAt) / travel.seconds;

    return progress <= 0 ? 0 : progress >= 1 ? 1 : progress;
}

/** Two travel requests that would render identically — the restart rule in `samePlaybackRequest`. */
export function sameOffset(
    before: readonly [number, number, number] | undefined,
    after: readonly [number, number, number] | undefined
): boolean {
    if (!before || !after) return before === after;

    return before[0] === after[0] && before[1] === after[1] && before[2] === after[2];
}

export function sameTravel(
    before: ParticleTravel | undefined,
    after: ParticleTravel | undefined
): boolean {
    if (!before || !after) return before === after;

    return (
        before.seconds === after.seconds &&
        (before.arcHeight ?? 0) === (after.arcHeight ?? 0) &&
        before.from[0] === after.from[0] &&
        before.from[1] === after.from[1] &&
        before.from[2] === after.from[2] &&
        before.to[0] === after.to[0] &&
        before.to[1] === after.to[1] &&
        before.to[2] === after.to[2]
    );
}

/** Lifetime of a playback in seconds: its own `seconds` when set, the asset's run otherwise. */
export function playbackSeconds(playback: ParticlePlayback, naturalSeconds: number): number {
    const seconds = playback.seconds ?? 0;

    return seconds > 0 ? seconds : naturalSeconds;
}

/** When a playback's slot ends: `endsAt` for the current cycle, `deadline` for the whole run. */
export type PlaybackWindow = { endsAt: number; deadline: number };

/**
 * When a playback's slot ends.
 *
 * - `endsAt` — the current cycle's end (a loop respawns here, a one-shot retires here).
 * - `deadline` — 0 for "no window": a loop with `seconds` respawns until it, a one-shot never needs
 *   one because `endsAt` already caps it.
 *
 * `seconds` is the *slot's* lifetime, not the art's: a 31 s held state asked for 0.6 s is retired at
 * 0.6 s and never respawns (its natural cycle is longer than the window). A `seconds` longer than the
 * art does not extend a one-shot — there is nothing left to draw — but does let a loop respawn until
 * the window closes (`nextCycleEnd`).
 */
export function playbackWindow(
    playback: ParticlePlayback,
    naturalSeconds: number,
    now: number
): PlaybackWindow {
    const lifetime = playbackSeconds(playback, naturalSeconds);
    const windowedLoop = !!playback.loop && (playback.seconds ?? 0) > 0;

    return {
        endsAt: now + Math.min(lifetime, naturalSeconds),
        deadline: windowedLoop ? now + lifetime : 0,
    };
}

/** End of the next cycle of a looping playback: never past its `deadline` (0 = no deadline). */
export function nextCycleEnd(now: number, naturalSeconds: number, deadline: number): number {
    const cycleEnd = now + naturalSeconds;

    return deadline > 0 ? Math.min(cycleEnd, deadline) : cycleEnd;
}

/**
 * Append a playback, evicting the oldest when the list is full.
 *
 * Append order *is* age order (the reconcile pass relies on it to report stops before starts), and
 * the evicted entries come back so a caller can say what it lost; the arena record is freed by the
 * reconcile pass, not here — this module decides, it does not act.
 */
export function startPlayback(
    playbacks: readonly ParticlePlayback[],
    request: PlaybackRequest,
    max = MAX_PLAYBACKS_PER_ENTITY
): { playbacks: ParticlePlayback[]; playback: ParticlePlayback; evicted: ParticlePlayback[] } {
    const playback: ParticlePlayback = {
        id: nextPlaybackId(playbacks),
        asset: request.asset,
        playing: true,
        loop: !!request.loop,
        seed: request.seed ?? 0,
        bone: request.bone,
        attachMode: request.attachMode,
        tint: normalizeTint(request.tint),
        offset: normalizeOffset(request.offset),
        scale: normalizeScale(request.scale),
        travel: normalizeTravel(request.travel),
        seconds: request.seconds ?? 0,
    };

    const next = [...playbacks, playback];
    const evicted: ParticlePlayback[] = [];

    while (next.length > max) evicted.push(next.shift()!);

    return { playbacks: next, playback, evicted };
}

/**
 * Mark playbacks not-playing. `id` omitted stops every playback on the entity.
 *
 * Returns `null` when nothing changed — a second stop of the same handle must not produce a component
 * write, because a write is a query wake-up and the caller may be doing this every frame.
 */
export function stopPlaybacks(
    playbacks: readonly ParticlePlayback[],
    id?: number
): ParticlePlayback[] | null {
    return stopPlaybacksWhere(playbacks, id === undefined ? () => true : (p) => p.id === id);
}

/** `stopPlaybacks` with a predicate — "stop the channels, leave the impact" (see the client's use). */
export function stopPlaybacksWhere(
    playbacks: readonly ParticlePlayback[],
    predicate: (playback: ParticlePlayback) => boolean
): ParticlePlayback[] | null {
    let changed = false;

    const next = playbacks.map((playback) => {
        if (!playback.playing || !predicate(playback)) return playback;

        changed = true;

        return { ...playback, playing: false };
    });

    return changed ? next : null;
}

/**
 * Where a playback event goes — the one rule that decides whether the ECS sees an entity at all.
 *
 * It is here, in the pure decision module, because it has a default that costs something: the plugin
 * used to fall through to `em.quickEntity({ particleSignal })` whenever no `onEvent` handler was set,
 * and nothing in the tree ever read or destroyed that entity — so every cast, hit and resist leaked
 * one, permanently (issue 001). Making the fall-through explicit makes the default auditable in node,
 * which is the point: `particles-lifecycle-sanity.mjs` asserts `drop`.
 *
 * - `'handler'` — the project passed `onEvent`; it owns the event.
 * - `'entity'` — the project opted in to `particleSignal` entities (`emitSignalEntities: true`) and
 *   is responsible for reading and destroying them.
 * - `'drop'` — nobody asked, so nothing is created; the plugin says so once instead of leaking.
 */
export function routePlaybackEvent(options: {
    onEvent?: unknown;
    emitSignalEntities?: boolean;
}): 'handler' | 'entity' | 'drop' {
    if (options.onEvent) return 'handler';

    return options.emitSignalEntities ? 'entity' : 'drop';
}

/**
 * The handler for "the arena retired this playback on its own" (natural end, or a budget/eviction
 * stop). Returns `null` the second time, which is the property the lifecycle rests on: the component
 * entry now says `playing: false`, so the next reconcile sees an unchanged finished entry instead of
 * a start request, and the effect cannot replay forever.
 */
export function markPlaybackFinished(
    playbacks: readonly ParticlePlayback[],
    id: number
): ParticlePlayback[] | null {
    return stopPlaybacks(playbacks, id);
}

/**
 * True when `after` asks for exactly the playback `before` already got: same asset, same emission
 * parameters, same lifetime, same travel line.
 *
 * `tint` is deliberately not compared — it is a look override that should reach a *live* playback, and
 * restarting an effect because a colour changed would drop every particle in flight. (The arena
 * carries the edit instead: `ParticleArena.setTint`, called from the plugin's reconcile pass.) `travel`
 * **is** compared: the line is baked into the spawn table, so a new `to` cannot reach particles already
 * emitted — the only honest answer is a restart. `offset` and `scale` are compared for the same
 * reason: both are spent in the spawn matrix (and the scale in a per-instance column), so a particle
 * already alive cannot be re-placed or re-sized — it would have to be respawned, which is a restart.
 */
export function samePlaybackRequest(before: ParticlePlayback, after: ParticlePlayback): boolean {
    return (
        !!before.playing &&
        before.asset === after.asset &&
        !!before.loop === !!after.loop &&
        (before.seed ?? 0) === (after.seed ?? 0) &&
        (before.seconds ?? 0) === (after.seconds ?? 0) &&
        before.bone === after.bone &&
        normalizeScale(before.scale) === normalizeScale(after.scale) &&
        sameOffset(normalizeOffset(before.offset), normalizeOffset(after.offset)) &&
        sameTravel(before.travel, after.travel)
    );
}

/**
 * What the arena should do for one entity's component write.
 *
 * `previous`/`current` are the two `rParticleFx.playbacks` snapshots; `liveIds` are the handles that
 * entity still holds in the arena (`ParticleArena.handlesOf`). Both the stop pass **and** the start
 * test read the arena's answer rather than the snapshot diff, because the diff cannot be trusted:
 * `TrackPrevious` keeps a *reference* and every component write overwrites it, so two writes in one
 * frame ("close the channel, then play the impact", or two `play` calls from one FX drain) collapse —
 * the intermediate value never appears in a diff. Diff-derived stops then leak the channel's arena
 * record until the entity dies, and diff-derived starts silently drop every playback but the last.
 *
 * So:
 *
 * - **stop** — a live handle whose entry is gone (evicted from the list) or no longer `playing`;
 * - **start** — a `playing` entry the arena does not hold. Not "an entry the diff calls new": that is
 *   undetectable after a collapse, and unnecessary, because every arena-side end (natural retirement,
 *   budget eviction) writes `playing: false` (§6, item 5). A start that *failed* for want of pool
 *   capacity is therefore retried on the next write to that entity, with one warning — the recovery is
 *   the point, since a pool can free space later;
 * - **restart** — a live `playing` entry whose request changed since the previous snapshot, the one
 *   remaining use of `previous` (the public API appends a new entry instead of rewriting one, so this
 *   is a safety net for code that edits the component by hand);
 * - **nothing** — everything else, which is what turns the plugin's own `playing: false` write into a
 *   no-op instead of a replay.
 *
 * Stops come first and unconditionally: eviction frees a pool run, and the newcomer that caused the
 * eviction asks for that same space — starting it first would fail the reservation and silently drop
 * the effect the player just triggered.
 */
export function planPlaybackChanges(
    entityKey: string,
    previous: readonly ParticlePlayback[] | undefined,
    current: readonly ParticlePlayback[] | undefined,
    liveIds: readonly number[]
): PlaybackChange[] {
    const changes: PlaybackChange[] = [];
    const beforeById = new Map<number, ParticlePlayback>();
    const currentById = new Map<number, ParticlePlayback>();
    const live = new Set<number>(liveIds);

    for (const playback of previous ?? []) beforeById.set(playback.id, playback);
    for (const playback of current ?? []) currentById.set(playback.id, playback);

    for (const id of liveIds) {
        if (currentById.get(id)?.playing) continue;

        changes.push({
            action: 'stop',
            key: playbackKey(entityKey, id),
            entityKey,
            playback: currentById.get(id) ?? beforeById.get(id) ?? { id, asset: '', playing: false },
            previous: beforeById.get(id),
        });
    }

    for (const playback of current ?? []) {
        if (!playback.playing) continue;

        const key = playbackKey(entityKey, playback.id);
        const before = beforeById.get(playback.id);

        if (!live.has(playback.id)) {
            changes.push({ action: 'start', key, entityKey, playback });
            continue;
        }

        if (before && !samePlaybackRequest(before, playback)) {
            changes.push({ action: 'restart', key, entityKey, playback, previous: before });
        }
    }

    return changes;
}
