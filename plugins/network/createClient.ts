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
    // After a foreground/online resume we ping immediately and expect an ack
    // within this short window — much faster than waiting out a full heartbeat
    // timeout — before declaring the (still-OPEN) socket half-open.
    const verifyTimeoutMs = Math.min(heartbeatTimeoutMs, 4_000);
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let verifyTimer: ReturnType<typeof setTimeout> | undefined;
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

    /**
     * Tear down a dead socket and drive the reconnect ourselves.
     *
     * We cannot rely on `socket.close()` → `onclose` for a half-open socket: the
     * closing handshake has no reachable peer, so the browser only fires `close`
     * after its own (long, unreliable on old Chrome/Chromebooks) handshake
     * timeout. During that gap the heartbeat is already stopped and nothing has
     * scheduled a reconnect, so the client silently freezes until a manual
     * refresh. Detach the handlers, best-effort close, and kick reconnect now.
     */
    function forceReconnect(reason: string) {
        console.warn(`[NETWORK] forcing reconnect: ${reason}`);
        stopHeartbeat();
        if (verifyTimer) {
            clearTimeout(verifyTimer);
            verifyTimer = undefined;
        }
        const dead = socket;
        if (dead) {
            // Drop handlers so a late onclose from the dead socket can't race the
            // fresh connection's reconnect logic.
            dead.onopen = dead.onmessage = dead.onerror = dead.onclose = null;
            try {
                dead.close();
            } catch {}
        }
        network.handleDisconnect({} as CloseEvent);
        socketPromise = null;
        reconnect();
    }

    function startHeartbeat() {
        if (!options?.heartbeat) return;
        stopHeartbeat();
        markActivity();
        heartbeatTimer = setInterval(() => {
            if (!socket || socket.readyState !== socket.OPEN) return;
            if (Date.now() - lastActivity > heartbeatTimeoutMs) {
                forceReconnect('heartbeat timeout');
                return;
            }
            options.heartbeat!.sendPing();
        }, heartbeatIntervalMs);
    }

    /**
     * Proactive recovery trigger for `online` / `focus` / `visibilitychange`.
     *
     * A LAN-only wifi blip or a backgrounded/slept display (old Chromebooks
     * throttle hard) can leave us with a socket that still reads OPEN but is
     * actually dead, and the rAF render loop frozen. When the device comes back
     * we don't want to wait out the up-to-30s heartbeat window:
     *   - not OPEN  → reconnect straight away
     *   - OPEN      → ping now and, if no frame arrives within verifyTimeoutMs,
     *                 treat it as half-open and force reconnect.
     */
    function verifyConnection() {
        if (
            typeof document !== 'undefined' &&
            document.visibilityState === 'hidden'
        )
            return;

        if (
            !socket ||
            socket.readyState === socket.CLOSED ||
            socket.readyState === socket.CLOSING
        ) {
            socketPromise = null;
            reconnect();
            return;
        }
        // A connection attempt is already in flight; let it resolve.
        if (socket.readyState !== socket.OPEN) return;
        // Without a ping mechanism we can't elicit a frame to confirm liveness,
        // so don't risk false-positive reconnecting a healthy idle socket.
        if (!options?.heartbeat) return;

        const probeAt = Date.now();
        options.heartbeat.sendPing();
        if (verifyTimer) clearTimeout(verifyTimer);
        verifyTimer = setTimeout(() => {
            verifyTimer = undefined;
            // No inbound frame since the probe → the OPEN socket is half-open.
            if (
                socket &&
                socket.readyState === socket.OPEN &&
                lastActivity < probeAt
            ) {
                forceReconnect('resume probe unanswered');
            }
        }, verifyTimeoutMs);
    }

    if (typeof window !== 'undefined') {
        window.addEventListener('online', verifyConnection);
        window.addEventListener('focus', verifyConnection);
        if (typeof document !== 'undefined') {
            document.addEventListener('visibilitychange', () => {
                if (document.visibilityState === 'visible') verifyConnection();
            });
        }
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
