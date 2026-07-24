# Worker Threading

*Engine ref: HEAD (2026-07-24)*

Source: `ecs/sabPool.ts`, `ecs/sabTransport.ts`, `ecs/replicaSet.ts`, `ecs/workerPipeline.ts`, `ecs/manager.ts` (worker mode additions).

## Overview

Workers offload compute-heavy ECS systems to Web Worker threads. The API is designed to be as transparent as possible — the same queries, systems, and pipelines work identically in both the main thread and worker. The engine handles data transport, state replication, and write-back automatically.

A `WorkerPipeline` replaces a normal `Pipeline` on the main thread. Its systems run in a worker. The worker uses a standard `Manager` instance that auto-detects the worker scope and self-wires the transport layer.

## Architecture

```
Main Thread                          Worker Thread
+------------------+                 +------------------+
| Manager (main)   |                 | Manager (worker) |
|                  |                 | mode: 'worker'   |
| patchHandlers ---+--- ReplicaSet   |                  |
| mirror queries   |   (track what   | queries (shared) |
|                  |    to send)      | systems (shared) |
|                  |       |         | pipelines        |
|                  |  SABTransport    |                  |
|                  |  (atom pools)    | SABTransport     |
+------------------+       |         +------------------+
                           | SharedArrayBuffer pool
                           | + Atomics wait/notify
```

After initialization (one `postMessage` to transfer the pool), **no more `postMessage` calls occur**. All data transfer uses `SharedArrayBuffer` + `Atomics`. Zero GC in the hot path.

## Quick Start

### Main Thread

```ts
import { Manager } from '@sprixle/ecs';
import { ComponentTypes } from './components';

const em = new Manager<ComponentTypes>();

const physicsPipeline = await em.createWorkerPipeline({
  worker: new Worker('./workers/physics.js'),
  syncMode: 'coupled',        // or 'decoupled'
  startEarly: true,           // overlap worker with main-thread systems
  sendPool: { count: 4, bufferSize: 262144 },   // 4 x 256KB main→worker
  recvPool: { count: 2, bufferSize: 65536 },    // 2 x 64KB  worker→main
  deltaFlushMode: 'perTick',
});

// Add to a parent pipeline:
em.createPipeline(inputPipeline, renderPipeline, physicsPipeline);
```

### Worker Entry

```ts
// workers/physics.ts
import { Manager } from '@sprixle/ecs';
import { ComponentTypes } from '../game/components';

const em = new Manager<ComponentTypes>();
// ↑ Manager detects DedicatedWorkerGlobalScope → mode='worker'
// ↑ self-wires SAB transport on first postMessage

// Reuse the SAME imports as the main thread:
import { physicsQuery } from '../game/queries/physics';
import { physicsSystem } from '../game/systems/physics';

em.createPipeline([physicsSystem]);
// That's it. No createWorkerContext. No new API.
```

### Shared Files

Queries and systems are defined in shared `src/game/` files, using the same `em` singleton or Manager reference:

```ts
// src/game/queries/physics.ts
import { em } from '../manager'; // same singleton import

export const physicsQuery = em.createQuery({
  includes: ['position', 'velocity', 'mass'] as const,
});
```

```ts
// src/game/systems/physics.ts
import { physicsQuery } from '../queries/physics';

export const physicsSystem = em.createSystem(
  physicsQuery.createConsumer(),
  {
    updated(entity, delta) {
      entity.components.position.x += entity.components.velocity.x * delta;
      // Writes automatically flow back to the main thread
    },
  },
);
```

## How It Works

### 1. Manager Mode Detection

The `Manager` constructor checks for `DedicatedWorkerGlobalScope`. If detected, it enters `mode: 'worker'` and:
- Registers a `self.onmessage` handler for the SAB pool handshake
- Disables `createSerializer`/`createDeserializer` (transport handles it)
- Disables the plugin DI system (not needed in workers)
- Lazy-collects query definitions for the init handshake

### 2. State Replication (ReplicaSet)

The main thread introspects the worker's query definitions to determine exactly what to replicate:

- **Auto-detected `neededComponentTypes`**: union of all query `includes`
- **`extraComponents`** (optional override): extends the auto-set
- **Mirror queries**: main-thread copies of worker queries track entity membership

`patchHandlers` are chained to intercept component mutations. Only mutations on tracked entities for needed component types are accumulated as deltas.

### 3. Delta Types

| Trigger | Delta | Contents |
|---------|-------|----------|
| Entity enters worker query | Entity add | Full snapshot of needed components |
| Entity exits ALL worker queries | Entity remove | Entity ID + all needed components marked deleted |
| Component mutation on tracked entity | Component delta | `{ key: newValue }` (`undefined` = delete) |

### 4. Write-Back

Worker systems mutate components identically to main-thread systems. In worker mode, the entity Proxy additionally buffers mutations for write-back. The buffer is drained after each tick and sent back to the main thread via the SAB pool.

Entity authorship tracking prevents write-back loops:
- Deltas received from main are applied via `quietSet` (bypasses Proxy)
- Worker system mutations go through the Proxy → buffered for write-back
- Worker-created entities (optimistic `quickEntity`) emit `create` write-back entries
- Worker-destroyed entities emit `destroy` write-back entries

### 5. Conflict Resolution

First pass: **last-write-wins**. Worker writes for a component overwrite main-thread writes in the same frame. This is correct for compute workers where the worker is the authority for its domain.

**Constraint:** The user must partition component ownership. A given component type should be mutated by at most one thread (main or a single worker). Mutating the same entity's component from both threads will produce data loss under last-write-wins.

## WorkerPipeline Configuration

