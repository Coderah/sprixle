import { ReceiveType, typeOf, uint8 } from '@deepkit/type';
import { getBsonEncoder } from '@deepkit/bson';
import {
    defaultComponentTypes,
    EntityId,
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
    type MessageData =
        | string
        | Uint8Array
        | number
        | number[]
        | string[]
        | bigint;
    type BufferMessage = Command | [Command, MessageData];
    type EntityWithSocket = EntityWithComponents<
        ComponentTypes,
        Manager<ComponentTypes>,
        'socket'
    >;

    const socketQuery = manager.createQuery({
        includes: ['socket'],
        index: 'socket',
    });

    const networkMessageEncoder = getBsonEncoder(typeOf<BufferMessage>(), {
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
        (
            response: any,
            client?: typeof manager.Entity,
            rawData?: Uint8Array
        ) => void
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

        const decoded = decodeMessage(data);
        let first: Command, second: any;
        if (Array.isArray(decoded)) {
            [first, second] = decoded;
        } else {
            first = decoded;
        }

        throttleLog('[Network] receive', first);

        messageResolvers.get(first)?.(second, client, data);
    }

    async function message<R>(command: Command) {
        return new Promise<R>(async (resolve) => {
            messageResolvers.set(command, resolve);
        });
    }

    // TODO refactor to handle multiple receivers of the same kind of message?
    function receive<R>(
        command: Command,
        handler: (
            value: R,
            client?: EntityWithSocket,
            rawData?: Uint8Array
        ) => void
    ) {
        if (messageResolvers.has(command)) {
            console.warn(
                '[NETWORK] might be overriding incoming handler for',
                command
            );
        }
        messageResolvers.set(command, handler);
    }

    async function sendRaw(
        buffer: Uint8Array,
        targetSocket:
            | WebSocket
            | WebSocketServer
            | ClientWebSocket
            | EntityWithSocket = socket
    ) {
        if (!targetSocket) {
            console.warn(
                '[networkPlugin] attempting to sendRaw without a socket'
            );
            return;
        }

        if ('components' in targetSocket) {
            targetSocket = targetSocket.components.socket;
        }

        if (!('send' in targetSocket)) {
            // TODO handle server broadcast
            // TODO use a query?
            for (let clientEntity of manager.getEntities('socket')) {
                // TODO parallel?
                await sendRaw(buffer, clientEntity);
            }
            return;
        }
        // TODO rewrite for server send
        if (!targetSocket || targetSocket.readyState !== targetSocket.OPEN)
            return;

        outgoingMessageCount++;
        if ('on' in targetSocket) {
            await new Promise((resolve) =>
                targetSocket.send(buffer, { binary: true }, resolve)
            );
        } else {
            targetSocket.send(buffer);
        }
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
        if (!targetSocket || targetSocket.readyState !== targetSocket.OPEN)
            return;
        const enclosedData = encodeMessage(command, data);

        outgoingMessageCount++;
        if ('on' in targetSocket) {
            await new Promise((resolve) =>
                targetSocket.send(enclosedData, { binary: true }, resolve)
            );
        } else {
            targetSocket.send(enclosedData);
        }
    }

    function encodeMessage(command: Command, data?: MessageData) {
        return networkMessageEncoder.encode(data ? [command, data] : command);
    }

    function decodeMessage(buffer: Uint8Array) {
        return networkMessageEncoder.decode(buffer);
    }

    function getClientEntity(
        socket?: ClientWebSocket,
        id: EntityId = manager.genId()
    ) {
        if (!socket) return manager.getEntity(id);

        const existingEntity = socketQuery.get(socket).first();

        return (
            existingEntity ||
            (manager.quickEntity(
                //@ts-ignore
                {
                    socket,
                },
                id
            ) as EntityWithSocket)
        );
    }

    return {
        receive,
        message,
        encodeMessage,
        decodeMessage,
        send,
        sendRaw,
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
