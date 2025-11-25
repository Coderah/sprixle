import { ReceiveType, ReflectionKind, resolveReceiveType } from '@deepkit/type';

export function unionToIterable<union>(type?: ReceiveType<union>) {
    const extracted = resolveReceiveType(type);

    if (extracted.kind === ReflectionKind.union) {
        return extracted.types.map((t) =>
            t.kind === ReflectionKind.literal ? t.literal : 'ERROR'
        ) as union[];
    } else {
        console.error(type);
        throw new Error('type was not literal');
    }
}

export function capitalize(str: string) {
    if (str.length === 0) {
        return ''; // Handle empty strings
    }
    return str.charAt(0).toUpperCase() + str.slice(1);
}
