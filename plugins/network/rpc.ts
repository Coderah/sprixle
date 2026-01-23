import { forwardTypeArguments } from '@deepkit/core';
import applyNetwork from './networkPlugin';
import type { NetworkComponentTypes } from './networkPlugin';
import applyReconciliation, {
    ReconciliationStrategy,
    ReconciliationComponentTypes,
} from './reconciliationPlugin';
import { defaultComponentTypes, Entity, Manager } from '../../ecs/manager';

// this line is required for runtime reference...
applyNetwork;
applyReconciliation;

interface RPCMetadata {
    command: number;
    methodName: string;
    propertyKey: string | symbol;
    reconciliationStrategy: ReconciliationStrategy;
}

const rpcRegistry = new Map<Function, RPCMetadata[]>();

export type { ReconciliationStrategy };

/**
 * Decorator to mark a method as an RPC call
 * @param command The network command ID for this RPC
 * @group Decorators
 */
export function RPC<T extends number, F extends Function>(
    command: T,
    reconciliationStrategy: ReconciliationStrategy = 'none'
) {
    return function (
        target: RPCActions<any, any>,
        propertyKey: string | symbol,
        descriptor: TypedPropertyDescriptor<F>
    ) {
        const constructor = target.constructor;

        if (!rpcRegistry.has(constructor)) {
            rpcRegistry.set(constructor, []);
        }

        const metadata: RPCMetadata = {
            command,
            methodName: String(propertyKey),
            propertyKey,
            reconciliationStrategy,
        };

        rpcRegistry.get(constructor)!.push(metadata);

        // Store the original method
        const originalMethod = descriptor.value;

        // Replace with a wrapper that handles client/server logic
        descriptor.value = function (
            this: RPCActions<any, any>,
            ...args: any[]
        ) {
            if (reconciliationStrategy !== 'none' && !this.reconciliation) {
                throw new Error(
                    '[RPC] Trying to use a reconciliationStrategy without applying the reconcilationPlugin will cause issues.'
                );
            }

            if (this.isClient && this.isNetworked) {
                let params = args.length === 1 ? args[0] : args;
                let version: number | undefined;

                // If reconciliation is enabled, execute locally first (optimistic)
                if (reconciliationStrategy !== 'none' && this.reconciliation) {
                    this.client = this.defaultClientEntity();

                    // Get version before executing
                    version = this.reconciliation.getNextVersion();

                    this.manager.subTick();

                    // Execute the original method optimistically
                    forwardTypeArguments(descriptor.value, originalMethod);
                    originalMethod.apply(this, args);

                    // Track the reconcilable action with the version
                    this.reconciliation.trackReconcilableAction(
                        reconciliationStrategy,
                        version
                    );

                    // Prepend version to params for sending
                    params = Array.isArray(params)
                        ? [version, ...params]
                        : [version, params];
                }

                // Send to server
                this.network.send(command, params);
                return;
            } else if (this.isClient) {
                this.client = this.defaultClientEntity();
            }

            // On server or local: execute the original method
            forwardTypeArguments(descriptor.value, originalMethod);
            const result = originalMethod.apply(this, args);

            return result;
        } as any as F;

        return descriptor;
    };
}

export abstract class RPCActions<
    TCommands extends number,
    TComponents extends defaultComponentTypes &
        NetworkComponentTypes &
        ReconciliationComponentTypes,
> {
    network: ReturnType<typeof applyNetwork<TCommands, TComponents>>;
    reconciliation: ReturnType<typeof applyReconciliation<TComponents>> | null;
    manager: Manager<TComponents>;
    isClient: boolean;
    isNetworked: boolean;

    defaultClientEntity: () => Entity<Partial<TComponents>>;

    client: Entity<Partial<TComponents>>;

    constructor(
        manager: Manager<TComponents>,
        network: ReturnType<typeof applyNetwork<TCommands, TComponents>>,
        isClient: boolean,
        isNetworked: boolean
    ) {
        this.network = network;
        this.isClient = isClient;
        this.isNetworked = isNetworked;

        this.manager = manager;
        this.reconciliation =
            manager.plugins.get('reconciliationPlugin') ?? null;
    }

    /**
     * Auto-register all RPC methods on the server
     * This should be called on server startup
     */
    registerServerHandlers() {
        const self = this;
        const constructor = this.constructor;
        const methods = rpcRegistry.get(constructor);

        if (!methods) {
            console.warn('No RPC methods found for', constructor.name);
            return;
        }

        for (const {
            command,
            methodName,
            propertyKey,
            reconciliationStrategy,
        } of methods) {
            const method = (this as any)[propertyKey];

            if (typeof method !== 'function') {
                console.warn(`RPC method ${methodName} not found on instance`);
                continue;
            }

            // Extract parameter types using Deepkit reflection
            // TODO probably need to actually use type info for param deserialize but for now its getting handled generically just fine
            // const reflection = ReflectionClass.from(constructor);
            // const methodReflection = reflection.getMethod(methodName);

            // Register the receive handler
            this.network.receive(
                command as any,
                (value: any, client: Entity<Partial<TComponents>>) => {
                    let params = Array.isArray(value) ? value : [value];
                    let reconciliationVersion: number | undefined;

                    // If this RPC has reconciliation, extract the version from params
                    if (
                        reconciliationStrategy !== 'none' &&
                        params.length > 0
                    ) {
                        reconciliationVersion = params[0] as number;
                        params = params.slice(1);
                    }

                    console.log(
                        '[RPC receive]',
                        command,
                        methodName,
                        value,
                        client.id,
                        reconciliationVersion !== undefined
                            ? `v${reconciliationVersion}`
                            : ''
                    );

                    self.client = client;

                    this.manager.subTick();

                    // Call the original method
                    method.apply(self, params);

                    // If reconciliation is enabled, apply the version to modified entities
                    if (
                        reconciliationVersion !== undefined &&
                        self.reconciliation
                    ) {
                        self.reconciliation.applyReconciliationVersion(
                            reconciliationVersion
                        );
                    }
                }
            );

            console.log(
                `Registered RPC handler for command ${command}: ${methodName}`,
                reconciliationStrategy !== 'none'
                    ? `(reconciliation: ${reconciliationStrategy})`
                    : ''
            );
        }
    }
}
