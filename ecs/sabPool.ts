/**
 * SAB Pool — pre-allocated SharedArrayBuffer pool with Atomics-based
 * acquire/release/signal. Designed for zero-allocation, zero-postMessage
 * cross-thread data transfer after initialization.
 */

import { bsonBinarySerializer, deserializeBSON, serializeBSON } from '@deepkit/bson';

// ── Buffer Layout ──────────────────────────────────────────────────
//
// Each pool buffer is one SharedArrayBuffer:
//
//   Offset  Size   Field
//   0       4      owner (0=free, 1=main-owned, 2=worker-owned)
//   4       4      dataLength (bytes written to payload)
//   8       4      sequence (monotonic, ties signal to buffer)
//   12      4      flags (reserved for future use)
//   16      N-16   BSON payload (N = configurable bufferSize)
//
// ── Signal SAB Layout ──────────────────────────────────────────────
//
//   Offset  Size   Field
//   0       4      mainPending (1 = main has new message)
//   4       4      mainSeq (last sequence number main wrote)
//   8       4      workerPending (1 = worker has new message)
//   12      4      workerSeq (last sequence number worker wrote)
//   16      4      shutdownFlag
//   20      4      mainFreeCount (wake blocked sender)
//   24      4      workerFreeCount
//   28      4      reserved

export const SAB_HEADER_SIZE = 16;

export const SIGNAL_OFFSET_MAIN_PENDING = 0;
export const SIGNAL_OFFSET_MAIN_SEQ = 4;
export const SIGNAL_OFFSET_WORKER_PENDING = 8;
export const SIGNAL_OFFSET_WORKER_SEQ = 12;
export const SIGNAL_OFFSET_SHUTDOWN = 16;
export const SIGNAL_OFFSET_MAIN_FREE = 20;
export const SIGNAL_OFFSET_WORKER_FREE = 24;
export const SIGNAL_SAB_SIZE = 64;

const OWNER_FREE = 0;
const OWNER_MAIN = 1;
const OWNER_WORKER = 2;

// ── Pool Config ────────────────────────────────────────────────────

export interface PoolConfig {
    count: number;
    bufferSize: number;
}

export interface TransportConfig {
    sendPool: PoolConfig;
    recvPool: PoolConfig;
}

// ── Pool Buffer ────────────────────────────────────────────────────

class PoolBuffer {
    readonly sab: SharedArrayBuffer;
    readonly view: DataView;
    readonly payloadOffset: number;
    readonly payloadSize: number;

    /** Index in the pool array, for return tracking */
    index: number = -1;

    constructor(sab: SharedArrayBuffer, index?: number) {
        this.sab = sab;
        this.view = new DataView(sab);
        this.payloadOffset = SAB_HEADER_SIZE;
        this.payloadSize = sab.byteLength - SAB_HEADER_SIZE;
        if (index !== undefined) this.index = index;
    }

    get owner(): number { return Atomics.load(new Int32Array(this.sab, 0, 1), 0); }
    setOwner(val: number) { Atomics.store(new Int32Array(this.sab, 0, 1), 0, val); }

    get dataLength(): number { return this.view.getInt32(4, true); }
    setDataLength(val: number) { this.view.setInt32(4, val, true); }

    get sequence(): number { return this.view.getInt32(8, true); }
    setSequence(val: number) { this.view.setInt32(8, val, true); }

    get payload(): Uint8Array { return new Uint8Array(this.sab, this.payloadOffset); }

    /** Atomically claim ownership. Returns true if acquired. */
    tryAcquire(expectedOwner: number, newOwner: number): boolean {
        const arr = new Int32Array(this.sab, 0, 1);
        return Atomics.compareExchange(arr, 0, expectedOwner, newOwner) === expectedOwner;
    }

    /** Release back to free */
    release() {
        this.setOwner(OWNER_FREE);
        this.setDataLength(0);
    }
}

// ── Signal SAB ─────────────────────────────────────────────────────

class SignalSAB {
    readonly sab: SharedArrayBuffer;
    readonly arr: Int32Array;

    constructor(sab?: SharedArrayBuffer) {
        this.sab = sab ?? new SharedArrayBuffer(SIGNAL_SAB_SIZE);
        this.arr = new Int32Array(this.sab);
    }

    get mainPending(): number { return Atomics.load(this.arr, SIGNAL_OFFSET_MAIN_PENDING / 4); }
    setMainPending(val: number) { Atomics.store(this.arr, SIGNAL_OFFSET_MAIN_PENDING / 4, val); }

