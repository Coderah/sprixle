import { EntityId, Manager, defaultComponentTypes } from '../../ecs/manager';
import { Query } from '../../ecs/query';
import { AnySystem } from '../../ecs/system';

export interface ValkeyPluginConfig<ComponentTypes extends defaultComponentTypes = any> {
    /** Hostname for the Valkey connection (default: '127.0.0.1') */
    host?: string;

    /** Port for the Valkey connection (default: 6379) */
    port?: number;

    /** The ValKey constructor — pass `import ValKey from 'iovalkey'` or equivalent */
    ValKey?: any;

    /** Prefix prepended to all channel names (e.g. 'myapp:') */
    channelPrefix: string;

    /**
     * Auto-manage per-client channel subscriptions via an ECS query.
     * When a client entity joins the query, subscribe to its channel.
     * When the last entity with a given identity leaves, unsubscribe.
     */
    clientChannels?: {
        /** The query that tracks connected clients (must include the identityComponent) */
        query: Query<ComponentTypes>;
        /** Which component on the entity holds the client identity ID */
        identityComponent: keyof ComponentTypes;
    };

    /**
     * Optional entity persistence layer.
     * When configured, provides store/get/del for ECS entities backed by Valkey.
     */
    entityStore?: {
        /** Serialize an entity to bytes (use em.createSerializer) */
        serialize: (entity: any) => Uint8Array;
        /** Deserialize bytes back to an entity */
        deserialize: (data: Uint8Array) => any;
        /** Generate a Valkey key for a given entity ID */
        keyPattern: (id: EntityId) => string;
    };

    /**
     * Optional state hydration on client connect.
     * When a client joins (per clientChannels.query forNew), read these Valkey keys
     * and publish their values to the client's channel.
     */
    onConnectHydrate?: Array<{
        /** The Valkey key to read */
        key: string;
        /** Transform the raw value before publishing (e.g. parse to boolean) */
        transform?: (value: string | null) => any;
    }>;
}

/** Return type of valkeyPlugin — the plugin's public API */
export interface ValkeyPluginAPI {
    /** Raw Valkey client for data operations (GET/SET/ZADD/etc.) */
    valkey: any;

    /** Dedicated Valkey client for pub/sub subscriptions */
    valkeyPubSub: any;

    /** Publish a message to a specific client's channel */
    publishToClient(clientId: EntityId, message: Uint8Array): Promise<number>;

    /** Publish a message to the broadcast channel */
    publishBroadcast(message: Uint8Array): Promise<number>;

    /** Register a handler for incoming backplane messages */
    onMessage(handler: (channel: string, message: Uint8Array) => void): void;

    /** Subscribe to a client's channel (manual — use clientChannels config for auto) */
    subscribeClient(clientId: EntityId): Promise<void>;

    /** Unsubscribe from a client's channel (manual — use clientChannels config for auto) */
    unsubscribeClient(clientId: EntityId): Promise<void>;

    /** Extract client ID from a client channel name, or null if not a client channel */
    parseClientChannel(channel: string): EntityId | null;

    /** Check if a channel name is the broadcast channel */
    isBroadcastChannel(channel: string): boolean;

    /**
     * Live entity store (available when entityStore is configured in the config).
     * Provides CRUD operations backed by Valkey keys.
     */
    store?: {
        get(id: EntityId): Promise<any | null>;
        set(entity: { id: EntityId; components: any }): Promise<void>;
        del(id: EntityId): Promise<void>;
    };

    /**
     * The lifecycle system that manages auto channel subscriptions.
     * Add this to your pipeline when clientChannels is configured.
     * Returns null when clientChannels is not configured.
     */
    system: AnySystem | null;
}
