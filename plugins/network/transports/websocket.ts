import type { Transport, TransportFactory } from '../types';

/**
 * WebSocket transport implementation
 */
export class WebSocketTransport implements Transport {
    private socket: WebSocket;
    private messageHandler?: (data: Uint8Array | Blob) => void;
    private connectHandler?: () => void;
    private disconnectHandler?: (event?: any) => void;
    private errorHandler?: (error: any) => void;

    constructor(socket: WebSocket) {
        this.socket = socket;
        this.setupHandlers();
    }

    private setupHandlers() {
        this.socket.binaryType = 'arraybuffer';

        this.socket.onmessage = (event) => {
            if (this.messageHandler) {
                const data =
                    event.data instanceof ArrayBuffer
                        ? new Uint8Array(event.data)
                        : event.data;
                this.messageHandler(data);
            }
        };

        this.socket.onopen = () => {
            this.connectHandler?.();
        };

        this.socket.onclose = (event) => {
            this.disconnectHandler?.(event);
        };

        this.socket.onerror = (error) => {
            this.errorHandler?.(error);
        };
    }

    send(data: Uint8Array): void {
        if (this.socket.readyState === WebSocket.OPEN) {
            this.socket.send(data);
        }
    }

    onMessage(handler: (data: Uint8Array | Blob) => void): void {
        this.messageHandler = handler;
    }

    onConnect(handler: () => void): void {
        this.connectHandler = handler;
        // If already connected, call immediately
        if (this.socket.readyState === WebSocket.OPEN) {
            handler();
        }
    }

    onDisconnect(handler: (event?: any) => void): void {
        this.disconnectHandler = handler;
    }

    onError(handler: (error: any) => void): void {
        this.errorHandler = handler;
    }

    isConnected(): boolean {
        return this.socket.readyState === WebSocket.OPEN;
    }

    close(): void {
        this.socket.close();
    }

    /** Get the underlying WebSocket for advanced usage */
    getSocket(): WebSocket {
        return this.socket;
    }
}

/**
 * WebSocket transport factory
 */
export const WebSocketTransportFactory: TransportFactory = {
    name: 'WebSocket',

    create(url: string, options?: any): Transport {
        const socket = new WebSocket(url, options?.protocols);
        return new WebSocketTransport(socket);
    },
};
