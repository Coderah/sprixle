import { ReflectionClass, typeOf } from '@deepkit/type';
import { applyNetwork, NetworkComponentTypes } from './networkPlugin';
import em from '../../../game/entityManager';
import { defaultComponentTypes } from '../../ecs/manager';

interface RPCMetadata {
    command: number;
    methodName: string;
    propertyKey: string | symbol;
}

const rpcRegistry = new Map<Function, RPCMetadata[]>();

/**
 * Decorator to mark a method as an RPC call
 * @param command The network command ID for this RPC
 */
export function RPC<T extends number>(command: T) {
    return function (
        target: any,
        propertyKey: string | symbol,
        descriptor: PropertyDescriptor
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
            if (this.isClient) {
                // On client: send to server
                const params = args.length === 1 ? args[0] : args;
                this.network.send(command, params);
                return;
            }

            // On server or local: execute the original method
            return originalMethod.apply(this, args);
        };

        return descriptor;
    };
}

export abstract class RPCActions<
    TCommands extends number,
    TComponents extends defaultComponentTypes & NetworkComponentTypes
> {
    network: ReturnType<typeof applyNetwork<TCommands, TComponents>>;
    isClient: boolean;

    constructor(
        network: ReturnType<typeof applyNetwork<TCommands, TComponents>>,
        isClient: boolean
    ) {
        this.network = network;
        this.isClient = isClient;
    }

    /**
     * Auto-register all RPC methods on the server
     * This should be called on server startup
     */
    registerServerHandlers() {
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
            const reflection = ReflectionClass.from(constructor);
            const methodReflection = reflection.getMethod(methodName);

            // Register the receive handler
            this.network.receive(
                command as any,
                (value: any, client: typeof em.Entity) => {
                    // Normalize parameters - if single value in array, extract it
                    const params = Array.isArray(value) ? value : [value];

                    // Call the original method with client as the last parameter
                    method.apply(this, [...params, client]);
                }
            );

            console.log(
                `Registered RPC handler for command ${command}: ${methodName}`
            );
        }
    }
}
