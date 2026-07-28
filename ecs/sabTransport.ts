/**
 * SABTransport — higher-level transport layer wrapping SABPool.
 * Provides a typed BSON message-passing interface for the WorkerPipeline.
 *
 * The pool handles raw bytes; the transport handles BSON serialization
 * and the message type definitions.
 */

import {
    bsonBinarySerializer,
    deserializeBSON,
    serializeBSON,
} from '@deepkit/bson';
import type { EntityId } from './manager';
import { SABPool, TransportConfig, createInitTransfer } from './sabPool';

// ── Wire Message Types ──────────────────────────────────────────────

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

export interface WorkerInitMsg {
    type: 'init';
    queryDefs: SerializedQueryDef[];
}

export interface WorkerSnapshotMsg {
    type: 'snapshot';
    entities: Record<EntityId, Record<string, unknown>>;
}

export interface WorkerDeltasMsg {
    type: 'deltas';
    patches: Array<{
        entity: EntityId;
        set: Record<string, unknown>;
        delete: string[];
    }>;
}

export interface WorkerTickMsg {
    type: 'tick';
    delta: number;
}

export interface WorkerTickCompleteMsg {
    type: 'tickComplete';
    writes: WriteEntry[];
}

export interface WorkerResetMsg {
    type: 'reset';
}

export interface WorkerShutdownMsg {
    type: 'shutdown';
}

export type WorkerMessage =
    | WorkerInitMsg
    | WorkerSnapshotMsg
    | WorkerDeltasMsg
    | WorkerTickMsg
    | WorkerTickCompleteMsg
    | WorkerResetMsg
    | WorkerShutdownMsg;

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
        let serialized: Uint8Array;
        try {
            serialized = serializeBSON<WorkerMessage>(
                msg,
                bsonBinarySerializer
            );
        } catch (e) {
            throw new Error(
                `[SABTransport] BSON serialization failed: ${(e as Error).message}`
            );
        }
        this.sendPool.writeRaw(serialized);
    }

    sendInit(queryDefs: SerializedQueryDef[]): void {
        this.send({ type: 'init', queryDefs });
    }

    sendSnapshot(entities: Record<EntityId, Record<string, unknown>>): void {
        this.send({ type: 'snapshot', entities });
    }

    sendDeltas(patches: WorkerDeltasMsg['patches']): void {
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
        const result = this.recvPool.readRaw(this._recvSeq);
        if (!result) return null;
        this._recvSeq = result.seq;
        let msg: WorkerMessage;
        try {
            msg = deserializeBSON<WorkerMessage>(
                result.data,
                0,
                bsonBinarySerializer
            ) as WorkerMessage;
        } catch (e) {
            throw e;
            throw new Error(
                `[SABTransport] BSON deserialization failed: ${(e as Error).message}`
            );
        }
        return { msg, seq: result.seq };
    }

    /** Blocking: await next message with optional timeout */
    awaitMessage(
        timeoutMs?: number
    ): { msg: WorkerMessage; seq: number } | null {
        const result = this.recvPool.awaitRaw(this._recvSeq, timeoutMs);
        if (!result) return null;
        this._recvSeq = result.seq;
        let msg: WorkerMessage;
        try {
            msg = deserializeBSON<WorkerMessage>(
                result.data,
                0,
                bsonBinarySerializer
            ) as WorkerMessage;
        } catch (e) {
            throw new Error(
                `[SABTransport] BSON deserialization failed: ${(e as Error).message}`
            );
        }
        return { msg, seq: result.seq };
    }

    /** Non-blocking poll for pending inbound messages */
    hasPending(): boolean {
        return this.recvPool.hasPending();
    }

    // ── Static: Init Setup ──────────────────────────────────────────

    /** Main thread side: allocate pools and create init transfer for a Worker */
    static initMain(config: TransportConfig): {
        transport: SABTransport;
        initMessage: {
            type: 'sabInit';
            sendSABs: SharedArrayBuffer[];
            recvSABs: SharedArrayBuffer[];
            signalSAB: SharedArrayBuffer;
        };
        transfer: SharedArrayBuffer[];
    } {
        const { sendPool, recvPool } = SABPool.createMain(config);
        const transport = new SABTransport(sendPool, recvPool);
        const { message: initMessage, transfer } = createInitTransfer(
            sendPool,
            recvPool
        );
        return { transport, initMessage, transfer };
    }

    /** Worker side: create transport from received SABs */
    static initWorker(
        sendSABs: SharedArrayBuffer[],
        recvSABs: SharedArrayBuffer[],
        signalSAB: SharedArrayBuffer
    ): SABTransport {
        const { sendPool, recvPool } = SABPool.createWorker(
            sendSABs,
            recvSABs,
            signalSAB
        );
        return new SABTransport(sendPool, recvPool);
    }
}
