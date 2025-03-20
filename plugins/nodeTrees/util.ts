import { camelCase } from 'lodash';
import { Node } from './createCompiler';
import {
    ReflectionKind,
    ReflectionMethod,
    Type,
    TypeMethod,
} from '@deepkit/type';

const reservedWords = new Set(['mix', 'attribute', 'clamp']);
export function getReference(n: Node): string;
export function getReference(n: string): string;
export function getReference(n: string | Node): string {
    if (typeof n !== 'string') n = n.id;

    let reference = camelCase(n);

    if (reservedWords.has(reference)) {
        reference = '_' + camelCase(n);
    }

    return reference;
}

export function getStructReference(name: string) {
    return getReference('s' + name[0].toUpperCase() + name.substring(1));
}

export function getParameterReference(name: string) {
    return name.replace(/[^\d\w]/g, '');
}

export function getConditionalType(
    methodType: TypeMethod,
    type: Type,
    parameters: any[]
) {
    if (type.typeName !== 'If') return type;

    if (
        type.typeArguments?.[0]?.kind !== ReflectionKind.literal ||
        type.typeArguments?.[1]?.kind !== ReflectionKind.objectLiteral
    )
        return type;

    const conditionalParameterName = type.typeArguments[0].literal as string;

    const parameterIndex = methodType.parameters
        .map((p) => p.name)
        .indexOf(conditionalParameterName);

    const parameter = parameters[parameterIndex];

    const conditionalTypes = type.typeArguments[1].types as Type[];

    let returnType: Type | null = null;

    conditionalTypes.forEach((ct) => {
        if (ct.kind !== ReflectionKind.propertySignature) return;
        if (parameter === ct.name) {
            returnType = ct.type;
        } else if (ct.name === 'else' && !returnType) {
            returnType = ct.type;
        }
    });

    // TODO add warning?

    return returnType || type;
}

export function getReturnType(type: TypeMethod, parameters: any[]) {
    const baseReturn = type.return;

    if (!baseReturn) return baseReturn;

    return getConditionalType(type, baseReturn, parameters);
}
