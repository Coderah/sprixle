import { camelCase } from 'lodash';
import {
    addContextualShaderInclude,
    CompilationCache,
    Node,
    shaderTargetInputs,
} from '../createCompiler';
import GLSL from './GLSL';
import { ColorStop, createColorRampLUT, InterpolationType } from './colorRamp';
import { addDiffuseBSDF } from './diffuseBSDF';
import shaderIncludes from './includes';
import blenderVector from './blenderVector';
import {
    LinearFilter,
    LinearMipMapLinearFilter,
    NearestFilter,
    RepeatWrapping,
    SRGBColorSpace,
    Texture,
    TextureLoader,
    Vector3,
} from 'three';
import { addBlenderDependency } from './blender';
import noise from './blender/noise';
import hue_sat_val from './blender/hue_sat_val';
import fresnel from './blender/gpu_shader_material_fresnel';
import clamp from './blender/clamp';
import gpu_shader_material_tex_white_noise from './blender/gpu_shader_material_tex_white_noise';
import { getReference } from '../util';
import gpu_shader_material_layer_weight from './blender/gpu_shader_material_layer_weight';
import { getCompositeTexture } from './compositeTexture';
import gpu_shader_common_mix_rgb from './blender/gpu_shader_common_mix_rgb';
import { glsl } from '../../../shader/util';
import {
    cameraFarUniform,
    cameraNearUniform,
    depthUniform,
    resolutionUniform,
    uniformFrame,
    uniformTime,
} from './uniforms';
import { filterGLSL, KernelType } from './blender/kernelFilters';
import gpu_shader_common_color_utils from './blender/gpu_shader_common_color_utils';

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
type VertexShader<T extends string = 'default'> = {
    __meta?: ['VertexShader', T];
};

// REFERENCE: https://github.com/blender/blender/blob/a7bc3e3418d8e1c085f2393ff8d5deded43fb21d/source/blender/gpu/shaders/common/gpu_shader_common_math.glsl
const mathFunctions = {
    LENGTH: 'length($1)',
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
    FRACT: `fract($1)`,
    NORMALIZE: `normalize($1)`,
    COMPARE: `(abs($1 - $2) <= max($3, 1e-5)) ? 1.0 : 0.0`,
    SIGN: `sign($1)`,
    MINIMUM: 'min($1, $2)',
    MAXIMUM: 'max($1, $2)',
};

const mixFunctions = {
    RGBA: {
        MIX: 'mix_blend',
        DARKEN: 'mix_dark',
        LIGHTEN: 'mix_light',
        VALUE: 'mix_val',
        COLOR_DODGE: 'mix_dodge',
        COLOR_BURN: 'mix_burn',
    },
};

type If<T, V> = any;

// TODO pull out / pass in, etc
const textureLoader = new TextureLoader();

