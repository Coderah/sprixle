import { applyNetwork, NetworkComponentTypes } from './networkPlugin';
import { createServer as createHTTPServer } from 'http';
import { Server as WebSocketServer } from 'ws';
import { defaultComponentTypes } from '../../ecs/manager';

function defaultHTTPServer() {
    const httpServer = createHTTPServer({ noDelay: true });

    httpServer.on('request', (request, response) => {
        response.setHeader('Access-Control-Allow-Origin', '*');
        response.setHeader('Access-Control-Request-Method', '*');
        response.setHeader('Access-Control-Allow-Methods', 'OPTIONS, GET');
        response.setHeader('Access-Control-Allow-Headers', '*');
        // if (request.method === 'OPTIONS') {
        response.writeHead(200);
        response.end();
        // return;
        // }

        // const urlParts = request.url?.split('/') || [];

        // throttleLog('request', urlParts);

        // if (urlParts[1] === 'status') {
        //     response.setHeader('Content-Type', 'application/json');
        //     response.write(
        //         JSON.stringify({
        //             matchState:
        //                 em.getSingletonEntityComponent('matchState') || '',
        //             players: Array.from(em.getEntities('isPlayer')),
        //             teams: Array.from(em.getEntities('teamName')),
        //         })
        //     );
        // }

        // response.writeHead(200);
        // response.end();
    });

    return httpServer;
}

export function createServer<
    Commands extends number,
    ComponentTypes extends defaultComponentTypes & NetworkComponentTypes
>(
    config: {
        port: number;
        noServer?: boolean;
        httpServer?: ReturnType<typeof createHTTPServer>;
    },
    network: ReturnType<typeof applyNetwork<Commands, ComponentTypes>>
) {
    const httpServer = config.noServer
        ? undefined
        : config.httpServer || defaultHTTPServer();

    const server = new WebSocketServer({
        server: httpServer,
        noServer: config.noServer,
    });

    network.setNetworkSocket(server);

    server.on('listening', (e) => {
        console.log('listening', server.address());
    });

    server.on('connection', async (socket, request) => {
        const client = network.getClientEntity(socket);

        // Native ws ping/pong liveness. Browsers auto-reply to ping frames with a
        // pong, so this needs no app-level cooperation. A socket that misses a
        // sweep (half-open — wifi roam/blip, no FIN) is terminated, which fires the
        // 'close' handler below and deregisters the zombie session entity so the
        // server stops trying to send to a dead socket.
        (socket as any).isAlive = true;
        socket.on('pong', () => {
            (socket as any).isAlive = true;
        });

        socket.addEventListener('message', (event) => {
            let { data } = event;

            if (data instanceof ArrayBuffer || data instanceof Buffer) {
                network.handleIncoming(new Uint8Array(data), client);
            } else {
                console.warn('client send non binary data', client.id, data);
            }
        });

        socket.on('close', () => {
            // TODO resolve potentially memory leak (deregister entities?)
            // delete client.components.socket;
            network.manager.deregisterEntity(client);

            console.log('client disconnected', client.id);
        });
    });

    // Sweep for dead sockets. Each pass terminates any client that hasn't ponged
    // since the previous pass, then pings the survivors. terminate() → 'close' →
    // deregisterEntity, reaping zombie sessions left by half-open connections.
    const HEARTBEAT_SWEEP_MS = 15_000;
    const heartbeatSweep = setInterval(() => {
        for (const socket of server.clients) {
            if ((socket as any).isAlive === false) {
                socket.terminate();
                continue;
            }
            (socket as any).isAlive = false;
            try {
                socket.ping();
            } catch {
                socket.terminate();
            }
        }
    }, HEARTBEAT_SWEEP_MS);
    server.on('close', () => clearInterval(heartbeatSweep));

    if (httpServer) {
        httpServer.listen(config.port);
    }

    return { wss: server, httpServer };
}