```ts
interface WorkerPipelineConfig {
  worker: Worker;
  syncMode: 'coupled' | 'decoupled';

  // Pool
  sendPool?: { count: number; bufferSize: number };  // default: { count: 4, bufferSize: 262144 }
  recvPool?: { count: number; bufferSize: number };  // default: { count: 2, bufferSize: 65536  }

  // Component override
  extraComponents?: string[];

  // Delta cadence
  deltaFlushMode?: 'perTick' | 'interval' | 'manual';  // default: 'perTick'
  deltaFlushInterval?: number;                           // default: 16 (ms)

  // Coupled mode
  startEarly?: boolean;     // fire-and-forget tick at start, await later. default: false
  tickTimeout?: number;     // ms before skipping frame. default: 33

  // Decoupled mode
  tickRate?: number;         // ms between worker ticks. default: 16
  maxPendingTicks?: number;  // backpressure cap. default: 3

  // Pipeline interface
  tag?: string;
  interval?: ReturnType<typeof interval>;
  condition?: () => boolean;
  useInternalTime?: boolean;
}
```

## Coupled vs Decoupled

### Coupled (`syncMode: 'coupled'`)

The worker tick is synchronous with the main thread frame:

1. Main sends tick + deltas to worker
2. Worker runs its systems
3. Worker sends writes back
4. Main applies writes, continues

`startEarly: true` optimizes overlap: the tick is sent at the start of the pipeline, and the result is awaited at the end — worker runs in parallel with downstream main-thread systems.

### Decoupled (`syncMode: 'decoupled'`)

The worker runs on its own interval, independent of the main thread tick rate:

1. Worker ticks at `tickRate` ms (e.g., 16ms for 60fps)
2. Worker sends writes back after each tick
3. Main thread polls for writes during its own tick loop
4. `maxPendingTicks` caps unprocessed write batches (backpressure)

Use decoupled mode for background systems (AI, pathfinding, world simulation) that don't need frame synchronization.

## Manager Worker Mode (Internals)

When `mode === 'worker'`, these Manager methods change behavior:

| Method | Main Mode | Worker Mode |
|--------|-----------|-------------|
| `createQuery` | Creates query | Same, + collects definition for handshake |
| `quickEntity` | Creates authoritative entity | Creates optimistic replica, queues `create` write-back |
| `deregisterEntity` | Removes entity | Same, + queues `destroy` write-back |
| Component Proxy `set` | Applies locally, stages | Same, + buffers write-back |
| Component Proxy `delete` | Applies locally | Same, + buffers write-back |
| `createSerializer` | Creates BSON serializer | Throws `Error` |
| `createDeserializer` | Creates BSON deserializer | Throws `Error` |
| Plugin DI (`em.plugins`) | Full plugin system | No-op |
| `createAsyncSystem` | Creates async system | Throws `Error` (deferred) |

### What's Unsupported in Workers

- `createAsyncSystem` — deferred (yield conditions need main-thread awareness)
- `createSerializer` / `createDeserializer` — transport handles serialization internally
- Plugin DI system — compute-only; plugins requiring DOM/network don't belong in workers
- `em.tick()` — the worker's tick is driven by the transport, not the main loop
- `createWorkerPipeline` — throws (can't nest worker pipelines from a worker)

## SAB Pool Transport (Internals)

### Pool Layout

Each pool buffer is a single `SharedArrayBuffer`:

```
Offset  Size   Field
0       4      owner (0=free, 1=main, 2=worker)
4       4      dataLength (bytes written)
8       4      sequence (monotonic)
12      4      flags (reserved)
16      N-16   BSON payload
```

### Signal SAB

A 64-byte `SharedArrayBuffer` for notification:

```
Offset  Size   Field
0       4      mainPending
4       4      mainSeq
8       4      workerPending
12      4      workerSeq
16      4      shutdownFlag
20      4      mainFreeCount
24      4      workerFreeCount
```

### BSON Serialization

All payloads are BSON-encoded via deepkit. Serialization writes to a stack-local scratch buffer, then `memcpy`s into the pool buffer payload. If the message exceeds the pool buffer size, a descriptive error is thrown — the user tunes the pool config. No runtime allocation fallback.

### Atomics Synchronization

After the initial `postMessage` transfers pool ownership, communication uses `Atomics`:

1. **Acquire**: `Atomics.compareExchange` claims a free buffer
2. **Write**: BSON data written to buffer payload
3. **Release**: Owner tag set to receiver, pending flag set
4. **Signal**: `Atomics.notify` wakes the receiver
5. **Return**: After reading, receiver sets buffer back to free

## Deployment Requirements

**SharedArrayBuffer requires COOP/COEP headers.** The server must send:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

**Atomics.wait browser compatibility:** The main thread may need `Atomics.waitAsync` (Chrome 87+) or a `postMessage` fallback, as some browsers restrict `Atomics.wait` to worker threads only.

**Deepkit reflection in worker bundles:** Worker webpack/build configs must include `@deepkit/type` reflection metadata (same as the main build). Without it, component type annotations (`SingletonComponent`, `Nested`, `TrackPrevious`, `Pointer`) are silently lost.

## SCARs

- **Component ownership**: If both main and worker mutate the same entity's component in the same frame, last-write-wins can produce data loss. This is a documentation constraint — the user must partition component ownership by thread.
- **Oversized messages**: If a snapshot or delta exceeds the pool buffer size, a descriptive error is thrown. The user must increase `sendPool.bufferSize` or split data. No automatic overflow handling.
- **SAB transfer semantics**: `postMessage` with transfer list neuters the sender. The init handshake transfers all pool buffers in one batch. Each side holds its own reference afterward — no further `postMessage` calls.
