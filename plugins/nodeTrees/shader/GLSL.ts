import { Type } from '@deepkit/type';

export default interface GLSL<V = any> {
    vec2: any;
    vec3: any;
    vec4: any;

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
    const from =
        fromType.indexAccessOrigin?.container.typeName === 'GLSL'
            ? fromType.indexAccessOrigin.index?.literal
            : null;
    const to =
        toType.indexAccessOrigin?.container.typeName === 'GLSL'
            ? toType.indexAccessOrigin.index?.literal
            : null;

    if (!from || !to || (!from.startsWith('vec') && !to.startsWith('vec'))) {
        console.warn(
            '[convertVecSize] cannot convert because fromType or toType were invalid',
            { fromType, toType }
        );
        return reference;
    }

    // TODO support converting float to vec (float is x)
    if (from === to) return reference;

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
