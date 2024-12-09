import { camelCase } from 'lodash';
import { CompilationCache, Node } from '../createCompiler';
import GLSL, { GLSLstruct, GLSLStruct } from './GLSL';
import { ColorStop, createColorRampLUT, InterpolationType } from './colorRamp';
import shaderIncludes from './includes';
import NoiseTextureGenerator from './noise';
import { ReflectionClass, typeOf } from '@deepkit/type';

const mathOperationSymbols = {
    MULTIPLY: '*',
    DIVIDE: '/',
    ADD: '+',
    SUBTRACT: '-',
    MODULO: '%',
    // TODO in geo nodes [GREATER/LESS]_THAN actually returns 1 or 0, should we do the same instead of boolean?
    GREATER_THAN: '>',
    LESS_THAN: '<',
};

const mathFunctions = {
    POWER: 'pow($1, $2)',
    SINE: 'sin($1)',
    COSINE: 'cosine($1)',
    ARCTANGENT: 'atan($1, $2)',
    ARCTAN2: 'atan2($1, $2)',
    ABSOLUTE: 'abs($1)',
    SQRT: 'sqrt($1)',
};

type If<T, V> = any;

export const transpilerMethods = {
    TEX_NOISE(
        Vector: GLSL['vec3'],
        W: GLSL['float'] = '0.',
        Offset: GLSL['float'] = '0.',
        Gain: GLSL['float'] = '0.',
        Scale: GLSL['float'],
        Detail: GLSL['float'],
        Roughness: GLSL['float'],
        Lacunarity: GLSL['float'],
        Distortion: GLSL['float'],
        normalize: boolean,
        noise_type: string,
        noise_dimensions: string,
        node: Node,
        compilationCache: CompilationCache
    ): GLSL<{ Fac: GLSL['float']; Color: GLSL['vec4'] }> {
        const reference = camelCase(node.id);

        compilationCache.shaderIncludes.fragment.add(shaderIncludes.noise);

        // compilationCache.uniforms[reference] = {
        //     value: NoiseTextureGenerator.generateNoiseTexture({
        //         dimensions: '2D',
        //         type: noise_type,
        //         useNormalize: normalize,
        //         scale: parseFloat(Scale) * 0.2,
        //         roughness: parseFloat(Roughness),
        //         distortion: parseFloat(Distortion),
        //         lacunarity: parseFloat(Lacunarity),
        //         detail: parseFloat(Detail),
        //         width: 512,
        //         height: 512,
        //     }),
        // };
        // compilationCache.defines.add(`uniform sampler2D ${reference};`);

        // return [`texture2D(${reference}, ${Vector}).x`];
        return [
            `float ${reference}Fac = 0.0;`,
            `vec4 ${reference}Color = vec4(vec3(0.0),1.);`,
            `node_noise_tex_fbm_${noise_dimensions.toLowerCase()}(
                    ${Vector},
                    ${W},
                    ${Scale},
                    ${Detail},
                    ${Roughness},
                    ${Lacunarity},
                    ${Offset},
                    ${Gain},
                    ${Distortion},
                    ${normalize ? '1.0' : '0.0'},
                    ${reference}Fac,
                    ${reference}Color
            );`,
            `${reference}Fac, ${reference}Color`,
        ] as any;
    },
    MAPPING(
        Vector: GLSL['vec3'],
        Location: GLSL['vec3'],
        Rotation: GLSL['vec3'],
        Scale: GLSL['vec3'],
        compilationCache: CompilationCache
    ): GLSL['vec3'] {
        compilationCache.shaderIncludes.fragment.add(
            shaderIncludes.mappingNode
        );
        return [`mappingNode(${Vector}, ${Location}, ${Rotation}, ${Scale})`];
    },
    /** color ramp */
    VALTORGB(
        Fac: GLSL['float'],
        elements: ColorStop[],
        color_mode: InterpolationType,
        interpolation: string,
        node: Node,
        compilationCache: CompilationCache
    ): GLSL['vec4'] {
        const reference = camelCase(node.id) + 'LUT';
        compilationCache.uniforms[reference] = {
            value: createColorRampLUT(
                elements,
                InterpolationType[interpolation]
            ),
        };
        compilationCache.defines.add(`uniform sampler2D ${reference};`);
        compilationCache.shaderIncludes.fragment.add(shaderIncludes.colorRamp);

        // console.log('[ColorRamp] compile', ...arguments);
        return [
            `texture2D(${reference}, vec2(compute_color_map_coordinate(clamp(${Fac}, 0.0, 1.0)), 0.5))`,
        ];
    },
    OUTPUT_MATERIAL(Surface: GLSL['vec4']) {
        return [`gl_FragColor = clamp(${Surface}, 0.0, 1.0)`];
    },
    MIX_SHADER(Fac: string, Shader: string[]): GLSL['vec4'] {
        return [`mix(${Shader[0]}, ${Shader[1]}, ${Fac})`];
    },
    COMBXYZ(X: number, Y: number, Z: number): GLSL['vec3'] {
        return [`vec3(${X}, ${Y}, ${Z})`];
    },
    VECMATH(operation: string, Scale: number = 1, Vector: string[]) {
        // TODO make sure everything is supported
        return [
            `${Vector[0]}.${camelCase(JSON.parse(operation))}(${Vector[1]})`,
        ];
    },
    MAP_RANGE(
        Value: string,
        FromMin: string,
        FromMax: string,
        ToMin: string,
        ToMax: string,
        data_type: 'FLOAT' | 'VECTOR',
        interpolation_type: string,
        compilationCache: CompilationCache
    ): If<'data_type', { FLOAT: GLSL['float']; VECTOR: GLSL['vec4'] }> {
        compilationCache.shaderIncludes.fragment.add(shaderIncludes.mapRange);

        return [
            `mapRange(${Value}, ${FromMin}, ${FromMax}, ${ToMin}, ${ToMax})`,
        ];
    },
    MIX(
        Factor: string,
        A: string,
        B: string,
        data_type: 'FLOAT' | 'VECTOR' | 'RGBA',
        blend_type: string,
        factor_mode: string,
        clamp_factor: boolean,
        clamp_result: boolean
    ): If<
        'data_type',
        {
            FLOAT: GLSL['float'];
            else: GLSL['vec4'];
        }
    > {
        console.log('[MIX] transpiling', data_type);
        return [`mix(${A}, ${B}, ${Factor})`];
    },
    MATH(
        operation: string,
        use_clamp: boolean,
        Value: (string | number)[]
    ): GLSL['float'] {
        // operation = JSON.parse(operation);
        if (operation in mathOperationSymbols) {
            return [
                `${Value[0]} ${mathOperationSymbols[operation]} ${Value[1]}`,
            ];
        } else if (operation in mathFunctions) {
            const result = mathFunctions[operation]
                .replace(/\$1/g, Value[0])
                .replace(/\$2/g, Value[1])
                .replace(/\$3/g, Value[2]);

            return [result];
        }

        return [];
    },
};
