# Networking — shared client/server code

*Engine ref: f3f5215 (2026-07-05)*

Source: `plugins/network/{networkPlugin,createServer,createClient,rpc,reconciliationPlugin,types}.ts`.
Reference implementations: **cursory-world** (full multiplayer game, patch-sync + RPC + reconciliation) and **test-pilots** (device fleet, targeted entity sync). Read those branches when in doubt.

## The model in one paragraph

Everything meaningful lives in **shared code** (`src/game/`): the component types, the command enum, the network instance, encoders, RPC actions, and the simulation. `applyNetwork` is called **exactly once**, in a shared module, on the shared manager. The client and server **entries** differ only in which transport factory wraps that same network object (`createClient` vs `createServer`) and which extra systems/receive-handlers each build imports. Transport is binary WebSocket frames, BSON-encoded `[command, data]`.

```ts
// src/game/gameNetwork.ts — SHARED
export enum GameCommands { ping, ack, statePatch, entity, deleteEntity, selfPlayer, movePlayer, ... }
export const network = applyNetwork<GameCommands, ComponentTypes>(em); // default export of networkPlugin
export const { send, receive } = network;

// src/server/entry.ts
createServer({ port: 1337 /*, httpServer */ }, network);
actions.registerServerHandlers();
const serverPipeline = new Pipeline(em, newClientSystem, syncSystem);

// src/client/entry.ts (via e.g. client.ts)
const { connect } = createClient(`${GAME_NETWORK_IP}:1337`, network, { heartbeat: {...} });
```

Environment flags (`IS_CLIENT`, `IS_NETWORKED`) come from webpack DefinePlugin / globalThis and gate authority everywhere — most importantly:

```ts
simulationPipeline.condition = () => !IS_CLIENT || !IS_NETWORKED;
// the same shared sim runs on the server (or offline sandbox), NEVER on a networked client
```

**Handler registration is an import side effect.** `network.receive(cmd, fn)` runs when its module is imported; which side a handler belongs to is determined purely by which build imports that module. Keep server-only receive modules out of the client import graph (and vice versa) — this is the main reason the `game/`/`client/`/`server/` split must stay clean, and why import order is occasionally load-bearing (reconciliation → encoders → actions). Comment any such ordering.

## Sessions: the socket entity

A connected peer **is an entity** carrying a `socket` component (`network.getClientEntity(socket)`); `NetworkComponentTypes = { socket }`. There is no separate session wrapper — put player/device components directly on it. A consumer over `includes: ['socket']` is your join/leave system (`forNew` = joined, `removed` = left → deregister).

Caveats learned in production (test-pilots):
- **One device id can own multiple live socket entities** (multiple screens on one id, plus half-open zombies). Every "send to device/role" path must fan out over ALL open sockets for that identity and filter `readyState === OPEN`. Model device presence explicitly; don't assume 1 socket = 1 device.
- **Half-open sockets are inevitable on wifi.** The engine provides both halves: `createServer` runs a native ping/pong sweep (15s) that terminates zombies; `createClient` has app-level heartbeat/verify/force-reconnect (browsers cannot send WS ping frames — you need an app-level Ping/Pong command pair). Wire both from day one for anything with passive/display clients.
- Client reconnect: re-init state in `setOnConnect`, preserve identity (e.g. `selfPlayerId`) across reconnects.

## Wire format & encoders

`MessageData = string | Uint8Array | number | (string|number|null)[] | bigint`. The rule for choosing:

- **Flat arrays of primitives** for small command tuples (hello/status/votes). Empty string as null sentinel. Document each command's payload shape next to the enum.
- **BSON `Uint8Array` blobs** for entity snapshots and nested structures, produced by `em.createSerializer<T>()` in a shared `encoders.ts`:

```ts
type SerializableComponents = Omit<ComponentTypes, 'socket'>;  // sockets never cross the wire
type StatePatch = Map<EntityId, Partial<SerializableComponents>>;
registerVectorSerializers();
export const encodeEntity = em.createSerializer<{ id: EntityId; components: Partial<SerializableComponents> }>();
export const encodeStatePatch = em.createSerializer<StatePatch>();
```

