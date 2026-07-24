import { sprixlePlugin } from '../../ecs/plugin';
import { Manager, defaultComponentTypes } from '../../ecs/manager';
import { AnySystem } from '../../ecs/system';
import { createValkeyClient } from './createValkeyClient';
import { createValkeyStore } from './valkeyStore';
import { createValkeyPubSub } from './valkeyPubSub';
import { ValkeyPluginConfig, ValkeyPluginAPI } from './types';

export type { ValkeyPluginConfig, ValkeyPluginAPI } from './types';

/**
 * Valkey backplane plugin for Sprixle ECS.
 *
 * Provides inter-instance pub/sub messaging and optional entity persistence
 * backed by Valkey. Generalized from patterns in platinum-equity-event-app.
 *
 * Two Valkey connections are created: one for data operations (GET/SET/ZADD),
 * one dedicated to pub/sub subscriptions (to keep data responses from mixing
 * with pub/sub message events).
 *
 * Channel naming:
 *   ${channelPrefix}broadcast        — broadcast to all instances
 *   ${channelPrefix}client:${id}     — per-client channel
 *   ${channelPrefix}*                — pattern subscription (catches all app channels)
 *
 * ## Usage
 *
 * ```ts
 * import ValKey from 'iovalkey';
 * import valkeyPlugin from '../sprixle/plugins/valkey/valkeyPlugin';
 *
 * const valkey = valkeyPlugin(em, {
 *     ValKey,
 *     channelPrefix: 'myapp:',
 *     clientChannels: {
 *         query: clientQuery,
 *         identityComponent: 'clientId',
 *     },
 *     entityStore: {
 *         serialize: (e) => encodeEntity(e),
 *         deserialize: (d) => decodeEntity(d),
 *         keyPattern: (id) => `entity:${id}`,
 *     },
 *     onConnectHydrate: [
 *         { key: 'singleton:stage' },
 *         { key: 'singleton:countdownTime' },
 *     ],
 * });
 *
 * // Wire incoming backplane messages to local WebSocket clients
 * valkey.onMessage((channel, message) => {
 *     // Decode and forward to connected clients on this instance
 *     const [cmd, data] = decodeMessage(message);
 *     if (channel.endsWith(':broadcast')) {
 *         network.send(cmd, data);
 *     } else {
 *         // Extract clientId from channel, find local socket, send
 *     }
 * });
 *
 * // Add lifecycle system to pipeline (manages auto channel sub/unsub)
 * const pipeline = new Pipeline(em, ...valkey.systems, myOtherSystems);
 * ```
 */
export default sprixlePlugin(function valkeyPlugin<ComponentTypes extends defaultComponentTypes>(
    manager: Manager<ComponentTypes>,
    config: ValkeyPluginConfig<ComponentTypes>
): ValkeyPluginAPI {
    const { dataClient, pubSubClient } = createValkeyClient(config);
    const pubSub = createValkeyPubSub(config, dataClient, pubSubClient);
    const store = createValkeyStore(config, dataClient);

    const systems: AnySystem[] = [];

    // Create auto-subscription lifecycle system when clientChannels is configured
    if (config.clientChannels) {
        const { query, identityComponent } = config.clientChannels;
        const refCounts = new Map<string | bigint, number>();

        const lifecycleSystem = manager.createSystem(query.createConsumer(), {
            async forNew(client: any) {
                const clientId = client.components[identityComponent as string];
                if (!clientId) return;

                const count = (refCounts.get(clientId) || 0) + 1;
                refCounts.set(clientId, count);

                if (count === 1) {
                    await pubSub.subscribeClient(clientId);
                }

                await pubSub.hydrateClient(clientId);
            },

            async forDeleted(client: any) {
                const clientId = client.components[identityComponent as string];
                if (!clientId) return;

                const count = (refCounts.get(clientId) || 1) - 1;

                if (count <= 0) {
                    refCounts.delete(clientId);
                    await pubSub.unsubscribeClient(clientId);
                } else {
                    refCounts.set(clientId, count);
                }
            },
        });

        systems.push(lifecycleSystem);
    }

    return {
        valkey: dataClient,
        valkeyPubSub: pubSubClient,

        publishToClient: pubSub.publishToClient,
        publishBroadcast: pubSub.publishBroadcast,
        onMessage: pubSub.onMessage,
        subscribeClient: pubSub.subscribeClient,
        unsubscribeClient: pubSub.unsubscribeClient,
        parseClientChannel: pubSub.parseClientChannel,
        isBroadcastChannel: pubSub.isBroadcastChannel,

        store: store ?? undefined,

        system: systems.length > 0 ? systems[0] : null,
    };
});
