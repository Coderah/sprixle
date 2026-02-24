import {
    Group,
    ReflectionKind,
    Type,
    TypeMethod,
    typeOf,
    TypePropertySignature,
} from '@deepkit/type';
import { InputType, Node } from '../createCompiler';
import { getParameterReference } from '../util';

export default interface GLSL<
    V =
        | 'vec2'
        | 'vec3'
        | 'vec4'
        | 'imageTex'
        | 'int'
        | 'uint'
        | 'bool'
        | 'float',
> {
    vec2: any;
    vec3: any;
    vec4: any;

    /** output only, to serve as a marker and allow ALPHA sockets from blender to be properly converted */
    imageTex: any;

    int: any;
    uint: any;
    bool: any;

    float: any;

    // allows inferrence based on node info (useful for entirely dynamic output)
    infer: any;
}

export type MultiSample = Group<'MultiSample'>;

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

    if ((from === 'int' || from === 'uint') && to === 'float') {
        return `float(${reference})`;
    } else if (from === 'float' && to === 'int') {
        return `int(${reference})`;
    } else if (from === 'float' && to === 'uint') {
        return `uint(${reference})`;
    } else if (from === 'imageTex' && to === 'float') {
        return `${reference}.a`;
    } else if (from === 'bool' && to === 'float') {
        return `${reference} ? 1.0 : 0.0`;
    } else if (from === 'bool' && to === 'int') {
        return `${reference} ? 1 : 0`;
    }

    from = from === 'imageTex' ? 'vec4' : from;
    to = to === 'imageTex' ? 'vec4' : to;

    if (!from || !to || (!from.startsWith('vec') && !to.startsWith('vec'))) {
        console.warn(
            '[convertVecSize] cannot convert because fromType or toType were invalid',
            { reference, from, to, fromType, toType }
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
        case 'BOOL':
        case 'BOOLEAN':
            type = typeOf<GLSL['bool']>();
            break;
        case 'INT':
        case 'INTEGER':
            type = typeOf<GLSL['int']>();
            break;
        // case 'UINT':
        //     type = typeOf<GLSL['uint']>();
        //     break;
        case 'VALUE':
        case 'FLOAT':
            type = typeOf<GLSL['float']>();
            break;
        case 'VECTOR2':
            type = typeOf<GLSL['vec2']>();
            break;
        case 'VECTOR':
        case 'VECTOR3':
            type = typeOf<GLSL['vec3']>();
            break;

        case 'VECTOR4':
            type = typeOf<GLSL['vec4']>();
            break;
        case 'RGBA':
        case 'SHADER':
            type = typeOf<GLSL['vec4']>();
            break;
        default:
            console.warn(
                '[getGLSLType] could not determine glslType from',
                intended_type
            );
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