export const transpilerMethods = {
    ATTRIBUTE(
        // TODO?
        attribute_type: 'INSTANCER' | 'OBJECT' | 'GEOMETRY',
        attribute_name: string,
        linkedOutput: string,
        compilationCache: CompilationCache
    ): If<'linkedOutput', { Vector: GLSL['vec3']; Factor: GLSL['float'] }> {
        const reference = camelCase(attribute_name);
        const varyingReference = camelCase(
            'v' + attribute_name[0].toUpperCase() + attribute_name.substring(1)
        );

        let type = 'float';

        if (linkedOutput === 'Vector') {
            type = 'vec3';
        }

        const include = `varying ${type} ${varyingReference};`;

        compilationCache.shader.vertexIncludes.add(
            `attribute ${type} ${reference};`
        );
        compilationCache.shader.vertexIncludes.add(include);
        compilationCache.shader.fragmentIncludes.add(include);

        compilationCache.shader.vertex.push(
            `${varyingReference} = ${reference};`
        );

        return [varyingReference];
    },
    VALUE(value: GLSL['float']): GLSL['float'] {
        return [`${parseFloat(value).toFixed(4)}`];
    },
    SCENE_TIME(
        compilationCache: CompilationCache
    ): GLSL<{ Seconds: GLSL['float']; Frame: GLSL['float'] }> {
        compilationCache.uniforms.uTime = uniformTime;
        compilationCache.uniforms.uFrame = uniformFrame;

        addContextualShaderInclude(compilationCache, 'uniform float uTime;');
        addContextualShaderInclude(compilationCache, 'uniform float uFrame;');

        return [`uTime, uFrame`] as any;
    },
    TEX_IMAGE(
        Vector: GLSL['vec2'],
        image: string,
        node: Node,
        compilationCache: CompilationCache
    ): GLSL<{ Color: GLSL['vec3']; Alpha: GLSL['float'] }> {
        // TODO revisit using GLSL['imageTex'] as rewrite return type
        const reference = getReference(node);
        const uniformReference = camelCase(image);
        addContextualShaderInclude(
            compilationCache,
            `uniform sampler2D ${uniformReference};`
        );
        addContextualShaderInclude(compilationCache, blenderVector);
        // TODO get from cache
        const texture = textureLoader.load('assets/textures/' + image);
        texture.flipY = true;
        // TODO pull from node
        texture.colorSpace = SRGBColorSpace;
        texture.wrapS = texture.wrapT = RepeatWrapping;
        texture.magFilter = texture.minFilter = LinearFilter;
        texture.minFilter = LinearMipMapLinearFilter;
        compilationCache.uniforms[uniformReference] = {
            value: texture,
        };
        return [
            `vec4 ${reference}Sample = texture2D(${uniformReference}, ${Vector});`,
            `${reference}Sample.rgb, ${reference}Sample.a`,
        ] as any;
    },
    HUE_SAT(
        Hue: GLSL['float'],
        Saturation: GLSL['float'],
        Value: GLSL['float'],
        Factor: GLSL['float'],
        Color: GLSL['vec4'],
        node: Node,
        compilationCache: CompilationCache
    ): GLSL['vec4'] {
        const reference = camelCase(node.id);

        addBlenderDependency(hue_sat_val, compilationCache);

        return [
            `vec4 ${reference}Color = vec4(0.);`,
            `hue_sat(${Hue}, ${Saturation}, ${Value}, ${Factor}, ${Color}, ${reference}Color);`,
            `${reference}Color`,
        ];
    },
    FILTER(
        Image: GLSL['vec4'],
        Factor: GLSL['float'],
        Type: string & KernelType,
        compilationCache: CompilationCache
    ): GLSL['vec4'] {
        const [include, filterFnReference] = filterGLSL(Type);
        addContextualShaderInclude(compilationCache, include);

        // TODO encode sampler into Image/Color types to be carried
        // and add GLSL['sampler2D'] as a type that can reach for sampler vs sampled image data
        return [`${filterFnReference}(tDiffuse, ${Factor}, vUv)`];
    },
    // TODO figure out how to respect passthrough type here
    SWITCH(
        Switch: GLSL['bool'],
        Off: GLSL['vec4'],
        On: GLSL['vec4']
    ): GLSL['vec4'] {
        if (Switch === 'true') {
            return [`${On}`];
        } else if (Switch === 'false') {
            return [`${Off}`];
        }

        return [`(${Switch}) ? ${On} : ${Off}`];
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
        Vector: GLSL['vec3'] = 'vec3(vUv, 1.0)',
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
    ): GLSL<{ Factor: GLSL['float']; Color: GLSL['vec4'] }> {
        const reference = camelCase(node.id);

        // compilationCache.shader.fragmentIncludes.add(shaderIncludes.noise);
        addBlenderDependency(noise, compilationCache);

        return [
            `float ${reference}Factor = 0.0;`,
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
                    ${reference}Factor,
                    ${reference}Color
            );`,
            `${reference}Factor, ${reference}Color`,
        ] as any;
    },
    VECTOR_ROTATE(
        Vector: GLSL['vec3'],
        Angle: GLSL['float'],
        Axis: GLSL['vec3'] = 'vec3(0.)',
        Center: GLSL['vec3'] = 'vec3(0.)',
        invert: boolean,
        rotation_type: string,
        compilationCache: CompilationCache
    ): GLSL['vec3'] {
        addContextualShaderInclude(compilationCache, blenderVector);
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
        addContextualShaderInclude(
            compilationCache,
            shaderIncludes.mappingNode
        );

        return [`mappingNode(${Vector}, ${Location}, ${Rotation}, ${Scale})`];
    },
    /** color ramp */
    VALTORGB(
        Factor: GLSL['float'],
        elements: ColorStop[],
        color_mode: InterpolationType,
        interpolation: string,
        node: Node,
        compilationCache: CompilationCache
    ): GLSL['vec4'] {
        const reference = 'colorRampCompositeLUT';

        const colorRampCanvas = createColorRampLUT(
            elements,
            InterpolationType[interpolation]
        );

        const compositeTexture = getCompositeTexture(
            reference,
            257,
            1,
            compilationCache
        );

        const compositeReference = compositeTexture.add(colorRampCanvas);

        compilationCache.uniforms[reference] = {
            value: compositeReference.texture,
        };
        addContextualShaderInclude(
            compilationCache,
            `uniform sampler2D ${reference};`
        );
        addContextualShaderInclude(compilationCache, shaderIncludes.colorRamp);

        // console.log('[ColorRamp] compile', ...arguments);
        return [
            `texture2D(${reference}, vec2(compute_color_map_coordinate(clamp(${Factor}, 0.0, 1.0)), ${compositeReference.uv.y}))`,
        ];
    },
    EMISSION(Color: GLSL['vec3'], Strength: GLSL['float']): GLSL['vec3'] {
        return [`${Color} * ${Strength}`];
    },
    BSDF_TRANSPARENT(Color: GLSL['vec3']): GLSL['vec4'] {
        return [`vec4(0.,0.,0.,1. - clamp(length(${Color}), 0., 1.))`];
    },
    HOLDOUT(): GLSL['vec4'] {
        return [`vec4(0.,0.,0.,0.)`];
    },
    BSDF_DIFFUSE(
        Color: GLSL['vec3'],
        Normal: GLSL['vec3'] = 'normalize(vNormal)',
        compilationCache: CompilationCache
    ): GLSL['vec3'] {
        addDiffuseBSDF(compilationCache);

        return [
            `DiffuseBSDF(${Color}, ${Normal}, 0.0, 0.0, vec3(0.0), 0.0, vec3(0.0))`,
        ];
    },
    EEVEE_SPECULAR(
        BaseColor: GLSL['vec3'],
        Roughness: GLSL['float'],
        Specular: GLSL['vec3'],
        EmissiveColor: GLSL['vec3'],
        Normal: GLSL['vec3'] = 'normalize(vNormal)', // TODO for displaced... 'normalize( cross( dFdx( vViewPosition ), dFdy( vViewPosition ) ) )',
        Transparency: GLSL['float'],
        compilationCache: CompilationCache
    ): GLSL['vec4'] {
        addDiffuseBSDF(compilationCache);

        return [
            `vec4(DiffuseBSDF(${BaseColor}, ${
                Normal.includes('v') ? Normal : 'normalMatrix * ' + Normal
            }, ${Roughness}, 0.0, ${Specular}, 1.0, ${EmissiveColor}), 1.0 - ${Transparency})`,
        ];
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
    LAYER_WEIGHT(
        Blend: GLSL['float'],
        Normal: GLSL['vec3'] = 'vNormal',
        node: Node,
        compilationCache: CompilationCache
    ): GLSL<{
        Fresnel: GLSL['float'];
        Facing: GLSL['float'];
    }> {
        const reference = camelCase(node.id);
        addBlenderDependency(
            gpu_shader_material_layer_weight,
            compilationCache
        );
        return [
            `float ${reference}Fresnel = 0.0;`,
            `float ${reference}Facing = 0.0;`,
            `node_layer_weight(${Blend}, ${Normal}, ${reference}Fresnel, ${reference}Facing);`,
            `${reference}Fresnel, ${reference}Facing`,
        ] as any;
    },
    SHADERTORGB(Shader: GLSL['vec4']): GLSL['vec4'] {
        return [Shader];
    },
    OUTPUT_MATERIAL: {
        displacement: function (
            Displacement: GLSL['vec3'] = null
        ): string[] & VertexShader<'displacement'> {
            if (Displacement) {
                return [`transformed += ${Displacement}`];
            }

            return [];
        },
        fragment: function (Surface: GLSL['vec4']) {
            return [`pc_FragColor = ${Surface}`];
        },
    },
    // Render Layers node for compositor input
    R_LAYERS(
        compilationCache: CompilationCache,
        ...args: Array<GLSL['vec3'] | GLSL['vec4']>
    ): GLSL<{
        Image: GLSL['vec4'];
        Alpha: GLSL['float'];
    }> {
        compilationCache.uniforms.tDiffuse = { value: null };
        return [
            `vec4 tDiffuseSample = texture2D(tDiffuse, vUv);`,
            `tDiffuseSample, tDiffuseSample.a`,
        ] as any;
    },

    CompositorNodeImageCoordinates(
        Image: GLSL['vec4']
    ): GLSL<{ Normalized: GLSL['vec2']; Uniform: GLSL['vec2'] }> {
        // const float2 centered_coordinates = (float2(texel) + 0.5f) - float2(size) / 2.0f;

        // const int max_size = max(size.x, size.y);
        // const float2 normalized_coordinates = (centered_coordinates / max_size) * 2.0f;

        // TODO support picking up texture reference from Image input instead of hard coding Image
        return [
            `vec2 size = vec2(textureSize(tDiffuse, 0));`,
            `vec2 centered_coordinates = (vUv - .5) * size;`,
            `float aspectRatio = size.x / size.y;
            float max_size = max(size.x, size.y);
                
            centered_coordinates *= aspectRatio;`,
            `vUv, (centered_coordinates / max_size) * 2.0`,
        ] as any;
    },
    CompositorNodeImageInfo(Image: GLSL['vec4']): GLSL<{
        Dimensions: GLSL['vec2'];
    }> {
        // TODO extract texture reference from Image
        return [`vec2(textureSize(tDiffuse, 0))`] as any;
    },
    GROUP_OUTPUT(
        compilationCache: CompilationCache,
        Image: GLSL['vec4'],
        ...args: any[]
    ) {
        if (compilationCache.treeType === 'composition') {
            return [`pc_FragColor = ${Image}`];
        }
        // if (Image) args.unshift(Image);
        return [`return $structReference(${args.join(', ')})`];
    },
    MIX_SHADER(Factor: GLSL['float'], Shader: GLSL['vec4'][]): GLSL['vec4'] {
        return [`mix(${Shader[0]}, ${Shader[1]}, ${Factor})`];
    },
    COMBXYZ(
        // TODO figure out why making this a float causes average and +'.z'
        X: GLSL['float'],
        Y: GLSL['float'],
        Z: GLSL['float'],
        compilationCache: CompilationCache
    ): GLSL['vec3'] {
        // TODO maybe leverage compilationCache.shader.currentVectorSpace?
        // const { currentVectorSpace } = compilationCache.shader;
        // if (currentVectorSpace !== 'UV' && currentVectorSpace !== 'PRESERVE') {
        //     return [`vec3(${X}, ${Z}, ${Y})`];
        // }
        return [`vec3(${X}, ${Y}, ${Z})`];
    },
    COMBINE_COLOR(
        Red: GLSL['float'],
        Green: GLSL['float'],
        Blue: GLSL['float'],
        Alpha: GLSL['float'] = '1.0',
        mode: 'HSL' | 'HSV' | 'RGB',
        node: Node,
        compilationCache: CompilationCache
    ): GLSL['vec4'] {
        const reference = camelCase(node.id);

        addBlenderDependency(gpu_shader_common_color_utils, compilationCache);

        switch (mode) {
            case 'RGB':
                return [`vec4(${Red}, ${Green}, ${Blue}, ${Alpha});`];
            case 'HSV':
                return [
                    `vec4 ${reference}Col = vec4(0.);`,
                    `hsv_to_rgb(vec4(${Red}, ${Green}, ${Blue}, ${Alpha}), ${reference}Col);`,
                    `${reference}Col`,
                ];
            case 'HSL':
                return [
                    `vec4 ${reference}Col = vec4(0.);`,
                    `hsl_to_rgb(vec4(${Red}, ${Green}, ${Blue}, ${Alpha}), ${reference}Col);`,
                    `${reference}Col`,
                ];
        }
    },
    SEPARATE_COLOR(
        Image: GLSL['vec4'],
        mode: 'HSL' | 'HSV' | 'RGB',
        node: Node,
        compilationCache: CompilationCache
    ): GLSL<{
        Red: GLSL['float'];
        Green: GLSL['float'];
        Blue: GLSL['float'];
        Alpha: GLSL['float'];
    }> {
        const reference = camelCase(node.id);

        addBlenderDependency(gpu_shader_common_color_utils, compilationCache);

        switch (mode) {
            case 'RGB':
                return [
                    `${Image}.r, ${Image}.g, ${Image}.b, ${Image}.a`,
                ] as any;
            case 'HSV':
                return [
                    `vec4 ${reference}Col = vec4(0.);`,
                    `rgb_to_hsv(${Image}, ${reference}Col);`,
                    `${reference}Col[0], ${reference}Col[1], ${reference}Col[2], ${reference}Col[3]`,
                ] as any;
            case 'HSL':
                return [
                    `vec4 ${reference}Col = vec4(0.);`,
                    `rgb_to_hsl(${Image}, ${reference}Col);`,
                    `${reference}Col[0], ${reference}Col[1], ${reference}Col[2], ${reference}Col[3]`,
                ] as any;
        }
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

        return ['vec2(vUv.x, 1.0 - vUv.y)'];
    },
    TEX_COORD(compilationCache: CompilationCache): GLSL<{
        Generated: GLSL['vec3'];
        UV: GLSL['vec2'];
        Normal: GLSL['vec3'];
        Object: GLSL['vec3'];
        Reflection: GLSL['vec3'];
    }> {
        compilationCache.defines.add('USE_OBJECT_NORMAL');
        compilationCache.defines?.add('USE_UV');
        compilationCache.defines.add('USE_ALPHAHASH');

        // TODO support and generate Generated uvs by bounding box, detect generated slot is used via node parameter

        const compilationTarget = compilationCache.compiledInputs.current;
        if (
            compilationTarget === shaderTargetInputs.Vertex ||
            compilationTarget === shaderTargetInputs.Displacement
        ) {
            // TODO evaluate if objectNormal would be more appropriate in place of vNormal for displacement target
            return [
                'position, vec2(uv.x, uv.y), vNormal, position, reflect(normalize(vViewPosition), normalize(vNormal))',
            ] as any;
        }

        return [
            'vPosition, vec2(vUv.x, vUv.y), vNormal, vPosition, reflect(normalize(vViewPosition), normalize(vNormal))',
        ] as any;
    },
    NEW_GEOMETRY(compilationCache: CompilationCache): GLSL<{
        Position: GLSL['vec3'];
        Normal: GLSL['vec3'];
        Backfacing: GLSL['float'];
    }> {
        compilationCache.defines.add('USE_GEOMETRY');
        const compilationTarget = compilationCache.compiledInputs.current;
        return [
            `vWorldPosition, vWorldNormal, ${
                compilationTarget === shaderTargetInputs.Fragment
                    ? 'gl_FrontFacing ? 0.0 : 1.0'
                    : '0.0'
            }`,
        ] as any;
    },
    VECT_MATH(
        operation: string,
        Scale: GLSL['float'] = 1,
        Vector: GLSL['vec3'][]
    ): If<
        'operation',
        {
            DOT_PRODUCT: GLSL['float'];
            LENGTH: GLSL['float'];
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
        FromMin: If<
            'data_type',
            { FLOAT: GLSL['float']; FLOAT_VECTOR: GLSL['vec3'] }
        >,
        FromMax: If<
            'data_type',
            { FLOAT: GLSL['float']; FLOAT_VECTOR: GLSL['vec3'] }
        >,
        ToMin: If<
            'data_type',
            { FLOAT: GLSL['float']; FLOAT_VECTOR: GLSL['vec3'] }
        >,
        ToMax: If<
            'data_type',
            { FLOAT: GLSL['float']; FLOAT_VECTOR: GLSL['vec3'] }
        >,
        // TODO
        interpolation_type: string,
        compilationCache: CompilationCache
    ): If<'data_type', { FLOAT: GLSL['float']; FLOAT_VECTOR: GLSL['vec3'] }> {
        addContextualShaderInclude(compilationCache, shaderIncludes.mapRange);

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
        data_type: 'FLOAT' | 'VECTOR' | 'RGBA',
        Factor: GLSL['float'],
        A: If<
            'data_type',
            {
                FLOAT: GLSL['float'];
                RGBA: GLSL['vec4'];
                VECTOR: GLSL['vec3'];
            }
        >,
        B: If<
            'data_type',
            {
                FLOAT: GLSL['float'];
                RGBA: GLSL['vec4'];
                VECTOR: GLSL['vec3'];
            }
        >,
        blend_type: string,
        factor_mode: string,
        clamp_factor: boolean,
        clamp_result: boolean,
        compilationCache: CompilationCache
    ): PartialSupport &
        If<
            'data_type',
            {
                FLOAT: GLSL['float'];
                RGBA: GLSL['vec4'];
                VECTOR: GLSL['vec3'];
            }
        > {
        if (data_type === 'RGBA') {
            addBlenderDependency(gpu_shader_common_mix_rgb, compilationCache);

            let fn = `mix_${blend_type.toLowerCase()}`;
            if (blend_type in mixFunctions.RGBA) {
                fn = mixFunctions.RGBA[blend_type];
            }

            return [`${fn}(${Factor}, ${A}, ${B})`];
        }

        return [`mix(${A}, ${B}, ${Factor})`];
    },
    MATH(
        operation: string,
        use_clamp: boolean,
        Value: GLSL['float'][]
    ): If<
        'operation',
        {
            GREATER_THAN: GLSL['bool'];
            LESS_THAN: GLSL['bool'];
            else: GLSL['float'];
        }
    > {
        let result: string = `MATH_ERROR_${operation}`;
        if (operation in mathOperationSymbols) {
            result = `${Value[0]} ${mathOperationSymbols[operation]} ${Value[1]}`;
        } else if (operation in mathFunctions) {
            result = mathFunctions[operation]
                .replace(/\$1/g, Value instanceof Array ? Value[0] : Value)
                .replace(/\$2/g, Value[1])
                .replace(/\$3/g, Value[2]);
        }

        if (use_clamp) result = `clamp(${result}, 0., 1.)`;

        return [result];
    },

    DISPLACEMENT(
        Height: GLSL['float'],
        Midlevel: GLSL['float'],
        Scale: GLSL['float'],
        Normal: GLSL['vec3'] = 'objectNormal'
    ): GLSL['vec3'] {
        return [
            `((${Height} - ${Midlevel}) * ${Scale}) * normalize(${Normal})`,
        ];
    },

    'Set Depth'(
        Depth: GLSL['float'],
        DepthScale: GLSL['float'],
        compilationCache: CompilationCache
    ) {
        addContextualShaderInclude(
            compilationCache,
            'uniform sampler2D depthTexture;'
        );
        compilationCache.uniforms.depthTexture = depthUniform;

        addContextualShaderInclude(
            compilationCache,
            'uniform vec2 resolution;'
        );
        compilationCache.uniforms.resolution = resolutionUniform;

        addContextualShaderInclude(
            compilationCache,
            glsl`uniform float cameraFar;
            uniform float cameraNear;`
        );
        compilationCache.uniforms.cameraNear = cameraNearUniform;
        compilationCache.uniforms.cameraFar = cameraFarUniform;

        addContextualShaderInclude(
            compilationCache,
            glsl`
            float normalizedToViewDepth(float ndcDepth) {
                return (2.0 * cameraNear * cameraFar) / (cameraFar + cameraNear - (2.0 * ndcDepth - 1.0) * (cameraFar- cameraNear));
            }
        `
        );

        return [
            glsl`
            vec2 sUv=gl_FragCoord.xy / resolution;
            vec4 sampledDepth = texture2D(depthTexture, sUv);
            float sceneDepth = unpackRGBAToDepth(sampledDepth);

            float fragDepth = gl_FragCoord.z - (1.0 - ${Depth}) *.0045;

            float tolerance = 0.0;
            float depthDiff = (sceneDepth + tolerance) - fragDepth;

            if (depthDiff < 0.0) {
                discard;
                return;
            }
            // if (pc_FragColor.a > .1) {
            // pc_FragColor.rgb = vec3(fragDepth);
            // }
            `,
        ];

        return [`fragCoordZ = ${Depth} * ${DepthScale}`];
    },

    'Per Vertex: Vector': {
        vertex(
            Vector: GLSL['vec3'],
            node: Node,
            compilationCache: CompilationCache
        ): GLSL['vec3'] & VertexShader {
            const reference = getReference(
                'v' + node.id[0].toUpperCase() + node.id.substring(1)
            );

            compilationCache.shader.vertexIncludes.add(
                `varying vec3 ${reference};`
            );
            compilationCache.shader.fragmentIncludes.add(
                `varying vec3 ${reference};`
            );

            return [`${reference} = ${Vector}`];
        },
        fragment(node: Node): GLSL['vec3'] {
            const reference = getReference(
                'v' + node.id[0].toUpperCase() + node.id.substring(1)
            );

            return [reference];
        },
    },
};
