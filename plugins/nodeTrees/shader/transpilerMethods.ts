import { camelCase } from 'lodash';
import { CompilationCache, Node } from '../createCompiler';
import GLSL from './GLSL';
import { ColorStop, createColorRampLUT, InterpolationType } from './colorRamp';
import { addDiffuseBSDF } from './diffuseBSDF';
import shaderIncludes from './includes';
import blenderVector from './blenderVector';
import {
    LinearFilter,
    LinearMipMapLinearFilter,
    RepeatWrapping,
    SRGBColorSpace,
    TextureLoader,
    Vector3,
} from 'three';
import { addBlenderDependency } from './blender';
import noise from './blender/noise';
import hue_sat_val from './blender/hue_sat_val';
import fresnel from './blender/fresnel';
import clamp from './blender/clamp';
import gpu_shader_material_tex_white_noise from './blender/gpu_shader_material_tex_white_noise';

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

type PartialSupport = { __meta?: ['PartialSupport'] };
type StubbedSupport = { __meta?: ['StubbedSupport'] };

// REFERENCE: https://github.com/blender/blender/blob/a7bc3e3418d8e1c085f2393ff8d5deded43fb21d/source/blender/gpu/shaders/common/gpu_shader_common_math.glsl
const mathFunctions = {
    REFLECT: `reflect($1, normalize($2))`,
    REFRACT: `refract($1, normalize($2), $Scale)`,
    CROSS_PRODUCT: `cross($1, $2)`,
    DOT_PRODUCT: `dot($1, $2)`,
    FLOOR: 'floor($1)',
    CEIL: 'ceil($1)',
    ROUND: 'round($1)',
    POWER: 'pow($1, $2)',
    SINE: 'sin($1)',
    COSINE: 'cosine($1)',
    ARCTANGENT: 'atan($1, $2)',
    ARCTAN2: 'atan2($1, $2)',
    ABSOLUTE: 'abs($1)',
    SQRT: 'sqrt($1)',
    SNAP: 'floor($1 / $2) * $2',
    FLOORED_MODULO: '($2 != 0.0) ? $1 - floor($1 / $2) * $2 : 0.0',
    PINGPONG:
        '($2 != 0.0) ? abs(fract(($1 - $2) / ($2 * 2.0)) * $2 * 2.0 - $2) : 0.0',
    SCALE: '$1 * $Scale',
};

type If<T, V> = any;

// TODO pull out / pass in, etc
const textureLoader = new TextureLoader();

