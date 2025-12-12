import { throttle } from 'lodash';
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

    const reconnect = throttle(
        () => {
            return connect();
        },
        1500,
        {
            leading: false,
            trailing: true,
        }
    );

    async function connect() {
        return (socketPromise =
            socketPromise ||
            new Promise(async (resolve) => {
                try {
                    // Build WebSocket URL with optional token
                    let wsUrl = `${
                        window.location.protocol === 'https:' ? 'wss' : 'ws'
                    }://${endpoint}`;
                    if (options?.getToken) {
                        const token = options.getToken();
                        if (token) {
                            wsUrl += `?token=${encodeURIComponent(token)}`;
                        } else {
                            console.warn(
                                '[NETWORK] getToken provided, but no token available, assuming we should not connect.'
                            );
                            return;
                        }
                    }

                    if (socket) {
                        if (
                            socket.readyState !== socket.CLOSED &&
                            socket.readyState !== socket.CLOSING
                        ) {
                            return resolve(socket);
                        } else {
                            socket.close();
                        }
                    }
                    console.log('[NETWORK] opening new client WebSocket...');
                    socket = new WebSocket(wsUrl);
                    socket.binaryType = 'arraybuffer';

                    socket.onopen = () => {
                        console.log('[NETWORK] OPEN!');
                        network.setNetworkSocket(socket);
                        socketPromise = null;
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
                        // console.log('closed', e);
                        // em.state = em.createInitialState();
                        network.handleDisconnect(e);
                        console.log(
                            '[NETWORK] reconnecting due to close...',
                            e
                        );
                        if (socketPromise) {
                            socketPromise = null;
                            reconnect()?.then(resolve);
                        } else {
                            reconnect();
                        }
                    };
                    socket.onerror = (e) => {
                        // console.error(e);
                        if (socket.readyState === socket.CLOSED) {
                            console.log(
                                '[NETWORK] reconnecting from error on closed socket...',
                                e
                            );
                            if (socketPromise) {
                                socketPromise = null;
                                reconnect()?.then(resolve);
                            } else {
                                reconnect();
                            }
                        }
                    };
                } catch (e) {
                    console.log('[NETWORK] reconnecting due to catch?', e);
                    return reconnect();
                }
            }));
    }

    return { connect };
}
