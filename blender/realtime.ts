import { NodeTree } from '../plugins/nodeTrees/createCompiler';

let ws: WebSocket | null = null;

class BlenderEvents extends EventTarget {
    emit(type: string, name: string, tree: NodeTree) {
        this.dispatchEvent(
            new CustomEvent(type, {
                detail: {
                    name,
                    tree,
                },
            })
        );
    }
    addEventListener(
        type: 'logicTree' | 'shaderTree',
        callback: (
            event: CustomEvent<{ tree: NodeTree; name: string }>
        ) => void,
        options?: AddEventListenerOptions | boolean
    ) {
        super.addEventListener(type, callback, options);
    }
}
export const blenderEvents = new BlenderEvents();
export function enableNodeTreeBlenderConnection() {
    if (ws) return;

    ws = new WebSocket(`ws://${window.location.hostname}:9001`);

    let pingInterval: NodeJS.Timeout | null = null;

    ws.addEventListener('open', () => {
        console.log('[NodeTreeBlenderConnection] Connected to server');
        pingInterval = setInterval(() => {
            ws.send('ping');
        }, 5000);
    });

    ws.addEventListener('message', (event: MessageEvent) => {
        const { data, name, type } = JSON.parse(event.data);

        blenderEvents.emit(type, name, data as NodeTree);
    });

    ws.addEventListener('close', () => {
        console.log('[NodeTreeBlenderConnection] Connection closed');

        clearInterval(pingInterval);

        ws = null;

        setTimeout(() => enableNodeTreeBlenderConnection(), 1000);
    });

    ws.addEventListener('error', (error) => {
        console.error('[NodeTreeBlenderConnection] WebSocket error:', error);
    });
}