export const transpilerMethods = {
    ATTRIBUTE(
        // TODO?
        attribute_type: 'INSTANCER' | 'OBJECT' | 'GEOMETRY',
        attribute_name: string,
        compilationCache: CompilationCache
    ): GLSL['vec3'] {
        const reference = camelCase(attribute_name);
        const varyingReference = camelCase(
            'v' + attribute_name[0].toUpperCase() + attribute_name.substring(1)
        );
        const include = `varying vec3 ${varyingReference};`;

        compilationCache.shader.vertexIncludes.add(
            `attribute vec3 ${reference};`
        );
        compilationCache.shader.vertexIncludes.add(include);
        compilationCache.shader.fragmentIncludes.add(include);

        compilationCache.shader.vertex.push(
            `${varyingReference} = ${reference};`
        );

        return [varyingReference];
    },
    TEX_IMAGE(
        Vector: GLSL['vec2'],
        image: string,
        compilationCache: CompilationCache
    ): GLSL<{ Color: GLSL['vec3']; Alpha: GLSL['float'] }> {
        // TODO revisit using GLSL['imageTex'] as rewrite return type
        const reference = camelCase(image);
        compilationCache.shader.fragmentIncludes.add(
            `uniform sampler2D ${reference};`
        );
        compilationCache.shader.fragmentIncludes.add(blenderVector);
        // TODO get from cache
        const texture = textureLoader.load('assets/textures/' + image);
        // TODO pull from node
        texture.colorSpace = SRGBColorSpace;
        texture.wrapS = texture.wrapT = RepeatWrapping;
        texture.magFilter = texture.minFilter = LinearFilter;
        // texture.minFilter = LinearMipMapLinearFilter;
        compilationCache.uniforms[reference] = {
            value: texture,
        };
        return [
            `vec4 ${reference}Sample = texture2D(${camelCase(
                image
            )}, ${Vector});`,
            `${reference}Sample.rgb, ${reference}Sample.a`,
        ] as any;
    },
    HUE_SAT(
        Hue: GLSL['float'],
        Saturation: GLSL['float'],
        Value: GLSL['float'],
        Fac: GLSL['float'],
        Color: GLSL['vec4'],
        node: Node,
        compilationCache: CompilationCache
    ): GLSL['vec4'] {
        const reference = camelCase(node.id);

        addBlenderDependency(hue_sat_val, compilationCache);

        return [
            `vec4 ${reference}Color = vec4(0.);`,
            `hue_sat(${Hue}, ${Saturation}, ${Value}, ${Fac}, ${Color}, ${reference}Color);`,
            `${reference}Color`,
        ];
    },
    /* {
    "id": "White Noise Texture",
    "type": "TEX_WHITE_NOISE",
    "name": "TEX_WHITE_NOISE",
    "inputs": {
        "Vector": {
            "type": "linked",
            "links": [
                {
                    "node": "Combine XYZ.001",
                    "socket": "Vector"
                }
            ],
            "intended_type": "VECTOR"
        }
    },
    "outputs": {
        "Value": {
            "value": 0,
            "type": "VALUE"
        },
        "Color": {
            "type": "linked",
            "links": [
                {
                    "node": "Separate XYZ",
                    "socket": "Vector"
                }
            ],
            "intended_type": "RGBA"
        }
    },
    "properties": {
        "noise_dimensions": "2D"
    }
}*/
    TEX_WHITE_NOISE(
        Vector: GLSL['vec3'] = 'vec3(0.0)',
        W: GLSL['float'] = '0.0',
        noise_dimensions: string,
        node: Node,
        compilationCache: CompilationCache
    ): GLSL<{ Value: GLSL['float']; Color: GLSL['vec4'] }> {
        const reference = camelCase(node.id);

        addBlenderDependency(
            gpu_shader_material_tex_white_noise,
            compilationCache
        );

        return [
            `float ${reference}Value = 0.0;`,
            `vec4 ${reference}Color = vec4(vec3(0.0), 1.);`,
            `node_white_noise_${noise_dimensions.toLowerCase()}(
                    ${Vector},
                    ${W},
                    ${reference}Value,
                    ${reference}Color
            );`,
            `${reference}Value, ${reference}Color`,
        ] as any;
    },
    LIGHT_PATH(): StubbedSupport & GLSL['float'] {
        return ['0.0'];
    },
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

        // compilationCache.shader.fragmentIncludes.add(shaderIncludes.noise);
        addBlenderDependency(noise, compilationCache);

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
    VECTOR_ROTATE(
        Vector: GLSL['vec3'],
        Angle: GLSL['float'],
        Axis: GLSL['vec3'],
        Center: GLSL['vec3'],
        invert: boolean,
        rotation_type: string
    ): GLSL['vec3'] {
        // TODO implement other rotation_types;
        return [
            `rotate_around_axis(${Vector} - ${Center}, normalize(${Axis}), ${Angle} * ${
                invert ? '-1.' : '1.'
            }) + ${Center}`,
        ];
    },
    MAPPING(
        Vector: GLSL['vec3'],
        Location: GLSL['vec3'],
        Rotation: GLSL['vec3'],
        Scale: GLSL['vec3'],
        compilationCache: CompilationCache
    ): GLSL['vec3'] {
        compilationCache.shader.fragmentIncludes.add(
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
        compilationCache.shader.fragmentIncludes.add(
            `uniform sampler2D ${reference};`
        );
        compilationCache.shader.fragmentIncludes.add(shaderIncludes.colorRamp);

        // console.log('[ColorRamp] compile', ...arguments);
        return [
            `texture2D(${reference}, vec2(compute_color_map_coordinate(clamp(${Fac}, 0.0, 1.0)), 0.5))`,
        ];
    },
    BSDF_TRANSPARENT(Color: GLSL['vec3']): GLSL['vec4'] {
        return [`vec4(0.,0.,0.,1. - clamp(length(${Color}), 0., 1.))`];
    },
    BSDF_DIFFUSE(
        Color: GLSL['vec3'],
        Roughness: GLSL['float'],
        Normal: GLSL['vec3'] = 'vNormal',
        compilationCache: CompilationCache
    ): GLSL['vec3'] {
        addDiffuseBSDF(compilationCache);

        return [`DiffuseBSDF(${Color}, ${Roughness}, ${Normal})`];
    },
    CLAMP(
        Max: GLSL['float'],
        Min: GLSL['float'],
        Value: GLSL['float'],
        clamp_type: string,
        compilationCache: CompilationCache
    ): GLSL['float'] {
        addBlenderDependency(clamp, compilationCache);
        return [
            `${
                clamp_type === 'RANGE' ? 'clamp_range' : 'clamp_minmax'
            }(${Value}, ${Min}, ${Max})`,
        ];
    },
    FRESNEL(
        IOR: GLSL['float'],
        Normal: GLSL['vec3'] = 'vNormal',
        node: Node,
        compilationCache: CompilationCache
    ): GLSL['float'] {
        const reference = camelCase(node.id);
        addBlenderDependency(fresnel, compilationCache);
        return [
            `float ${reference}Calc = 0.0;`,
            `node_fresnel(${IOR}, ${Normal}, ${reference}Calc);`,
            `${reference}Calc`,
        ];
    },
    SHADERTORGB(Shader: GLSL['vec4']): GLSL['vec4'] {
        return [Shader];
    },
    OUTPUT_MATERIAL(Surface: GLSL['vec4']) {
        return [`gl_FragColor = ${Surface}`];
    },
    MIX_SHADER(Fac: GLSL['float'], Shader: GLSL['vec4'][]): GLSL['vec4'] {
        return [`mix(${Shader[0]}, ${Shader[1]}, ${Fac})`];
    },
    COMBXYZ(
        // TODO figure out why making this a float causes average and +'.z'
        X: number,
        Y: number,
        Z: number
    ): GLSL['vec3'] {
        return [`vec3(${X}, ${Y}, ${Z})`];
    },
    OBJECT_INFO(compilationCache: CompilationCache): GLSL['vec3'] {
        // make vPosition available
        compilationCache.defines.add('USE_OBJECT_INFO');
        compilationCache.uniforms.objectLocation = { value: new Vector3() };

        // compilationCache.defines.add('USE_ALPHAHASH');
        return ['vObjectLocation'];
    },
    'Camera Position'(): GLSL['vec3'] {
        return ['cameraPosition'];
    },
    UVMAP(compilationCache: CompilationCache): PartialSupport & GLSL['vec2'] {
        compilationCache.defines?.add('USE_UV');

        return ['vec2(vUv.x, 1. - vUv.y)'];
    },
    TEX_COORD(compilationCache: CompilationCache): GLSL<{
        Generated: GLSL['vec3'];
        UV: GLSL['vec2'];
        Normal: GLSL['vec3'];
        Object: GLSL['vec3'];
    }> {
        compilationCache.defines.add('USE_OBJECT_NORMAL');
        compilationCache.defines?.add('USE_UV');
        compilationCache.defines.add('USE_ALPHAHASH');

        // TODO support and generate Generated uvs by bounding box, detect generated slot is used via node parameter

        return [
            'vPosition, vec2(vUv.x, 1. - vUv.y), vObjectNormal, vPosition',
        ] as any;
    },
    NEW_GEOMETRY(compilationCache: CompilationCache): GLSL<{
        Position: GLSL['vec3'];
        Normal: GLSL['vec3'];
        Backfacing: GLSL['float'];
    }> {
        compilationCache.defines.add('USE_GEOMETRY');
        return [
            'vWorldPosition, vWorldNormal, gl_FrontFacing ? 0.0 : 1.0',
        ] as any;
    },
    VECT_MATH(
        operation: string,
        Scale: number = 1,
        Vector: GLSL['vec3'][]
    ): If<
        'operation',
        {
            DOT_PRODUCT: GLSL['float'];
            else: GLSL['vec3'];
        }
    > {
        if (operation in mathOperationSymbols) {
            return [
                `${Vector[0]} ${mathOperationSymbols[operation]} ${Vector[1]}`,
            ];
        } else if (operation in mathFunctions) {
            const result = mathFunctions[operation]
                .replace(/\$1/g, Vector[0])
                .replace(/\$2/g, Vector[1])
                .replace(/\$3/g, Vector[2])
                .replace(/\$Scale/g, Scale);

            return [result];
        }

        // TODO make sure everything is supported
        return [`VECT_MATH_UNSUPPORTED_ERROR(${operation})`];
        // return [`${Vector[0]}.${camelCase(operation)}(${Vector[1]})`];
    },
    MAP_RANGE(
        data_type: 'FLOAT' | 'FLOAT_VECTOR',
        Value: If<
            'data_type',
            { FLOAT: GLSL['float']; FLOAT_VECTOR: GLSL['vec3'] }
        >,
        Vector: If<
            'data_type',
            { FLOAT: GLSL['float']; FLOAT_VECTOR: GLSL['vec3'] }
        >,
        FromMin: string,
        FromMax: string,
        ToMin: string,
        ToMax: string,
        // TODO
        interpolation_type: string,
        compilationCache: CompilationCache
    ): If<'data_type', { FLOAT: GLSL['float']; FLOAT_VECTOR: GLSL['vec3'] }> {
        compilationCache.shader.fragmentIncludes.add(shaderIncludes.mapRange);

        return [
            `mapRange(${
                Vector || Value
            }, ${FromMin}, ${FromMax}, ${ToMin}, ${ToMax})`,
        ];
    },
    /**
     * Only partially supported currently
     */
    MIX(
        Factor: string,
        A: string,
        B: string,
        data_type: 'FLOAT' | 'VECTOR' | 'RGBA',
        blend_type: string,
        factor_mode: string,
        clamp_factor: boolean,
        clamp_result: boolean
    ): PartialSupport &
        If<
            'data_type',
            {
                FLOAT: GLSL['float'];
                VECTOR: GLSL['vec3'];
                else: GLSL['vec4'];
            }
        > {
        return [`mix(${A}, ${B}, ${Factor})`];
    },
    MATH(
        operation: string,
        use_clamp: boolean,
        Value: GLSL['float'][]
    ): GLSL['float'] {
        let result: string = `MATH_ERROR_${operation}`;
        if (operation in mathOperationSymbols) {
            result = `${Value[0]} ${mathOperationSymbols[operation]} ${Value[1]}`;
        } else if (operation in mathFunctions) {
            result = mathFunctions[operation]
                .replace(/\$1/g, Value[0])
                .replace(/\$2/g, Value[1])
                .replace(/\$3/g, Value[2]);
        }

        if (use_clamp) result = `clamp(${result}, 0., 1.)`;

        return [result];
    },
};
