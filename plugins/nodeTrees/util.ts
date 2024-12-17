import { camelCase } from 'lodash';
import { Node } from './createCompiler';
import {
    ReflectionKind,
    ReflectionMethod,
    Type,
    TypeMethod,
} from '@deepkit/type';

const reservedWords = new Set(['mix', 'attribute']);
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

export function getReturnType(type: TypeMethod, parameters: any[]) {
    const baseReturn = type.return;

    if (!baseReturn) return baseReturn;

    if (baseReturn.typeName !== 'If') return baseReturn;

    if (
        baseReturn.typeArguments?.[0]?.kind !== ReflectionKind.literal ||
        baseReturn.typeArguments?.[1]?.kind !== ReflectionKind.objectLiteral
    )
        return;

    const conditionalParameterName = baseReturn.typeArguments[0]
        .literal as string;

    const parameterIndex = type.parameters
        .map((p) => p.name)
        .indexOf(conditionalParameterName);

    const parameter = parameters[parameterIndex];

    const conditionalTypes = baseReturn.typeArguments[1].types as Type[];

    let returnType: Type | null = null;

    conditionalTypes.forEach((ct) => {
        if (ct.kind !== ReflectionKind.propertySignature) return;
        if (parameter === ct.name) {
            returnType = ct.type;
        } else if (ct.name === 'else' && !returnType) {
            returnType = ct.type;
        }
    });

    return returnType || baseReturn;
}
