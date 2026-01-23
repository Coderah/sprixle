import { ReflectionClass } from '@deepkit/type';
import { defaultComponentTypes, Entity } from '../../ecs/manager';
import { applyNetwork, NetworkComponentTypes } from './networkPlugin';

interface RPCMetadata {
    command: number;
    methodName: string;
    propertyKey: string | symbol;
}

const rpcRegistry = new Map<Function, RPCMetadata[]>();

/**
 * Decorator to mark a method as an RPC call
 * @param command The network command ID for this RPC
 * @group Decorators
 */
export function RPC<T extends number, F extends Function>(command: T) {
    return function (
        target: any,
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
        };

        rpcRegistry.get(constructor)!.push(metadata);

        // Store the original method
        const originalMethod = descriptor.value;

        // Replace with a wrapper that handles client/server logic
        descriptor.value = function (
            this: RPCActions<any, any>,
            ...args: any[]
        ) {
            if (this.isClient && this.isNetworked) {
                // On client: send to server
                const params = args.length === 1 ? args[0] : args;
                this.network.send(command, params);
                return;
            } else if (this.isClient) {
                this.client = this.defaultClientEntity();
            }

            // On server or local: execute the original method
            return originalMethod.apply(this, args);
        } as any as F;

        return descriptor;
    };
}

export abstract class RPCActions<
    TCommands extends number,
    TComponents extends defaultComponentTypes & NetworkComponentTypes,
> {
    network: ReturnType<typeof applyNetwork<TCommands, TComponents>>;
    isClient: boolean;
    isNetworked: boolean;

    defaultClientEntity: () => Entity<Partial<TComponents>>;

    client: Entity<Partial<TComponents>>;

    constructor(
        network: ReturnType<typeof applyNetwork<TCommands, TComponents>>,
        isClient: boolean,
        isNetworked: boolean
    ) {
        this.network = network;
        this.isClient = isClient;
        this.isNetworked = isNetworked;
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

        for (const { command, methodName, propertyKey } of methods) {
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
                    console.log(
                        '[RPC receive]',
                        command,
                        methodName,
                        value,
                        client.id
                    );

                    const params = Array.isArray(value) ? value : [value];

                    self.client = client;

                    // Call the original method with client as the last parameter
                    method.apply(self, params);
                }
            );

            console.log(
                `Registered RPC handler for command ${command}: ${methodName}`
            );
        }
    }
}