    get mainSeq(): number { return Atomics.load(this.arr, SIGNAL_OFFSET_MAIN_SEQ / 4); }
    setMainSeq(val: number) { Atomics.store(this.arr, SIGNAL_OFFSET_MAIN_SEQ / 4, val); }

    get workerPending(): number { return Atomics.load(this.arr, SIGNAL_OFFSET_WORKER_PENDING / 4); }
    setWorkerPending(val: number) { Atomics.store(this.arr, SIGNAL_OFFSET_WORKER_PENDING / 4, val); }

    get workerSeq(): number { return Atomics.load(this.arr, SIGNAL_OFFSET_WORKER_SEQ / 4); }
    setWorkerSeq(val: number) { Atomics.store(this.arr, SIGNAL_OFFSET_WORKER_SEQ / 4, val); }

    get shutdown(): number { return Atomics.load(this.arr, SIGNAL_OFFSET_SHUTDOWN / 4); }
    setShutdown(val: number) { Atomics.store(this.arr, SIGNAL_OFFSET_SHUTDOWN / 4, val); }

    get mainFreeCount(): number { return Atomics.load(this.arr, SIGNAL_OFFSET_MAIN_FREE / 4); }
    incMainFree() { Atomics.add(this.arr, SIGNAL_OFFSET_MAIN_FREE / 4, 1); }

    get workerFreeCount(): number { return Atomics.load(this.arr, SIGNAL_OFFSET_WORKER_FREE / 4); }
    incWorkerFree() { Atomics.add(this.arr, SIGNAL_OFFSET_WORKER_FREE / 4, 1); }

    notify(count: number = 1) { Atomics.notify(this.arr, 0, count); }

    /** Block until the value at index is not `expected`. Returns 'ok' or 'timed-out'. */
    wait(index: number, expected: number, timeoutMs?: number): 'ok' | 'timed-out' {
        const result = Atomics.wait(this.arr, index, expected, timeoutMs);
        return result === 'ok' ? 'ok' : 'timed-out';
    }

    /** Non-blocking wait (for main thread where Atomics.wait may be restricted) */
    waitAsync(index: number, expected: number, timeoutMs?: number): Promise<'ok' | 'timed-out'> {
        if (typeof (Atomics as any).waitAsync === 'function') {
            return (Atomics as any).waitAsync(this.arr, index, expected, timeoutMs) as Promise<'ok' | 'timed-out'>;
        }
        // Fallback: poll with setTimeout (sub-optimal but works)
        return new Promise((resolve) => {
            const start = Date.now();
            const check = () => {
                if (Atomics.load(this.arr, index) !== expected) {
                    resolve('ok');
                    return;
                }
                if (timeoutMs && Date.now() - start >= timeoutMs) {
                    resolve('timed-out');
                    return;
                }
                setTimeout(check, 1);
            };
            check();
        });
    }
}

// ── Pool ───────────────────────────────────────────────────────────

export class SABPool {
    readonly buffers: PoolBuffer[];
    readonly signal: SignalSAB;

    /** Are we the "main" side (1) or "worker" side (2)? */
    readonly side: typeof OWNER_MAIN | typeof OWNER_WORKER;
    private _seq: number = 0;

    /** Which pending field and free-count field do we use? */
    private get pendingOffset(): number {
        return this.side === OWNER_MAIN ? SIGNAL_OFFSET_MAIN_PENDING / 4 : SIGNAL_OFFSET_WORKER_PENDING / 4;
    }

    private get freeCountOffset(): number {
        return this.side === OWNER_MAIN ? SIGNAL_OFFSET_WORKER_FREE / 4 : SIGNAL_OFFSET_MAIN_FREE / 4;
    }

    constructor(
        side: 'main' | 'worker',
        buffers: SharedArrayBuffer[],
        signal: SharedArrayBuffer,
    ) {
        this.side = side === 'main' ? OWNER_MAIN : OWNER_WORKER;
        this.buffers = buffers.map((sab, i) => new PoolBuffer(sab, i));
        this.signal = new SignalSAB(signal);
    }

