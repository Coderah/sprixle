/**
 * WorkerPipeline — offloads systems to a Web Worker.
 * Implements the Pipeline interface so it can be composed into
 * existing pipeline structures.
 */

import type { defaultComponentTypes, Manager } from './manager';
import { Pipeline, AnySystem } from './system';
import { SABTransport, SerializedQueryDef, WriteEntry } from './sabTransport';
import type { TransportConfig } from './sabPool';
import { ReplicaSet } from './replicaSet';
import { interval as createInterval } from '../util/timing';
import { now } from '../util/now';

// ── Config Types ───────────────────────────────────────────────────

export interface WorkerPipelineConfig {
    /** The Web Worker instance or URL */
    worker: Worker;

    /** Sync mode */
    syncMode: 'coupled' | 'decoupled';

    /** Pool configuration */
    sendPool?: { count: number; bufferSize: number };
    recvPool?: { count: number; bufferSize: number };

    /** Additional component types to replicate beyond auto-detected */
    extraComponents?: string[];

    /** Delta flush cadence */
    deltaFlushMode?: 'perTick' | 'interval' | 'manual';
    deltaFlushInterval?: number;

    /** Coupled mode options */
    startEarly?: boolean;
    tickTimeout?: number;

    /** Decoupled mode options */
    tickRate?: number;
    maxPendingTicks?: number;

    /** Pipeline interface options */
    tag?: string;
    interval?: ReturnType<typeof createInterval>;
    condition?: () => boolean;
    useInternalTime?: boolean;
}

// ── WorkerPipeline ─────────────────────────────────────────────────

export class WorkerPipeline<
    CT extends defaultComponentTypes,
