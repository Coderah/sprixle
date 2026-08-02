# Manager.tick → start(delta) / end()

*Engine ref: <current> (2026-07-27)*

`Manager.tick()` is deprecated and throws an error. Replace with `Manager.start(delta)` and `Manager.end()`.

## Why the split

The old `tick()` did two things in one call: advanced simulation time (implicitly, via pipeline ticks) and ran end-of-frame cleanup. This was fine while time was wall-clock only, but broke when `state.now` became an explicit accumulating counter that survives serialization.

### Accumulating simulation time

`state.now` is a monotonically-increasing number that lives in `EntityAdminState` — the same state block that is BSON-serialized for save/load, network sync, and undo logs. When you deserialize a saved world and resume, `state.now` picks up where it left off instead of resetting to zero.

`start(delta)` is the increment point: `this.state.now += delta`. A single accumulating clock means every timestamp in the simulation — `createdAt`, `updatedAt`, `startedAt`-style components, any delta-accumulation math — shares one consistent timebase that is meaningful across sessions.

### `now()` points to the last active manager

```
now() = activeTimeTarget.now | Date.now()
```

`start(delta)` calls `setActiveTimeTarget(this.state)`, making the manager the active target. Pipelines with `useInternalTime: true` temporarily override this during their tick, then restore the manager as target. The result: systems, component writes, and the `createdAt`/`updatedAt` defaults all read simulation time through `now()`, not wall-clock time.

When no manager is active (between frames, outside simulation), `now()` falls back to `Date.now()`.

### `now.real()` for wall-clock

`now.real()` always returns `Date.now()` — use it when you genuinely need system time (e.g. ping measurement, heartbeats, render throttling independent of simulation speed).

## What `startedAt`-style components get for free

Components set via `entity.components.${stateName}StartedAt = now()` (as `stateMachinePlugin` does, and many hand-rolled FSMs do) automatically reflect simulation time rather than wall-clock time. This means:
- A pause/hitstop that slows simulation delta doesn't distort elapsed-time comparisons
- A loaded save game has timestamps consistent with the state's accumulated `now` value
- Two sessions running the same deterministic simulation produce identical timestamps

## Migration

**Before:**
```ts
function frame(delta: number) {
    mainPipeline.tick(delta);
    em.tick();
    requestAnimationFrame(frame);
}
```

**After:**
```ts
function frame(delta: number) {
    em.start(delta);            // advance simulation clock, set as active time target
    mainPipeline.tick(delta);
    mainPipeline2.tick(delta);  // multiple pipelines share the same frame's delta
    em.end();                   // final subTick, query tick, entity-set rotation
    requestAnimationFrame(frame);
}
```

All references to `em.tick()` should be replaced with `em.end()`. The `em.start(delta)` call should precede all pipeline ticks for the frame.

### Pacing frames with `now.real()`

`start(delta)` makes the manager the active time target and **it stays active between frames** — nothing clears it until the next `start()` call. So `now()` returns simulation time everywhere after the first frame, not just inside systems. The canonical rAF loop must measure frame time off the wall clock:

```ts
// ✅ canonical
let time = now.real();

function frame() {
    const newTime = now.real(); // wall clock — immune to the sim-clock target
    const delta = newTime - time;
    time = newTime;

    em.start(delta);            // advance simulation clock, set as active time target
    mainPipeline.tick(delta);
    mainPipeline2.tick(delta);  // multiple pipelines share the same frame's delta
    em.end();

    requestAnimationFrame(frame);
}
```

```ts
// ❌ broken — frame 2 delta goes hugely negative
let time = now();
function frame() {
    const newTime = now(); // frame 1: wall clock; frame 2+: simulation clock!
    const delta = newTime - time; // simClock - wallClock ≈ -1.7e12
    ...
}
```

Frame 1 measures wall→wall and runs fine (it may fire the frame's first RPCs). Frame 2 mixes clocks: `newTime` is the small accumulated sim clock while `time` still holds the wall-clock value from frame 1, so `delta` goes hugely negative and `Pipeline.realTick` early-returns on `delta <= 0` — every pipeline stops running for the rest of the session, while any promise callbacks from frame 1 keep logging as if the app were healthy. (Whence hit exactly this: `query_clips` fired and its response logged via tauri-conduit, but the async generator was never resumed and the list stayed empty.)

## What `end()` does

Carries the same cleanup work the old `tick()` did:
- `subTick()` — flush staged updates to queries/consumers/patchHandlers
- Rotate entity sets: `updatedEntities` → `previouslyUpdatedEntities`, clear `newEntities`, `deletedEntities`
- Tick all queries (advance time-slicing, consumer state)
- Run one-shot `tickHandlers`