    /** Allocate a new pool (caller is the "main" side that owns the allocation) */
    static createMain(config: TransportConfig): {
        sendPool: SABPool;
        recvPool: SABPool;
    } {
        const signal = new SharedArrayBuffer(SIGNAL_SAB_SIZE);

        const sendBuffers = Array.from({ length: config.sendPool.count }, () =>
            new SharedArrayBuffer(config.sendPool.bufferSize)
        );
        const recvBuffers = Array.from({ length: config.recvPool.count }, () =>
            new SharedArrayBuffer(config.recvPool.bufferSize)
        );

        return {
            sendPool: new SABPool('main', sendBuffers, signal),
            recvPool: new SABPool('main', recvBuffers, signal),
        };
    }

    /** Create worker-side pools from received SABs */
    static createWorker(
        sendSABs: SharedArrayBuffer[],
        recvSABs: SharedArrayBuffer[],
        signal: SharedArrayBuffer,
    ): { sendPool: SABPool; recvPool: SABPool } {
        return {
            // Worker's "send" pool = buffers allocated by main for worker → main
            sendPool: new SABPool('worker', sendSABs, signal),
            // Worker's "recv" pool = buffers allocated by main for main → worker
            recvPool: new SABPool('worker', recvSABs, signal),
        };
    }

    /** Extract all SABs for transfer */
    getAllSABs(): SharedArrayBuffer[] {
        return [this.signal.sab, ...this.buffers.map(b => b.sab)];
    }

    // ── Acquire / Release ──────────────────────────────────────────

    /** Acquire a free buffer. Blocks (via Atomics.wait) if none free. */
    acquire(timeoutMs?: number): PoolBuffer | null {
        while (true) {
            for (const buf of this.buffers) {
                if (buf.tryAcquire(OWNER_FREE, this.side)) {
                    return buf;
                }
            }
            // No free buffer — wait for one to be returned
            const savedCount = Atomics.load(this.signal.arr, this.freeCountOffset);
            const result = this.signal.wait(this.freeCountOffset, savedCount, timeoutMs);
            if (result === 'timed-out') return null;
        }
    }

    /** Non-blocking acquire. Returns null if no free buffer. */
    tryAcquire(): PoolBuffer | null {
        for (const buf of this.buffers) {
            if (buf.tryAcquire(OWNER_FREE, this.side)) {
                return buf;
            }
        }
        return null;
    }

    /** Release a buffer to the receiver side */
    releaseToReceiver(buf: PoolBuffer, receiverOwner: typeof OWNER_MAIN | typeof OWNER_WORKER): void {
        buf.setSequence(++this._seq);
        buf.setOwner(receiverOwner);
        // Signal the receiver
        if (receiverOwner === OWNER_MAIN) {
            this.signal.setMainPending(1);
        } else {
            this.signal.setWorkerPending(1);
        }
        this.signal.notify();
    }

    /** Return a buffer to free (called by receiver after reading) */
    returnToFree(buf: PoolBuffer): void {
        buf.release();
        if (this.side === OWNER_MAIN) {
            this.signal.incWorkerFree();
        } else {
            this.signal.incMainFree();
        }
        this.signal.notify();
    }

    // ── Polling ─────────────────────────────────────────────────────

    /** Check if our peer has sent us a message (non-blocking) */
    hasPending(): boolean {
        const pending = this.side === OWNER_MAIN
            ? this.signal.workerPending
            : this.signal.mainPending;
        return pending === 1;
    }

    /** Receive a buffer the other side released to us (non-blocking). Returns null if none. */
    tryRecv(lastSeenSeq: number): { buf: PoolBuffer; seq: number } | null {
        const expectedOwner = this.side; // other side releases to our owner tag
        for (const buf of this.buffers) {
            if (buf.owner === expectedOwner && buf.sequence > lastSeenSeq) {
                return { buf, seq: buf.sequence };
            }
        }
        return null;
    }

    /** Clear pending flag after consuming all messages */
    clearPending(): void {
        if (this.side === OWNER_MAIN) {
            this.signal.setWorkerPending(0);
        } else {
            this.signal.setMainPending(0);
        }
    }

    /** Shutdown signal */
    signalShutdown(): void {
        this.signal.setShutdown(1);
        this.signal.notify();
    }

    get isShutdown(): boolean {
        return this.signal.shutdown === 1;
    }

    // ── BSON Write & Read ───────────────────────────────────────────

    /** Scratch buffer size for BSON pre-serialization. Should match max pool buffer payload size. */
    private _scratch?: Uint8Array;

    private getScratch(): Uint8Array {
        if (!this._scratch || this._scratch.byteLength < this.buffers[0]!.payloadSize) {
            this._scratch = new Uint8Array(this.buffers[0]!.payloadSize);
        }
        return this._scratch;
    }

