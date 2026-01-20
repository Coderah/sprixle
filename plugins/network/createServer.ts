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

    if (httpServer) {
        httpServer.listen(config.port);
    }

    return { wss: server, httpServer };
}
