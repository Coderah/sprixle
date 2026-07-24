import { EntityId } from '../../ecs/manager';
import { ValkeyPluginConfig } from './types';

type MessageHandler = (channel: string, message: Uint8Array) => void;

/**
 * Creates the pub/sub backplane API — publishing, receiving, and
 * manual client-channel subscription management.
 *
 * Generalized from platinum-equity's publishRealtime (store.ts:88-117)
 * and handleRealtimeMessage (entry.ts:180-206).
 *
 * Listens on both 'messageBuffer' (direct subscribe) and 'pmessageBuffer'
 * (pattern subscribe via psubscribe) — both forward to registered handlers.
 */
export function createValkeyPubSub(
    config: ValkeyPluginConfig,
    dataClient: any,
    pubSubClient: any
) {
    const { channelPrefix } = config;
    const handlers: MessageHandler[] = [];

    function clientChannel(clientId: EntityId): string {
        return `${channelPrefix}client:${String(clientId)}`;
    }

    function broadcastChannel(): string {
        return `${channelPrefix}broadcast`;
    }

    // Forward both direct and pattern subscriptions through the same pipeline
    pubSubClient.on('messageBuffer', (_pattern: Buffer, message: Buffer) => {
        const channel = _pattern.toString();
        for (const handler of handlers) {
            handler(channel, new Uint8Array(message));
        }
    });

    pubSubClient.on('pmessageBuffer', (_pattern: Buffer, channel: Buffer, message: Buffer) => {
        const channelStr = channel.toString();
        for (const handler of handlers) {
            handler(channelStr, new Uint8Array(message));
        }
    });

    return {
        /** Publish a raw message to a specific client's channel */
        async publishToClient(
            clientId: EntityId,
            message: Uint8Array
        ): Promise<number> {
            return dataClient.publish(
                clientChannel(clientId),
                Buffer.from(message)
            );
        },

        /** Publish a raw message to the broadcast channel */
        async publishBroadcast(message: Uint8Array): Promise<number> {
            return dataClient.publish(
                broadcastChannel(),
                Buffer.from(message)
            );
        },

        /** Register a handler for all incoming backplane messages */
        onMessage(handler: MessageHandler): void {
            handlers.push(handler);
        },

        /** Extract client ID from a client channel name, or null if not a client channel */
        parseClientChannel(channel: string): EntityId | null {
            const prefix = `${channelPrefix}client:`;
            if (channel.startsWith(prefix)) {
                return channel.slice(prefix.length);
            }
            return null;
        },

        /** Check if a channel is the broadcast channel */
        isBroadcastChannel(channel: string): boolean {
            return channel === broadcastChannel();
        },

        /** Manually subscribe to a client's channel */
        async subscribeClient(clientId: EntityId): Promise<void> {
            const channel = clientChannel(clientId);
            console.log(`[valkeyPlugin] subscribing to ${channel}`);
            return pubSubClient.subscribe(channel);
        },

        /** Manually unsubscribe from a client's channel */
        async unsubscribeClient(clientId: EntityId): Promise<void> {
            const channel = clientChannel(clientId);
            console.log(`[valkeyPlugin] unsubscribing from ${channel}`);
            return pubSubClient.unsubscribe(channel);
        },

        /** Execute onConnectHydrate: read configured keys and publish to client */
        async hydrateClient(clientId: EntityId): Promise<void> {
            if (!config.onConnectHydrate) return;

            for (const entry of config.onConnectHydrate) {
                const raw = await dataClient.get(entry.key);
                const value = entry.transform ? entry.transform(raw) : raw;
                if (value !== null && value !== undefined) {
                    // FIXME — this works for string values but needs
                    // project-level encoding for structured payloads.
                    // Consider adding an 'encode' option to the hydrate entry.
                    const message = Buffer.from(String(value));
                    await dataClient.publish(clientChannel(clientId), message);
                }
            }
        },
    };
}