    /** Serialize data as BSON into a pool buffer. Acquires, writes, releases to receiver. */
    writeMessage(data: unknown): boolean {
        // 1. Serialize to scratch buffer
        const scratch = this.getScratch();
        let serialized: Uint8Array;
        try {
            serialized = serializeBSON(data as any, bsonBinarySerializer);
        } catch (e) {
            throw new Error(`[SABPool] BSON serialization failed: ${(e as Error).message}`);
        }

        // 2. Check size
        if (serialized.byteLength > this.buffers[0]!.payloadSize) {
            throw new Error(
                `[SABPool] Message (${serialized.byteLength} bytes) exceeds pool buffer payload size ` +
                `(${this.buffers[0]!.payloadSize} bytes). Increase pool bufferSize.`
            );
        }

        // 3. Acquire a buffer
        const buf = this.acquire();
        if (!buf) return false; // timeout

        // 4. Copy BSON into buffer payload
        const src = new Uint8Array(serialized.buffer, serialized.byteOffset, serialized.byteLength);
        const dst = new Uint8Array(buf.sab, buf.payloadOffset, buf.payloadSize);
        dst.set(src);
        buf.setDataLength(serialized.byteLength);

        // 5. Release to receiver
        const receiver = this.side === OWNER_MAIN ? OWNER_WORKER : OWNER_MAIN;
        this.releaseToReceiver(buf, receiver);

        return true;
    }

    /** Read the next pending message (non-blocking). Returns deserialized data or null. */
    readMessage(lastSeenSeq: number): { data: unknown; seq: number } | null {
        const result = this.tryRecv(lastSeenSeq);
        if (!result) return null;

        const { buf, seq } = result;

        // Deserialize BSON from buffer payload
        const payload = new Uint8Array(buf.sab, buf.payloadOffset, buf.dataLength);
        let data: unknown;
        try {
            data = deserializeBSON(payload, 0, bsonBinarySerializer);
        } catch (e) {
            throw new Error(`[SABPool] BSON deserialization failed: ${(e as Error).message}`);
        }

        // Return buffer to free
        this.returnToFree(buf);

        return { data, seq };
    }

    /** Block waiting for the next message from peer. Returns deserialized data. */
    awaitMessage(lastSeenSeq: number, timeoutMs?: number): { data: unknown; seq: number } | null {
        const deadline = timeoutMs ? Date.now() + timeoutMs : undefined;

        while (true) {
            if (this.isShutdown) return null;

            const result = this.readMessage(lastSeenSeq);
            if (result) return result;

            const remaining = deadline ? Math.max(0, deadline - Date.now()) : undefined;
            if (remaining === 0) return null; // timed out

            const waitResult = this.signal.wait(
                this.pendingOffset,
                0,
                remaining,
            );
            if (waitResult === 'timed-out') return null;
        }
    }
}

/**
 * Check if the current global scope is a Web Worker.
 * Returns true for both DedicatedWorkerGlobalScope and SharedWorkerGlobalScope.
 */
export function isWorkerScope(): boolean {
    if (typeof self === 'undefined' || typeof WorkerGlobalScope === 'undefined') return false;
    try {
        return self instanceof (WorkerGlobalScope as any);
    } catch {
        return typeof importScripts === 'function';
    }
}

/**
 * Create postMessage-based SAB init handshake payload.
 * Used by the main thread to transfer pool ownership to the worker.
 *
 * Direction swap: main's recvPool buffers become the worker's sendPool buffers,
 * and main's sendPool buffers become the worker's recvPool buffers.
 */
export function createInitTransfer(sendPool: SABPool, recvPool: SABPool): {
    message: { type: 'sabInit'; sendSABs: SharedArrayBuffer[]; recvSABs: SharedArrayBuffer[]; signalSAB: SharedArrayBuffer };
    transfer: SharedArrayBuffer[];
} {
    // Worker's send = main's recv (worker writes to worker→main buffers)
    const workerSendSABs = recvPool.buffers.map(b => b.sab);
    // Worker's recv = main's send (main writes to main→worker buffers)
    const workerRecvSABs = sendPool.buffers.map(b => b.sab);
    const signalSAB = sendPool.signal.sab;

    const transfer = [signalSAB, ...sendPool.buffers.map(b => b.sab), ...recvPool.buffers.map(b => b.sab)];

    return {
        message: { type: 'sabInit', sendSABs: workerSendSABs, recvSABs: workerRecvSABs, signalSAB },
        transfer,
    };
}
