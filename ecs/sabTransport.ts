/**
 * SABTransport — higher-level transport layer wrapping SABPool.
 * Provides a typed message-passing interface for the WorkerPipeline.
 */

import type { EntityId } from './manager';
import {
    SABPool,
    TransportConfig,
    createInitTransfer,
} from './sabPool';

// ── Wire Types ─────────────────────────────────────────────────────

export interface WorkerInit {
    type: 'init';
    queryDefs: SerializedQueryDef[];
}

export interface WorkerSnapshot {
    type: 'snapshot';
    entities: Record<EntityId, Record<string, unknown>>;
}

export interface WorkerDeltas {
    type: 'deltas';
    patches: Array<{
        entity: EntityId;
        set: Record<string, unknown>;
        delete: string[];
    }>;
}

export interface WorkerTick {
    type: 'tick';
    delta: number;
}

export interface WorkerTickComplete {
    type: 'tickComplete';
    writes: Array<WriteEntry>;
}

export interface WorkerReset {
    type: 'reset';
}

export interface WorkerShutdown {
    type: 'shutdown';
}

export type WorkerMessage =
    | WorkerInit
    | WorkerSnapshot
    | WorkerDeltas
    | WorkerTick
    | WorkerTickComplete
    | WorkerReset
    | WorkerShutdown;

export interface SerializedQueryDef {
    includes: string[];
    excludes?: string[];
    flexible?: boolean;
    index?: string;
}

export interface WriteEntry {
    entity: EntityId;
    set: Record<string, unknown>;
    delete: string[];
    create?: Record<string, unknown>;
    destroy?: boolean;
}

// ── Transport ──────────────────────────────────────────────────────

export class SABTransport {
    readonly sendPool: SABPool;
    readonly recvPool: SABPool;
    private _recvSeq: number = 0;

    constructor(sendPool: SABPool, recvPool: SABPool) {
        this.sendPool = sendPool;
        this.recvPool = recvPool;
    }

    get isShutdown(): boolean {
        return this.recvPool.isShutdown;
    }

    // ── Send ────────────────────────────────────────────────────────

    send(msg: WorkerMessage): void {
        this.sendPool.writeMessage(msg);
    }

    sendInit(queryDefs: SerializedQueryDef[]): void {
        this.send({ type: 'init', queryDefs });
    }

    sendSnapshot(entities: Record<EntityId, Record<string, unknown>>): void {
        this.send({ type: 'snapshot', entities });
    }

    sendDeltas(patches: WorkerDeltas['patches']): void {
        this.send({ type: 'deltas', patches });
    }

    sendTick(delta: number): void {
        this.send({ type: 'tick', delta });
    }

    sendTickComplete(writes: WriteEntry[]): void {
        this.send({ type: 'tickComplete', writes });
    }

    sendReset(): void {
        this.send({ type: 'reset' });
    }

    sendShutdown(): void {
        this.sendPool.signalShutdown();
    }

    // ── Recv ────────────────────────────────────────────────────────

    /** Non-blocking: read next message or null */
    tryRecv(): { msg: WorkerMessage; seq: number } | null {
        const result = this.recvPool.readMessage(this._recvSeq);
        if (!result) return null;
        this._recvSeq = result.seq;
        return { msg: result.data as WorkerMessage, seq: result.seq };
    }

    /** Blocking: await next message with optional timeout */
    awaitMessage(timeoutMs?: number): { msg: WorkerMessage; seq: number } | null {
        const result = this.recvPool.awaitMessage(this._recvSeq, timeoutMs);
        if (!result) return null;
        this._recvSeq = result.seq;
        return { msg: result.data as WorkerMessage, seq: result.seq };
    }

    /** Non-blocking poll for pending inbound messages */
    hasPending(): boolean {
        return this.recvPool.hasPending();
    }

    // ── Static: Init Setup ──────────────────────────────────────────

    /** Main thread side: allocate pools and create init transfer for a Worker */
    static initMain(config: TransportConfig): {
        transport: SABTransport;
        initMessage: { type: 'sabInit'; sendSABs: SharedArrayBuffer[]; recvSABs: SharedArrayBuffer[]; signalSAB: SharedArrayBuffer };
        transfer: SharedArrayBuffer[];
    } {
        const { sendPool, recvPool } = SABPool.createMain(config);
        const transport = new SABTransport(sendPool, recvPool);
        const { message: initMessage, transfer } = createInitTransfer(sendPool, recvPool);
        return { transport, initMessage, transfer };
    }

    /** Worker side: create transport from received SABs */
    static initWorker(
        sendSABs: SharedArrayBuffer[],
        recvSABs: SharedArrayBuffer[],
        signalSAB: SharedArrayBuffer,
    ): SABTransport {
        const { sendPool, recvPool } = SABPool.createWorker(sendSABs, recvSABs, signalSAB);
        return new SABTransport(sendPool, recvPool);
    }
}
