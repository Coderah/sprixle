/**
 * Transport abstraction - allows different protocols (WebSocket, WebRTC, etc.)
 * All transports work with binary data (Uint8Array)
 */
export interface Transport {
    /** Send binary data through the transport */
    send(data: Uint8Array): void;

    /** Register message handler for binary data */
    onMessage(handler: (data: Uint8Array | Blob) => void): void;

    /** Register connection handler */
    onConnect(handler: () => void): void;

    /** Register disconnection handler */
    onDisconnect(handler: (event?: any) => void): void;

    /** Register error handler */
    onError(handler: (error: any) => void): void;

    /** Check if transport is connected */
    isConnected(): boolean;

    /** Close the transport */
    close(): void;
}

/**
 * Factory for creating transport instances
 */
export interface TransportFactory {
    /** Create a transport for the given URL/options */
    create(url: string, options?: any): Transport;

    /** Name of the transport (for debugging) */
    name: string;
}

/**
 * Reconnect configuration
 */
export interface ReconnectConfig {
    /** Enable auto-reconnect (default: true) */
    enabled?: boolean;

    /** Maximum number of retry attempts (default: Infinity) */
    maxRetries?: number;

    /** Initial delay in ms before first retry (default: 1000) */
    initialDelay?: number;

    /** Maximum delay between retries in ms (default: 30000) */
    maxDelay?: number;

    /** Backoff multiplier for each retry (default: 1.5) */
    backoffFactor?: number;

    /** Jitter factor to randomize delays (0-1, default: 0.1) */
    jitter?: number;
}

/**
 * Message structure - all messages are BSON encoded as [type, payload]
 */
export interface Message<T = any> {
    /** Message type (enum value) */
    type: number;

    /** Message payload */
    payload: T;
}

/**
 * Message handler function
 * @param payload - The decoded message payload
 * @param clientId - Optional client identifier (server-side only)
 */
export type MessageHandler<T = any> = (payload: T, clientId?: string) => void;

/**
 * Connection event handlers
 */
export interface ConnectionHandlers {
    /** Called when connection is established */
    onConnect?: () => void;

    /** Called when connection is lost */
    onDisconnect?: (event?: any) => void;

    /** Called when reconnect attempt starts */
    onReconnecting?: (attempt: number, delay: number) => void;

    /** Called when reconnect succeeds */
    onReconnected?: () => void;

    /** Called when max reconnect attempts reached */
    onReconnectFailed?: () => void;

    /** Called on any error */
    onError?: (error: any) => void;
}

/**
 * Queued message for sending
 */
export interface QueuedMessage {
    /** Message type enum */
    type: number;

    /** Message payload */
    payload: any;

    /** Optional target client ID (server-side only) */
    target?: string;
}

/**
 * Network statistics
 */
export interface NetworkStats {
    /** Total messages sent */
    messagesSent: number;

    /** Total messages received */
    messagesReceived: number;

    /** Total bytes sent */
    bytesSent: number;

    /** Total bytes received */
    bytesReceived: number;

    /** Current connection state */
    connected: boolean;

    /** Number of reconnect attempts (current session) */
    reconnectAttempts: number;

    /** Last ping time in ms */
    lastPing?: number;
}
