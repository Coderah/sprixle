import type { Transport, MessageHandler, NetworkStats } from './types';
import { MessageEncoder } from './encoding';

/**
 * Connected client info
 */
export interface ConnectedClient {
    id: string;
    transport: Transport;
    metadata?: any;
}

/**
 * Server connection handlers
 */
export interface ServerConnectionHandlers {
    /** Called when a new client connects */
    onClientConnected?: (clientId: string, metadata?: any) => void;

    /** Called when a client disconnects */
    onClientDisconnected?: (clientId: string) => void;

    /** Called on any error */
    onError?: (error: any, clientId?: string) => void;
}

/**
 * Network server for managing multiple client connections
 */
export class NetworkServer<MessageTypeEnum = number> {
    private encoder: MessageEncoder<MessageTypeEnum>;
    private clients = new Map<string, ConnectedClient>();
    private handlers = new Map<number, MessageHandler[]>();
    private connectionHandlers: ServerConnectionHandlers;

    private stats = new Map<string, NetworkStats>();
    private globalStats: NetworkStats = {
        messagesSent: 0,
        messagesReceived: 0,
        bytesSent: 0,
        bytesReceived: 0,
        connected: true,
        reconnectAttempts: 0,
    };

    constructor(options?: { handlers?: ServerConnectionHandlers }) {
        this.encoder = new MessageEncoder<MessageTypeEnum>();
        this.connectionHandlers = options?.handlers || {};
    }

    /**
     * Register a client connection
     */
    addClient(clientId: string, transport: Transport, metadata?: any): void {
        const client: ConnectedClient = {
            id: clientId,
            transport,
            metadata,
        };

        this.clients.set(clientId, client);
        this.stats.set(clientId, {
            messagesSent: 0,
            messagesReceived: 0,
            bytesSent: 0,
            bytesReceived: 0,
            connected: true,
            reconnectAttempts: 0,
        });

        // Setup message handler
        transport.onMessage((data) => {
            this.handleMessage(clientId, data);
        });

        // Setup disconnect handler
        transport.onDisconnect(() => {
            this.removeClient(clientId);
        });

        // Setup error handler
        transport.onError((error) => {
            this.connectionHandlers.onError?.(error, clientId);
        });

        this.connectionHandlers.onClientConnected?.(clientId, metadata);
    }

    /**
     * Remove a client connection
     */
    removeClient(clientId: string): void {
        const client = this.clients.get(clientId);
        if (client) {
            this.clients.delete(clientId);
            this.stats.delete(clientId);
            this.connectionHandlers.onClientDisconnected?.(clientId);
        }
    }

    /**
     * Send a message to a specific client
     */
    send(clientId: string, type: MessageTypeEnum, payload?: any): boolean {
        const client = this.clients.get(clientId);
        if (!client || !client.transport.isConnected()) {
            return false;
        }

        const encoded = this.encoder.encode(type, payload ?? null);
        client.transport.send(encoded);

        // Update stats
        const clientStats = this.stats.get(clientId);
        if (clientStats) {
            clientStats.messagesSent++;
            clientStats.bytesSent += encoded.length;
        }
        this.globalStats.messagesSent++;
        this.globalStats.bytesSent += encoded.length;

        return true;
    }

    /**
     * Broadcast a message to all connected clients
     */
    broadcast(type: MessageTypeEnum, payload?: any): number {
        const encoded = this.encoder.encode(type, payload ?? null);
        let sentCount = 0;

        for (const [clientId, client] of this.clients) {
            if (client.transport.isConnected()) {
                client.transport.send(encoded);
                sentCount++;

                // Update stats
                const clientStats = this.stats.get(clientId);
                if (clientStats) {
                    clientStats.messagesSent++;
                    clientStats.bytesSent += encoded.length;
                }
            }
        }

        this.globalStats.messagesSent += sentCount;
        this.globalStats.bytesSent += encoded.length * sentCount;

        return sentCount;
    }

    /**
     * Broadcast a message to clients matching a filter
     */
    broadcastFiltered(
        type: MessageTypeEnum,
        payload: any,
        filter: (client: ConnectedClient) => boolean
    ): number {
        const encoded = this.encoder.encode(type, payload ?? null);
        let sentCount = 0;

        for (const [clientId, client] of this.clients) {
            if (client.transport.isConnected() && filter(client)) {
                client.transport.send(encoded);
                sentCount++;

                // Update stats
                const clientStats = this.stats.get(clientId);
                if (clientStats) {
                    clientStats.messagesSent++;
                    clientStats.bytesSent += encoded.length;
                }
            }
        }

        this.globalStats.messagesSent += sentCount;
        this.globalStats.bytesSent += encoded.length * sentCount;

        return sentCount;
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
     * Get a specific client
     */
    getClient(clientId: string): ConnectedClient | undefined {
        return this.clients.get(clientId);
    }

    /**
     * Get all connected clients
     */
    getClients(): ConnectedClient[] {
        return Array.from(this.clients.values());
    }

    /**
     * Get number of connected clients
     */
    getClientCount(): number {
        return this.clients.size;
    }

    /**
     * Check if a specific client is connected
     */
    isClientConnected(clientId: string): boolean {
        return this.clients.get(clientId)?.transport.isConnected() ?? false;
    }

    /**
     * Get statistics for a specific client
     */
    getClientStats(clientId: string): NetworkStats | undefined {
        return this.stats.get(clientId);
    }

    /**
     * Get global server statistics
     */
    getGlobalStats(): NetworkStats {
        return { ...this.globalStats };
    }

    /**
     * Reset statistics counters
     */
    resetStats(): void {
        this.globalStats.messagesSent = 0;
        this.globalStats.messagesReceived = 0;
        this.globalStats.bytesSent = 0;
        this.globalStats.bytesReceived = 0;

        for (const stats of this.stats.values()) {
            stats.messagesSent = 0;
            stats.messagesReceived = 0;
            stats.bytesSent = 0;
            stats.bytesReceived = 0;
        }
    }

    /**
     * Disconnect a specific client
     */
    disconnectClient(clientId: string): void {
        const client = this.clients.get(clientId);
        if (client) {
            client.transport.close();
        }
    }

    /**
     * Disconnect all clients and shutdown server
     */
    shutdown(): void {
        for (const client of this.clients.values()) {
            client.transport.close();
        }
        this.clients.clear();
        this.stats.clear();
    }

    private async handleMessage(
        clientId: string,
        data: Uint8Array | Blob
    ): Promise<void> {
        try {
            const uint8Data =
                data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data;

            // Update stats
            const clientStats = this.stats.get(clientId);
            if (clientStats) {
                clientStats.messagesReceived++;
                clientStats.bytesReceived += uint8Data.length;
            }
            this.globalStats.messagesReceived++;
            this.globalStats.bytesReceived += uint8Data.length;

            const message = this.encoder.decode(uint8Data);
            const handlers = this.handlers.get(message.type);

            if (handlers) {
                for (const handler of handlers) {
                    handler(message.payload, clientId);
                }
            }
        } catch (error) {
            console.error('[NetworkServer] Failed to decode message:', error);
            this.connectionHandlers.onError?.(error, clientId);
        }
    }
}
