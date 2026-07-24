import { ValkeyPluginConfig } from './types';

export interface ValkeyClients {
    dataClient: any;
    pubSubClient: any;
}

/**
 * Create a pair of Valkey connections — one for data operations,
 * one dedicated to pub/sub subscriptions (prevents data responses
 * from mixing with pub/sub message events).
 *
 * The pub/sub client subscribes to the broadcast channel and a
 * pattern subscription covering all app channels.
 */
export function createValkeyClient(config: ValkeyPluginConfig): ValkeyClients {
    const { host = '127.0.0.1', port = 6379, ValKey, channelPrefix } = config;

    if (!ValKey) {
        throw new Error(
            '[valkeyPlugin] ValKey constructor is required. Pass `ValKey` in config.'
        );
    }

    const dataClient = new ValKey(port, host, {
        connectionName: `valkey-data-${channelPrefix}`,
    });

    dataClient.on('connect', () => {
        console.log(`[valkeyPlugin] data client connected (${channelPrefix})`);
    });

    dataClient.on('error', (err: Error) => {
        console.error(`[valkeyPlugin] data client error:`, err.message);
    });

    const pubSubClient = new ValKey(port, host, {
        connectionName: `valkey-pubsub-${channelPrefix}`,
    });

    pubSubClient.on('connect', () => {
        console.log(`[valkeyPlugin] pub/sub client connected (${channelPrefix})`);
    });

    pubSubClient.on('error', (err: Error) => {
        console.error(`[valkeyPlugin] pub/sub client error:`, err.message);
    });

    pubSubClient.psubscribe(`${channelPrefix}*`);
    pubSubClient.subscribe(`${channelPrefix}broadcast`);

    return { dataClient, pubSubClient };
}
