import { applyNetwork } from './networkPlugin';

// TODO smarter reconnect with backoff and jitter and such
export function createClient(
    endpoint: string,
    network: ReturnType<typeof applyNetwork>,
    options?: {
        getToken?: () => string | null | undefined;
    }
) {
    let socket: WebSocket;
    let socketPromise: Promise<WebSocket>;

    async function connect() {
        if (socketPromise) return socketPromise;
        return (socketPromise = new Promise((resolve) => {
            async function connect() {
                try {
                    // Build WebSocket URL with optional token
                    let wsUrl = 'ws://' + endpoint;
                    if (options?.getToken) {
                        const token = options.getToken();
                        if (token) {
                            wsUrl += `?token=${encodeURIComponent(token)}`;
                        }
                    }

                    socket = new WebSocket(wsUrl);
                    socket.binaryType = 'arraybuffer';

                    socket.onopen = () => {
                        network.setNetworkSocket(socket);
                        resolve(socket);

                        socket.onmessage = (event) => {
                            const { data } = event;

                            if (data instanceof ArrayBuffer) {
                                network.handleIncoming(new Uint8Array(data));
                            } else {
                                console.warn(
                                    'received non binary data on WS',
                                    data
                                );
                            }
                        };
                    };

                    socket.onclose = (e) => {
                        console.log('closed', e);
                        // em.state = em.createInitialState();
                        network.handleDisconnect(e);
                        connect();
                    };
                    socket.onerror = (e) => {
                        console.error(e);
                        if (socket.readyState === socket.CLOSED) connect();
                    };
                } catch {
                    connect();
                }
            }
            connect();
        }));
    }

    return { connect };
}
