import { bsonBinarySerializer, getValueSize } from '@deepkit/bson';
import { ReflectionKind } from '@deepkit/type';
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

// Track which properties are pointers for a given manager
const pointerProperties = new Map<string, Set<string>>();

/**
 * Register a property path as a pointer component
 * @internal
 */
export function registerPointerProperty(
    managerId: string,
    propertyPath: string
) {
    if (!pointerProperties.has(managerId)) {
        pointerProperties.set(managerId, new Set());
    }
    pointerProperties.get(managerId)!.add(propertyPath);
}

/**
 * Check if a property is registered as a pointer
 * @internal
 */
export function isPointerProperty(
    managerId: string | null,
    propertyPath: string
): boolean {
    if (!managerId) return false;
    return pointerProperties.get(managerId)?.has(propertyPath) ?? false;
}

/**
 * Get the pointer registry from Manager
 * @internal
 */
export function getPointerRegistry(managerId: string, componentType: string) {
    return Manager.getPointerRegistry(managerId, componentType);
}

// Add serialization hooks for pointer components
bsonBinarySerializer.bsonSerializeRegistry.prepend(
    ReflectionKind.objectLiteral,
    (type, state) => {
        if (
            type.parent?.kind !== ReflectionKind.propertySignature ||
            type.parent?.parent?.parent?.kind !==
                ReflectionKind.propertySignature
        )
            return;
        const propertyPath = `${type.parent.parent.parent.name as string}.${
            type.parent.name as string
        }`;

        // Check if this property is registered as a pointer
        if (isPointerProperty(currentManagerId, propertyPath)) {
            const componentType = type.parent.name as string;

            state.setContext({
                registry: getPointerRegistry(currentManagerId, componentType),
            });

            const start = state.compilerContext.reserveName('start');
            serializePropertyNameAware(
                type,
                state,
                BSONType.string,
                null,
                `
                var ${start} = state.writer.offset;
                const key = registry.reverse.get(${state.accessor});
                if (key === undefined) {
                    throw new Error('[Pointer Serialization] Object not found in registry for ${componentType}');
                }
                state.writer.offset += 4; //size placeholder
                state.writer.writeString(key);
                state.writer.writeByte(0); //null
                state.writer.writeDelayedSize(state.writer.offset - ${start} - 4, ${start});
                `
            );

            state.stop();
        }
    }
);

// Add sizer for pointer components
bsonBinarySerializer.sizerRegistry.prepend(
    ReflectionKind.objectLiteral,
    (type, state) => {
        if (
            type.parent?.kind !== ReflectionKind.propertySignature ||
            type.parent?.parent?.parent?.kind !==
                ReflectionKind.propertySignature
        )
            return;
        const propertyPath = `${type.parent.parent.parent.name as string}.${
            type.parent.name as string
        }`;

        // Check if this property is registered as a pointer
        if (isPointerProperty(currentManagerId, propertyPath)) {
            const componentType = type.parent.name as string;

            state.setContext({
                registry: getPointerRegistry(currentManagerId, componentType),
                getValueSize,
            });

            sizerPropertyNameAware(
                type,
                state,
                null,
                `
                const key = registry.reverse.get(${state.accessor});
                if (key === undefined) {
                    throw new Error('[Pointer Sizing] Object not found in registry for ${componentType}');
                }
                state.size += getValueSize(key);
                `
            );

            state.stop();
        }
    }
);

// Add deserialization hooks for pointer components
bsonBinarySerializer.bsonDeserializeRegistry.prepend(
    ReflectionKind.objectLiteral,
    (type, state) => {
        if (
            type.parent?.kind !== ReflectionKind.propertySignature ||
            type.parent?.parent?.parent?.kind !==
                ReflectionKind.propertySignature
        )
            return;
        const propertyPath = `${type.parent.parent.parent.name as string}.${
            type.parent.name as string
        }`;

        // Check if this property is registered as a pointer
        if (isPointerProperty(currentManagerId, propertyPath)) {
            const componentType = type.parent.name as string;

            state.setContext({
                registry: getPointerRegistry(currentManagerId, componentType),
                BSONType,
            });

            state.addCode(`
                if (state.elementType === ${BSONType.string}) {
                    const key = state.parser.parseString();
                    const value = registry.forward.get(key);
                    if (value === undefined) {
                        throw new Error('[Pointer Deserialization] Key "' + key + '" not found in registry for ${componentType}');
                    }
                    ${state.setter} = value;
                } else {
                    throw new Error('[Pointer Deserialization] Expected string type for ${componentType}, got ' + state.elementType);
                }
            `);

            state.stop();
        }
    }
);
