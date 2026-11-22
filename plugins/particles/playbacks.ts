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
    /** Reserved: per-playback colour multiply (carried, not yet applied in the shader). */
    tint?: [number, number, number];
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
        tint: request.tint,
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
 * parameters, same lifetime.
 *
 * `tint` is deliberately not compared — it is a look override that should reach a *live* playback, and
 * restarting an effect because a colour changed would drop every particle in flight.
 */
export function samePlaybackRequest(before: ParticlePlayback, after: ParticlePlayback): boolean {
    return (
        !!before.playing &&
        before.asset === after.asset &&
        !!before.loop === !!after.loop &&
        (before.seed ?? 0) === (after.seed ?? 0) &&
        (before.seconds ?? 0) === (after.seconds ?? 0) &&
        before.bone === after.bone
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
