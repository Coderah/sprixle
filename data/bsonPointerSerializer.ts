import { bsonBinarySerializer, getValueSize } from '@deepkit/bson';
import { ReflectionKind, dataAnnotation } from '@deepkit/type';
import {
    serializePropertyNameAware,
    sizerPropertyNameAware,
} from './sizerPropertyNameAware';
import { BSONType } from 'bson';
import { Manager } from '../ecs/manager';

// Context to track current manager during serialization
let currentManagerId: string | null = null;

/**
 * Set the manager context for pointer serialization
 * @internal
 */
export function setSerializationManagerContext(managerId: string | null) {
    currentManagerId = managerId;
}

/**
 * Get the current manager context
 * @internal
 */
export function getSerializationManagerContext() {
    return currentManagerId;
}

/**
 * Get the pointer registry from Manager
 * @internal
 */
export function getPointerRegistry(managerId: string, dataSourceName: string) {
    return Manager.getPointerRegistry(managerId, dataSourceName);
}

bsonBinarySerializer.bsonSerializeRegistry.prepend(
    ReflectionKind.any,
    (type, state) => {
        const dataSourceName = dataAnnotation.get(type, 'Pointer');
        if (!dataSourceName) {
            return;
        }

        console.error(type);
        throw new Error(
            `Pointer Type "${type.typeName}" incorrectly determined as 'any'`
        );
    }
);

// Add serialization hooks for pointer components
bsonBinarySerializer.bsonSerializeRegistry.prepend(
    ReflectionKind.objectLiteral,
    (type, state) => {
        const dataSourceName = dataAnnotation.get(type, 'Pointer');
        if (!dataSourceName) {
            return;
        }

        const registry = getPointerRegistry(currentManagerId, dataSourceName);
        if (!registry)
            throw new Error(
                `[Manager] Pointer lookups not registered for ${dataSourceName}`
            );

        state.setContext({
            registry,
        });

        const start = state.compilerContext.reserveName('start');
        state.template = `
            if (${state.accessor} !== undefined) {
                var ${start} = state.writer.offset;
                const key = registry.reverse.get(${state.accessor});
                if (key === undefined) {
                    throw new Error('[Pointer Serialization] Object not found in registry for "${dataSourceName}"');
                }
                state.writer.writeType(${BSONType.string});
                state.writer.offset += 4; //size placeholder
                state.writer.writeString(key);
                state.writer.writeByte(0); //null
                state.writer.writeDelayedSize(state.writer.offset - ${start} - 4, ${start});
            } else {
                state.writer.writeType(${BSONType.undefined});   
            }
            `;

        state.stop();
    }
);

// Add sizer for pointer components
bsonBinarySerializer.sizerRegistry.prepend(
    ReflectionKind.objectLiteral,
    (type, state) => {
        const dataSourceName = dataAnnotation.get(type, 'Pointer');
        if (!dataSourceName) {
            return;
        }

        const registry = getPointerRegistry(currentManagerId, dataSourceName);
        if (!registry)
            throw new Error(
                `[Manager] Pointer lookups not registered for ${dataSourceName}`
            );

        state.setContext({
            registry,
            getValueSize,
        });

        state.template = `
            if (${state.accessor} !== undefined) {
                const key = registry.reverse.get(${state.accessor});
                if (key === undefined) {
                    throw new Error('[Pointer Sizing] Object not found in registry for "${dataSourceName}"');
                }
                state.size += getValueSize(key);
            }`;

        state.stop();
    }
);

// Add deserialization hooks for pointer components
bsonBinarySerializer.bsonDeserializeRegistry.prepend(
    ReflectionKind.objectLiteral,
    (type, state) => {
        const dataSourceName = dataAnnotation.get(type, 'Pointer');
        if (!dataSourceName) {
            return;
        }

        const registry = getPointerRegistry(currentManagerId, dataSourceName);
        if (!registry)
            throw new Error(
                `[Manager] Pointer lookups not registered for ${dataSourceName}`
            );

        state.setContext({
            registry,
            BSONType,
        });

        state.addCode(`
            if (state.elementType === ${BSONType.string}) {
                const key = state.parser.parseString();
                const value = registry.forward.get(key);
                if (value === undefined) {
                    throw new Error('[Pointer Deserialization] Key "' + key + '" not found in registry for "${dataSourceName}"');
                }
                ${state.setter} = value;
            } else if (state.elementType === ${BSONType.undefined}) {
                ${state.setter} = undefined;
            } else {
                throw new Error('[Pointer Deserialization] Expected string type for "${dataSourceName}", got ' + state.elementType);
            }
        `);

        state.stop();
    }
);
