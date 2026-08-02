import { EntityId } from '../../ecs/manager';
import { ValkeyPluginConfig } from './types';

export interface ValkeyStore {
    get(id: EntityId): Promise<any | null>;
    set(entity: { id: EntityId; components: any }): Promise<void>;
    del(id: EntityId): Promise<void>;
}

/**
 * Create an optional entity persistence layer backed by Valkey.
 * Returns null when entityStore is not configured.
 *
 * Generalized from platinum-equity's getUser/storeUser/deleteUser patterns
 * (src/server/store.ts). The serializer, deserializer, and key pattern are
 * all configurable — no hardcoded BSON codec or key format.
 */
export function createValkeyStore(
    config: ValkeyPluginConfig,
    dataClient: any
): ValkeyStore | null {
    if (!config.entityStore) return null;

    const { serialize, deserialize, keyPattern } = config.entityStore;

    return {
        async get(id: EntityId): Promise<any | null> {
            const buffer: Uint8Array | null = await dataClient.getBuffer(
                keyPattern(id)
            );
            if (!buffer || !buffer.byteLength) return null;
            return deserialize(buffer);
        },

        async set(entity: { id: EntityId; components: any }): Promise<void> {
            const key = keyPattern(entity.id);
            await dataClient.set(key, Buffer.from(serialize(entity)));
        },

        async del(id: EntityId): Promise<void> {
            await dataClient.del(keyPattern(id));
        },
    };
}
