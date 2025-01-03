import {
    ReflectionKind,
    Type,
    TypeMethod,
    typeOf,
    TypePropertySignature,
} from '@deepkit/type';
import { InputType, Node } from '../createCompiler';
import { getParameterReference, getReference } from '../util';

export default interface GLSL<V = any> {
    vec2: any;
    vec3: any;
    vec4: any;

    /** output only, to serve as a marker and allow ALPHA sockets from blender to be properly converted */
    imageTex: any;

    int: any;

    float: any;
}

// export interface GLSL<V = any> {
//     struct: any
// };

const vectorAccessors = ['x', 'y', 'z', 'w'];
const preferredDefaults = ['0.0', '0.0', '0.0', '1.0'] as const;
export function convertVecSize(
    reference: string,
    fromType: Type,
    toType: Type,
    defaults = preferredDefaults
) {
    // TODO handle?
    if (!fromType || !toType) return reference;
    fromType =
        fromType.kind === ReflectionKind.array ? fromType.type : fromType;
    toType = toType.kind === ReflectionKind.array ? toType.type : toType;

    let from =
        fromType.indexAccessOrigin?.container.typeName === 'GLSL'
            ? fromType.indexAccessOrigin.index?.literal
            : null;
    let to =
        toType.indexAccessOrigin?.container.typeName === 'GLSL'
            ? toType.indexAccessOrigin.index?.literal
            : null;

    if (from === to) return reference;

    if (from === 'int' && to === 'float') {
        return `float(${reference})`;
    } else if (from === 'float' && to === 'int') {
        return `int(${reference})`;
    } else if (from === 'imageTex' && to === 'float') {
        return `${reference}.a`;
    }

    from = from === 'imageTex' ? 'vec4' : from;
    to = to === 'imageTex' ? 'vec4' : to;

    if (!from || !to || (!from.startsWith('vec') && !to.startsWith('vec'))) {
        console.warn(
            '[convertVecSize] cannot convert because fromType or toType were invalid',
            { from, to, fromType, toType }
        );
        return reference;
    }

    const pars: string[] = [];
    const fromN = parseInt(from[from.length - 1]);

    if (to === 'float') {
        for (let n = 0; n < Math.min(fromN, 3); n++) {
            pars.push(`${reference}.${vectorAccessors[n]}`);
        }

        return `(${pars.join(' + ')}) / 3.`;
    }

    const toN = parseInt(to[to.length - 1]);

    if (from === 'float') {
        for (let n = 0; n < toN; n++) {
            pars.push(reference);
        }
    } else if (toN > fromN) {
        pars.push(reference);
        const nToAdd = toN - fromN;

        for (let n = 0; n < nToAdd; n++) {
            pars.push(defaults[fromN + n]);
        }
    } else {
        for (let n = 0; n < toN; n++) {
            pars.push(vectorAccessors[n]);
        }
        return `${reference}.${pars.join('')}`;
    }

    return `${to}(${pars.join(', ')})`;
}

export function getGLSLType(intended_type: InputType) {
    let type: Type;

    switch (intended_type) {
        case 'INT':
        case 'INTEGER':
            type = typeOf<GLSL['int']>();
            break;
        case 'VALUE':
        case 'FLOAT':
            type = typeOf<GLSL['float']>();
            break;
        case 'VECTOR':
            type = typeOf<GLSL['vec3']>();
            break;
        case 'RGBA':
            type = typeOf<GLSL['vec4']>();
            break;
    }

    return type;
}

export function dynamicNodeToType(node: Node): TypeMethod {
    const genericMethod = typeOf<(input: string) => GLSL<{}>>() as TypeMethod;

    // type inference
    if (genericMethod.return.kind !== 30) return;
    if (
        genericMethod.return.typeArguments?.[0].kind !==
        ReflectionKind.objectLiteral
    )
        return;

    const genericParameter = genericMethod.parameters[0];
    genericMethod.parameters.pop();

    for (let key in node.inputs) {
        if (!key) continue;
        const input = Array.isArray(node.inputs[key])
            ? node.inputs[key][0]
            : node.inputs[key];

        // TODO array is custom?? what even is that about
        const intended_type =
            input.type === 'linked' ? input.intended_type : input.type;

        let type: Type = getGLSLType(intended_type);

        const typeParameter = { ...genericParameter };

        if (type) {
            typeParameter.name = getParameterReference(key);
            typeParameter.type = type;
            genericMethod.parameters.push(typeParameter);
            // genericMethod.return.typeArguments[0].types.push(typeProperty);
        } else {
            console.warn(
                '[dynamicNodeToType] unable to determine output type',
                key,
                intended_type
            );
        }
    }

    for (let key in node.outputs) {
        if (!key) continue;
        const output = node.outputs[key];

        // TODO array is custom?? what even is that about
        const intended_type =
            output.type === 'linked' ? output.intended_type : output.type;

        let type: Type = getGLSLType(intended_type);

        const typeProperty = typeOf<{ property: string }>().types[0];

        //type inference
        if (typeProperty.kind !== ReflectionKind.propertySignature) return;

        typeProperty.parent = genericMethod.return.typeArguments[0];

        if (type) {
            typeProperty.name = getParameterReference(key);
            typeProperty.type = type;
            genericMethod.return.typeArguments[0].types.push(typeProperty);
        } else {
            console.warn(
                '[dynamicNodeToType] unable to determine output type',
                key,
                intended_type
            );
        }
    }

    // if (node.type === 'GROUP_OUTPUT') {
    //     genericMethod.return.
    // }

    // console.log('[dynamicNodeToType]', node, genericMethod);

    return genericMethod;
}
