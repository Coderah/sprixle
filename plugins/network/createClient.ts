import { throttle } from 'lodash';
import { applyNetwork, NetworkComponentTypes } from './networkPlugin';
import { defaultComponentTypes } from '../../ecs/manager';

// TODO smarter reconnect with backoff and jitter and such
export function createClient<
    Commands extends number,
    ComponentTypes extends defaultComponentTypes & NetworkComponentTypes
>(
    endpoint: string,
    network: ReturnType<typeof applyNetwork<Commands, ComponentTypes>>,
    options?: {
        getToken?: () => string | null | undefined;
        /**
         * App-level heartbeat. Browsers cannot send WS ping frames or observe
         * pong timeouts, so half-open sockets (wifi roam/blip — TCP dies with no
         * close event) are otherwise invisible to a passive client and it stays
         * frozen until a manual refresh. `sendPing` should emit a lightweight
         * message the server acks; any inbound traffic (the ack or normal sync)
         * counts as liveness. If nothing arrives within `timeoutMs`, the socket is
         * force-closed to trigger the existing reconnect path.
         */
        heartbeat?: {
            sendPing: () => void;
            intervalMs?: number;
            timeoutMs?: number;
        };
    }
) {
    let socket: WebSocket;
    let socketPromise: Promise<WebSocket>;

    // ── Heartbeat watchdog ──────────────────────────────────────────────────
    const heartbeatIntervalMs = options?.heartbeat?.intervalMs ?? 10_000;
    const heartbeatTimeoutMs = options?.heartbeat?.timeoutMs ?? 30_000;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let lastActivity = 0;

    /** Call on every inbound frame so the watchdog knows the socket is alive. */
    function markActivity() {
        lastActivity = Date.now();
    }

    function stopHeartbeat() {
        if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = undefined;
        }
    }

    function startHeartbeat() {
        if (!options?.heartbeat) return;
        stopHeartbeat();
        markActivity();
        heartbeatTimer = setInterval(() => {
            if (!socket || socket.readyState !== socket.OPEN) return;
            if (Date.now() - lastActivity > heartbeatTimeoutMs) {
                console.warn(
                    '[NETWORK] heartbeat timeout — closing dead socket to force reconnect'
                );
                stopHeartbeat();
                // Force the onclose the OS never delivered for a half-open socket.
                socket.close();
                return;
            }
            options.heartbeat!.sendPing();
        }, heartbeatIntervalMs);
    }

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
                        startHeartbeat();
                        resolve(socket);

                        socket.onmessage = (event) => {
                            const { data } = event;
                            markActivity();

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
                        stopHeartbeat();
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
