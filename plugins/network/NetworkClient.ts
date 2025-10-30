import type {
    Transport,
    TransportFactory,
    ReconnectConfig,
    ConnectionHandlers,
    MessageHandler,
    QueuedMessage,
    NetworkStats,
} from './types';
import { MessageEncoder } from './encoding';

/**
 * Network client with auto-reconnect, message queueing, and type-safe messaging
 */
export class NetworkClient<MessageTypeEnum = number> {
    private transport?: Transport;
    private transportFactory: TransportFactory;
    private url: string;
    private options?: any;

    private encoder: MessageEncoder<MessageTypeEnum>;
    private handlers = new Map<number, MessageHandler[]>();

    private reconnectConfig: Required<ReconnectConfig>;
    private connectionHandlers: ConnectionHandlers;

    private reconnectAttempts = 0;
    private reconnectTimeout?: ReturnType<typeof setTimeout>;
    private isReconnecting = false;
    private manualDisconnect = false;

    private messageQueue: QueuedMessage[] = [];
    private stats: NetworkStats = {
        messagesSent: 0,
        messagesReceived: 0,
        bytesSent: 0,
        bytesReceived: 0,
        connected: false,
        reconnectAttempts: 0,
    };

    constructor(
        transportFactory: TransportFactory,
        url: string,
        options?: {
            reconnect?: ReconnectConfig;
            handlers?: ConnectionHandlers;
            transportOptions?: any;
        }
    ) {
        this.transportFactory = transportFactory;
        this.url = url;
        this.options = options?.transportOptions;
        this.encoder = new MessageEncoder<MessageTypeEnum>();
        this.connectionHandlers = options?.handlers || {};

        // Set default reconnect config
        this.reconnectConfig = {
            enabled: options?.reconnect?.enabled ?? true,
            maxRetries: options?.reconnect?.maxRetries ?? Infinity,
            initialDelay: options?.reconnect?.initialDelay ?? 1000,
            maxDelay: options?.reconnect?.maxDelay ?? 30000,
            backoffFactor: options?.reconnect?.backoffFactor ?? 1.5,
            jitter: options?.reconnect?.jitter ?? 0.1,
        };
    }

    /**
     * Connect to the server
     */
    async connect(): Promise<void> {
        if (this.transport?.isConnected()) {
            return;
        }

        this.manualDisconnect = false;

        return new Promise<void>((resolve, reject) => {
            try {
                this.transport = this.transportFactory.create(this.url, this.options);

                this.transport.onConnect(() => {
                    this.stats.connected = true;
                    this.reconnectAttempts = 0;

                    // Flush queued messages
                    this.flushMessageQueue();

                    // Call appropriate handler
                    if (this.isReconnecting) {
                        this.isReconnecting = false;
                        this.connectionHandlers.onReconnected?.();
                    } else {
                        this.connectionHandlers.onConnect?.();
                    }

                    resolve();
                });

                this.transport.onMessage((data) => {
                    this.handleMessage(data);
                });

                this.transport.onDisconnect((event) => {
                    this.stats.connected = false;
                    this.connectionHandlers.onDisconnect?.(event);

                    if (!this.manualDisconnect && this.reconnectConfig.enabled) {
                        this.scheduleReconnect();
                    }
                });

                this.transport.onError((error) => {
                    this.connectionHandlers.onError?.(error);
                    if (!this.transport?.isConnected()) {
                        reject(error);
                    }
                });
            } catch (error) {
                reject(error);
            }
        });
    }

    /**
     * Disconnect from the server
     */
    disconnect(): void {
        this.manualDisconnect = true;
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = undefined;
        }
        this.transport?.close();
        this.stats.connected = false;
    }

    /**
     * Send a message to the server
     */
    send(type: MessageTypeEnum, payload?: any): void {
        const encoded = this.encoder.encode(type, payload ?? null);

        if (this.transport?.isConnected()) {
            this.transport.send(encoded);
            this.stats.messagesSent++;
            this.stats.bytesSent += encoded.length;
        } else {
            // Queue message for when connection is restored
            this.messageQueue.push({
                type: type as number,
                payload: payload ?? null,
            });
        }
    }

    /**
     * Register a message handler for a specific message type
     */
    on(type: MessageTypeEnum, handler: MessageHandler): void {
        const typeNum = type as number;
        if (!this.handlers.has(typeNum)) {
            this.handlers.set(typeNum, []);
        }
        this.handlers.get(typeNum)!.push(handler);
    }

    /**
     * Unregister a message handler
     */
    off(type: MessageTypeEnum, handler: MessageHandler): void {
        const typeNum = type as number;
        const handlers = this.handlers.get(typeNum);
        if (handlers) {
            const index = handlers.indexOf(handler);
            if (index !== -1) {
                handlers.splice(index, 1);
            }
        }
    }

    /**
     * Wait for a specific message type (one-time listener)
     */
    async once(type: MessageTypeEnum): Promise<any> {
        return new Promise((resolve) => {
            const handler = (payload: any) => {
                this.off(type, handler);
                resolve(payload);
            };
            this.on(type, handler);
        });
    }

    /**
     * Get current network statistics
     */
    getStats(): NetworkStats {
        return {
            ...this.stats,
            reconnectAttempts: this.reconnectAttempts,
        };
    }

    /**
     * Reset statistics counters
     */
    resetStats(): void {
        this.stats.messagesSent = 0;
        this.stats.messagesReceived = 0;
        this.stats.bytesSent = 0;
        this.stats.bytesReceived = 0;
    }

    /**
     * Check if currently connected
     */
    isConnected(): boolean {
        return this.transport?.isConnected() ?? false;
    }

    private async handleMessage(data: Uint8Array | Blob): Promise<void> {
        try {
            const uint8Data =
                data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data;

            this.stats.messagesReceived++;
            this.stats.bytesReceived += uint8Data.length;

            const message = this.encoder.decode(uint8Data);
            const handlers = this.handlers.get(message.type);

            if (handlers) {
                for (const handler of handlers) {
                    handler(message.payload);
                }
            }
        } catch (error) {
            console.error('[NetworkClient] Failed to decode message:', error);
            this.connectionHandlers.onError?.(error);
        }
    }

    private flushMessageQueue(): void {
        while (this.messageQueue.length > 0 && this.transport?.isConnected()) {
            const msg = this.messageQueue.shift()!;
            this.send(msg.type as MessageTypeEnum, msg.payload);
        }
    }

    private scheduleReconnect(): void {
        if (this.reconnectAttempts >= this.reconnectConfig.maxRetries) {
            this.connectionHandlers.onReconnectFailed?.();
            return;
        }

        this.isReconnecting = true;
        this.reconnectAttempts++;
        this.stats.reconnectAttempts = this.reconnectAttempts;

        // Calculate delay with exponential backoff and jitter
        const baseDelay = Math.min(
            this.reconnectConfig.initialDelay *
                Math.pow(this.reconnectConfig.backoffFactor, this.reconnectAttempts - 1),
            this.reconnectConfig.maxDelay
        );

        const jitter =
            baseDelay * this.reconnectConfig.jitter * (Math.random() * 2 - 1);
        const delay = Math.max(0, baseDelay + jitter);

        this.connectionHandlers.onReconnecting?.(this.reconnectAttempts, delay);

        this.reconnectTimeout = setTimeout(() => {
            this.connect().catch((error) => {
                console.error('[NetworkClient] Reconnect failed:', error);
                // scheduleReconnect will be called by onDisconnect handler
            });
        }, delay);
    }
}