## State sync — two proven shapes

### A. Broadcast patch-sync (cursory-world; right for real-time games)

Server-only: install `patchHandlers` that accumulate every mutation into a `Map<EntityId, Partial<SerializableComponents>>` queue (component removal encoded as `{ key: undefined }`). A `syncSystem` on `interval(16.7)` (accumulative = false) encodes the queue once and broadcasts `statePatch`, decoupling sync rate from tick rate.

Client receive: for each `[id, components]` — get-or-create entity; `undefined` → `delete`; call `entity.willUpdate(key)` before assigning vectors so `TrackPrevious` snapshots for lerping. New client bootstrap: send its own entity (`selfPlayer`), then replay existing world entities.

### B. Targeted entity projection (test-pilots; right for role/device fleets)

Server walks the relevant entity subtree per recipient and sends whole-entity `SyncEntity` blobs to specific sockets. Client applies an **authoritative merge that also deletes keys the server no longer has** — otherwise cleared components linger forever.

There is currently **no engine "sync this subtree to these sockets" helper** — projection is hand-walked (test-pilots has ~50 call sites). If you're building shape B, write that helper first (see `engine-roadmap.md`).

Client-created optimistic entities: prefix ids (e.g. `'c' + n`) so they can't collide with server ids.

## RPC — intents from client to server

```ts
export class GameActions extends RPCActions<GameCommands, ComponentTypes> {
    @RPC(GameCommands.movePlayer, 'basic')   // strategy: 'none' | 'basic' | 'replay'(TODO)
    movePlayer(x: number, y: number, player = this.client) {
        player.willUpdate('position');
        player.components.position.set(x, y);
    }
}
export const actions = new GameActions(em, network, IS_CLIENT, IS_NETWORKED);
// server entry: actions.registerServerHandlers();
```

- **The trailing `player = this.client` default-arg is the key idiom**: on the client `this.client` resolves to the local player (via `defaultClientEntity`), on the server to the sending socket entity — one method body serves both.
- On a networked client the decorator wrapper (optionally predicts, then) sends `[version?, ...params]` instead of running the body; on server/offline it runs the body.
- Guard privileged RPCs inside the body (`if (this.client.components.playerRole !== 'admin') return;`) — remember any client can send any command.
- `network.message<R>(command)` gives a one-shot promise for request/response flows (time-sync ping/RTT).

## Reconciliation (client prediction)

`reconciliationPlugin` (apply in shared code; optional dependency of networkPlugin). Only `'basic'` is implemented:

1. Client RPC wrapper takes `version = getNextVersion()`, runs the body **optimistically**, `trackReconcilableAction(strategy, version)` stamps touched components (reads `stagedUpdates` — timing-sensitive), sends `[version, ...params]`.
2. Server runs the body, then `applyReconciliationVersion(version)` stamps the same `reconciliationVersions` server-side so they sync back.
3. On every incoming frame, `resolveReconcilableActions()` compares: predicted version > server's → restore the optimistic value from `previousComponents` via `quietSet` (keep prediction); else drop the prediction.

Requires `ReconciliationComponentTypes` (`reconciliationVersions`) in your ComponentTypes and `TrackPrevious` on predicted components. Known limitations: one **global** version counter, `'replay'` unimplemented, tight coupling to subTick timing — keep predicted mutations simple (position-like).

## Footguns checklist

- **One receiver per command.** Registering a second `receive` for the same command overrides (console warning only).
- **`send(cmd, data)` with no target on the server broadcasts to every socket entity.** Easy to broadcast accidentally — always pass the target socket/entity for directed sends.
- `encoders.ts` accretes non-wire serialization (save format, undo log) because everything needs `SerializableComponents` — keep sections labeled.
- `createClient`/`createServer` import `applyNetwork` as a named import but networkPlugin only default-exports it (works because it's type-position only) — import the default.
- Never let a patchHandler with side effects (auto-save/sync) run against a reconnecting entity before its persisted config has loaded — this has destroyed saved state in production.
