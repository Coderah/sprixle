import { ReceiveType, typeOf } from '@deepkit/type';
import { getBsonEncoder } from '@deepkit/bson';
import {
    defaultComponentTypes,
    EntityWithComponents,
    Manager,
} from '../../ecs/manager';

import type {
    Server as WebSocketServer,
    WebSocket as ClientWebSocket,
} from 'ws';
import { throttleLog } from '../../util/log';

export type NetworkComponentTypes = {
    socket: ClientWebSocket;
};

export function applyNetwork<
    Command,
    ComponentTypes extends defaultComponentTypes & NetworkComponentTypes
>(manager: Manager<ComponentTypes>, commandType?: ReceiveType<Command>) {
    type MessageData = string | Uint8Array | number | number[] | string[];
    type BufferMessage = Command | [Command, MessageData];
    type EntityWithSocket = EntityWithComponents<
        ComponentTypes,
        Manager<ComponentTypes>,
        'socket'
    >;

    const bufferEncoder = getBsonEncoder(typeOf<BufferMessage>(), {
        validation: false,
    });

    let socket: WebSocket | WebSocketServer;
    let onConnect = function () {};
    let onDisconnect = function (e: CloseEvent) {};

    function setNetworkSocket(newSocket: typeof socket) {
        socket = newSocket;
        if (newSocket instanceof WebSocket) {
            onConnect();
        }
    }

    function setOnConnect(fn: () => void) {
        onConnect = fn;
    }

    function setOnDisconnect(fn: (e: CloseEvent) => void) {
        onDisconnect = fn;
    }

    const messageResolvers: Map<
        Command,
        (response: any, client?: typeof manager.Entity) => void
    > = new Map();

    let incomingMessageCount = 0;
    function takeIncomingMessageCount() {
        const count = incomingMessageCount;
        incomingMessageCount = 0;
        return count;
    }

    let incomingDataSize = 0;
    function takeIncomingDataSize() {
        const count = incomingDataSize;
        incomingDataSize = 0;
        return count;
    }

    let outgoingMessageCount = 0;
    function takeOutgoingMessageCount() {
        const count = outgoingMessageCount;
        outgoingMessageCount = 0;
        return count;
    }

    async function handleIncoming(
        data: Uint8Array,
        client?: typeof manager.Entity
    ) {
        incomingDataSize += data.byteLength;

        const decoded = bufferEncoder.decode(data);
        let first: Command, second: any;
        if (Array.isArray(decoded)) {
            [first, second] = decoded;
        } else {
            first = decoded;
        }

        throttleLog('[Network] receive', first);

        messageResolvers.get(first)?.(second, client);
    }

    async function message<R>(command: Command) {
        return new Promise<R>(async (resolve) => {
            messageResolvers.set(command, resolve);
        });
    }

    // TODO refactor to handle multiple receivers of the same kind of message?
    function receive<R>(
        command: Command,
        handler: (value: R, client?: EntityWithSocket) => void
    ) {
        if (messageResolvers.has(command)) {
            console.warn(
                '[NETWORK] might be overriding incoming handler for',
                command
            );
        }
        messageResolvers.set(command, handler);
    }

    async function send(command: Command): Promise<void>;
    async function send(command: Command, data: MessageData): Promise<void>;
    async function send(
        command: Command,
        data: MessageData,
        targetSocket: EntityWithSocket
    ): Promise<void>;
    async function send(
        command: Command,
        data: MessageData,
        targetSocket: WebSocket | WebSocketServer
    ): Promise<void>;
    async function send(
        command: Command,
        data?: MessageData,
        targetSocket:
            | WebSocket
            | WebSocketServer
            | ClientWebSocket
            | EntityWithSocket = socket
    ): Promise<void> {
        if (!targetSocket) {
            console.warn('[networkPlugin] attempting to send without a socket');
            return;
        }

        throttleLog('[Network] send', command);

        if ('components' in targetSocket) {
            targetSocket = targetSocket.components.socket;
        }

        if (!('send' in targetSocket)) {
            // TODO handle server broadcast
            // TODO use a query?
            for (let clientEntity of manager.getEntities('socket')) {
                // TODO parallel?
                await send(command, data, clientEntity);
            }
            return;
        }
        // TODO rewrite for server send
        // if (!targetSocket || targetSocket.readyState !== targetSocket.OPEN)
        //     return;
        const enclosedData = bufferEncoder.encode(
            data ? [command, data] : command
        );

        outgoingMessageCount++;
        if ('on' in targetSocket) {
            await new Promise((resolve) =>
                targetSocket.send(enclosedData, { binary: true }, resolve)
            );
        } else {
            targetSocket.send(enclosedData);
        }
    }

    function getClientEntity(id: string, socket?: ClientWebSocket) {
        if (!socket) return manager.getEntity(id);

        return manager.quickEntity(
            //@ts-ignore
            {
                socket,
            },
            id
        ) as EntityWithSocket;
    }

    return {
        receive,
        message,
        send,
        setNetworkSocket,
        setOnConnect,
        setOnDisconnect,
        takeIncomingMessageCount,
        takeIncomingDataSize,
        takeOutgoingMessageCount,
        handleDisconnect: (e: CloseEvent) => {
            onDisconnect?.(e);
        },
        handleIncoming,
        getClientEntity,
    };
}
