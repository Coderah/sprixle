import { camelCase } from 'lodash';
import { Node } from './createCompiler';
import { ReflectionKind, ReflectionMethod, Type } from '@deepkit/type';

const reservedWords = new Set(['mix']);
export function getReference(n: Node): string;
export function getReference(n: string): string;
export function getReference(n: string | Node): string {
    if (typeof n !== 'string') n = n.id;

    let reference = camelCase(n);

    if (reservedWords.has(reference)) {
        reference = camelCase('v' + n);
    }

    return reference;
}

export function getReturnType(type: ReflectionMethod, parameters: any[]) {
    const baseReturn = type.getReturnType();

    if (baseReturn.typeName !== 'If') return baseReturn;

    if (
        baseReturn.typeArguments[0].kind !== ReflectionKind.literal ||
        baseReturn.typeArguments[1].kind !== ReflectionKind.objectLiteral
    )
        return;

    const conditionalParameterName = baseReturn.typeArguments[0]
        .literal as string;

    const parameterIndex = type
        .getParameterNames()
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