> implements Pipeline<CT> {
    protected manager: Manager<CT>;
    systems = new Set<AnySystem<CT>>(); // empty — systems run in worker

    readonly tag: string;
    readonly interval?: ReturnType<typeof createInterval>;
    condition: () => boolean;
    useInternalTime: boolean;
    deltaPerTick = 0;
    lag = 0;
    now = 0;
    getTimeScale?: () => number;

    private _worker: Worker;
    private _transport!: SABTransport;
    private _replicaSet: ReplicaSet<CT>;
    private _syncMode: 'coupled' | 'decoupled';
    private _initResolve!: () => void;
    private _initPromise: Promise<void>;
    private _initialized = false;

    // Coupled mode
    private _startEarly: boolean;
    private _tickTimeout: number;
    /** Result from the previous fire-and-forget tick, awaiting collection */
    private _pendingResult: { msg: any; seq: number } | null = null;

    // Decoupled mode
    private _tickRate: number;
    private _maxPendingTicks: number;
    private _pendingWrites: WriteEntry[][] = [];
    private _workerInterval?: ReturnType<typeof setInterval>;

    // Delta flush
    private _deltaFlushMode: 'perTick' | 'interval' | 'manual';
    private _deltaFlushInterval: number;
    private _lastFlushTime = 0;
    private _lastRecvSeq = 0;

    private readonly defaultConfig = {
        sendPool: { count: 4, bufferSize: 262144 },
        recvPool: { count: 2, bufferSize: 65536 },
        tickTimeout: 33,
        tickRate: 16,
        maxPendingTicks: 3,
        deltaFlushMode: 'perTick' as const,
        deltaFlushInterval: 16,
    };

    constructor(manager: Manager<CT>, config: WorkerPipelineConfig) {
        this.manager = manager;
        this._worker = config.worker;
        this._syncMode = config.syncMode;
        this._replicaSet = new ReplicaSet(manager);

        this.tag = config.tag || `WorkerPipeline[${now()}]`;
        this.interval = config.interval;
        this.condition = config.condition || (() => true);
        this.useInternalTime = config.useInternalTime || false;

        this._startEarly = config.startEarly ?? false;
        this._tickTimeout = config.tickTimeout ?? this.defaultConfig.tickTimeout;

        this._tickRate = config.tickRate ?? this.defaultConfig.tickRate;
        this._maxPendingTicks = config.maxPendingTicks ?? this.defaultConfig.maxPendingTicks;

        this._deltaFlushMode = config.deltaFlushMode ?? 'perTick';
        this._deltaFlushInterval = config.deltaFlushInterval ?? this.defaultConfig.deltaFlushInterval;

        this._initPromise = new Promise((resolve) => { this._initResolve = resolve; });

        // Kick off init handshake
        this._startInit(config);
    }

    // ── Init ────────────────────────────────────────────────────────

    private async _startInit(config: WorkerPipelineConfig): Promise<void> {
        // 1. Allocate SAB pools
        const poolConfig: TransportConfig = {
            sendPool: config.sendPool || this.defaultConfig.sendPool,
            recvPool: config.recvPool || this.defaultConfig.recvPool,
        };
        const { transport, initMessage, transfer } = SABTransport.initMain(poolConfig);
        this._transport = transport;

        // 2. Transfer SABs to worker
        this._worker.postMessage(initMessage, { transfer });

        // 3. Wait for worker to send query definitions
        const initMsg = transport.awaitMessage(5000);
        if (!initMsg || initMsg.msg.type !== 'init') {
            console.error('[WorkerPipeline] Worker did not send init message');
            return;
        }

        const queryDefs = (initMsg.msg as any).queryDefs as SerializedQueryDef[];

        // 4. Initialize ReplicaSet with query definitions
        this._replicaSet.init(queryDefs, { extraComponents: config.extraComponents });

        // 5. Send initial snapshot
        const snapshot = this._replicaSet.buildSnapshot();
        transport.sendSnapshot(snapshot);

        // 6. Ready
        this._initialized = true;
        this._initResolve();

        // 7. If decoupled, start the worker tick interval
        if (this._syncMode === 'decoupled') {
            this._startDecoupledLoop();
        }
    }

    // ── Pipeline Interface ──────────────────────────────────────────

    init(): void {
        // Init is handled by constructor + _startInit
    }

    reset(): void {
        this._pendingResult = null;
        if (this._initialized) {
            this._transport.sendReset();
            this._replicaSet.destroy();
            this._pendingWrites = [];
            this._lastRecvSeq = 0;
        }
    }

    tick(delta: number): void {
        if (!this._initialized) return;
        if (this.interval) {
            const intervalDelta = this.interval(delta);
            if (!intervalDelta) return;
            delta = intervalDelta;
        }
        if (delta <= 0) return;
        if (!this.condition()) return;
        if (this.useInternalTime) this.now += delta;

        if (this._syncMode === 'coupled') {
            this._coupledTick(delta);
        } else {
            this._decoupledMainTick();
        }
    }

    /** Terminate the worker */
    terminate(): void {
        // Drain any pending tick result
        if (this._pendingResult) {
            this._applyTickResult(this._pendingResult);
            this._pendingResult = null;
        }
        if (this._workerInterval) {
            clearInterval(this._workerInterval);
            this._workerInterval = undefined;
        }
        this._transport.sendShutdown();
        this._worker.terminate();
        this._replicaSet.destroy();
    }

    // ── Coupled Mode ────────────────────────────────────────────────

    private _coupledTick(delta: number): void {
        let deltas: any = null;

        // Flush deltas based on cadence
        if (this._shouldFlushDeltas(delta)) {
            const flushResult = this._replicaSet.flush();
            deltas = flushResult?.patches;
        }

        // If startEarly: collect the result from the PREVIOUS tick first
        if (this._startEarly && this._pendingResult) {
            this._applyTickResult(this._pendingResult);
            this._pendingResult = null;
        }

        // Send tick and deltas to worker
        if (deltas) this._transport.sendDeltas(deltas);
        this._transport.sendTick(delta);

        if (!this._startEarly) {
            // Block until worker finishes (zero latency, zero overlap)
            const result = this._transport.awaitMessage(this._tickTimeout);
            if (result) this._applyTickResult(result);
        } else {
            // Fire-and-forget: result will be collected on the next tick() call
            // This provides one-frame overlap — the worker runs in parallel
            // while downstream pipelines execute.
        }
    }

    private _applyTickResult(result: { msg: any; seq: number }): void {
        if (result.msg.type === 'tickComplete') {
            this._replicaSet.applyWrites(result.msg.writes);
            this.manager.subTick();
        }
    }

    // ── Decoupled Mode ──────────────────────────────────────────────

    private _startDecoupledLoop(): void {
        const sendDelta = this._tickRate;

        this._workerInterval = setInterval(() => {
            let deltas: any = null;

            if (this._shouldFlushDeltas(sendDelta)) {
                const flushResult = this._replicaSet.flush();
                deltas = flushResult?.patches;
            }

            if (deltas) this._transport.sendDeltas(deltas);
            this._transport.sendTick(sendDelta);

            // Worker will respond with tickComplete at its own pace
        }, this._tickRate) as unknown as ReturnType<typeof setInterval>;
    }

    private _decoupledMainTick(): void {
        // Poll for completed worker ticks (non-blocking)
        while (this._transport.hasPending()) {
            const result = this._transport.tryRecv();
            if (!result) break;

            if (result.msg.type === 'tickComplete') {
                // Backpressure: drop oldest if too many pending
                this._pendingWrites.push(result.msg.writes);
                if (this._pendingWrites.length > this._maxPendingTicks) {
                    this._pendingWrites.shift();
                }
            }
        }

        // Apply next pending write batch (one per main tick)
        if (this._pendingWrites.length > 0) {
            const writes = this._pendingWrites.shift()!;
            this._replicaSet.applyWrites(writes);
            this.manager.subTick();
        }
    }

    // ── Delta Flush ─────────────────────────────────────────────────

    private _shouldFlushDeltas(delta: number): boolean {
        if (this._deltaFlushMode === 'perTick') return true;
        if (this._deltaFlushMode === 'manual') return false;

        this._lastFlushTime += delta;
        if (this._lastFlushTime >= this._deltaFlushInterval) {
            this._lastFlushTime = 0;
            return true;
        }
        return false;
    }
}
