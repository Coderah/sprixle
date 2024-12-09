import { ReflectionClass } from '@deepkit/type';
import {
    createNodeTreeCompiler,
    NodeTree,
} from '../plugins/nodeTrees/createCompiler';
import {
    AgXToneMapping,
    CanvasTexture,
    ColorManagement,
    DoubleSide,
    FloatType,
    HalfFloatType,
    LinearFilter,
    Mesh,
    MeshBasicMaterial,
    OrthographicCamera,
    PlaneGeometry,
    RenderTargetOptions,
    RGBAFormat,
    Scene,
    ShaderMaterial,
    SRGBColorSpace,
    WebGLRenderer,
    WebGLRenderTarget,
} from 'three';
import { glsl } from '../shader/util';
import { EffectComposer, RenderPass } from 'three-stdlib';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass';
import { now } from '../util/now';

const colorRampTest: NodeTree = {
    'Material Output': {
        id: 'Material Output',
        type: 'OUTPUT_MATERIAL',
        name: 'OUTPUT_MATERIAL',
        inputs: {
            Surface: {
                type: 'linked',
                links: [
                    {
                        node: 'Mix.001',
                        socket: 'Result',
                    },
                ],
            },
            Volume: {
                value: null,
                type: 'SHADER',
            },
            Displacement: {
                value: [0.0, 0.0, 0.0],
                type: 'VECTOR',
            },
            Thickness: {
                value: 0.0,
                type: 'VALUE',
            },
        },
        outputs: {},
        properties: {
            is_active_output: true,
            target: 'ALL',
        },
    },
    'Color Ramp': {
        id: 'Color Ramp',
        type: 'VALTORGB',
        name: 'VALTORGB',
        inputs: {
            Fac: {
                type: 'linked',
                links: [
                    {
                        node: 'Reroute.003',
                        socket: 'Output',
                    },
                ],
            },
        },
        outputs: {
            Color: {
                type: 'linked',
                links: [
                    {
                        node: 'Mix.001',
                        socket: 'A',
                    },
                ],
            },
            Alpha: 0.0,
        },
        properties: {
            elements: [
                {
                    position: 0.5490908026695251,
                    color: [0.0, 0.0, 0.0, 1.0],
                },
                {
                    position: 1.0,
                    color: [1.0, 0.0018079797737300396, 0.0, 1.0],
                },
            ],
            color_mode: 'RGB',
            interpolation: 'LINEAR',
            hue_interpolation: 'NEAR',
        },
    },
    'Texture Coordinate': {
        id: 'Texture Coordinate',
        type: 'TEX_COORD',
        name: 'TEX_COORD',
        inputs: {},
        outputs: {
            Generated: null,
            Normal: null,
            UV: {
                type: 'linked',
                links: [
                    {
                        node: 'Mapping',
                        socket: 'Vector',
                    },
                    {
                        node: 'Separate XYZ.001',
                        socket: 'Vector',
                    },
                ],
            },
            Object: null,
            Camera: null,
            Window: null,
            Reflection: null,
        },
        properties: {
            from_instancer: false,
        },
    },
    'Color Ramp.001': {
        id: 'Color Ramp.001',
        type: 'VALTORGB',
        name: 'VALTORGB',
        inputs: {
            Fac: {
                type: 'linked',
                links: [
                    {
                        node: 'Reroute.003',
                        socket: 'Output',
                    },
                ],
            },
        },
        outputs: {
            Color: {
                type: 'linked',
                links: [
                    {
                        node: 'Mix.001',
                        socket: 'B',
                    },
                ],
            },
            Alpha: 0.0,
        },
        properties: {
            elements: [
                {
                    position: 0.29100000858306885,
                    color: [0.0, 0.0, 0.0, 1.0],
                },
                {
                    position: 1.0,
                    color: [1.0, 1.0, 1.0, 1.0],
                },
            ],
            color_mode: 'RGB',
            interpolation: 'LINEAR',
            hue_interpolation: 'NEAR',
        },
    },
    'Mix.001': {
        id: 'Mix.001',
        type: 'MIX',
        name: 'MIX',
        inputs: {
            Factor: {
                type: 'linked',
                links: [
                    {
                        node: 'Map Range',
                        socket: 'Result',
                    },
                ],
            },
            A: {
                type: 'linked',
                links: [
                    {
                        node: 'Color Ramp',
                        socket: 'Color',
                    },
                ],
            },
            B: {
                type: 'linked',
                links: [
                    {
                        node: 'Color Ramp.001',
                        socket: 'Color',
                    },
                ],
            },
        },
        outputs: {
            Result: [0.0, 0.0, 0.0],
        },
        properties: {
            data_type: 'RGBA',
            factor_mode: 'UNIFORM',
            blend_type: 'MIX',
            clamp_factor: true,
            clamp_result: false,
        },
    },
    'Math.001': {
        id: 'Math.001',
        type: 'MATH',
        name: 'MATH',
        inputs: {
            Value: {
                type: 'linked',
                links: [
                    {
                        node: 'Math.002',
                        socket: 'Value',
                    },
                ],
            },
        },
        outputs: {
            Value: {
                type: 'linked',
                links: [
                    {
                        node: 'Map Range',
                        socket: 'Value',
                    },
                ],
            },
        },
        properties: {
            operation: 'SINE',
            use_clamp: false,
        },
    },
    'Map Range': {
        id: 'Map Range',
        type: 'MAP_RANGE',
        name: 'MAP_RANGE',
        inputs: {
            Value: {
                type: 'linked',
                links: [
                    {
                        node: 'Math.001',
                        socket: 'Value',
                    },
                ],
            },
            'From Min': {
                value: -1.0,
                type: 'VALUE',
            },
            'From Max': {
                value: 1.0,
                type: 'VALUE',
            },
            'To Min': {
                value: 0.0,
                type: 'VALUE',
            },
            'To Max': {
                value: 1.0,
                type: 'VALUE',
            },
        },
        outputs: {
            Result: {
                type: 'linked',
                links: [
                    {
                        node: 'Mix.001',
                        socket: 'Factor',
                    },
                ],
            },
            Vector: null,
        },
        properties: {
            clamp: true,
            interpolation_type: 'LINEAR',
            data_type: 'FLOAT',
        },
    },
    Group: {
        id: 'Group',
        type: 'GROUP',
        name: 'Time',
        inputs: {},
        outputs: {
            Seconds: {
                type: 'linked',
                links: [
                    {
                        node: 'Math.005',
                        socket: 'Value',
                    },
                    {
                        node: 'Reroute',
                        socket: 'Input',
                    },
                ],
            },
        },
        properties: {
            containsLogicTree: true,
        },
        internalLogicTree: {
            'Group Output': {
                id: 'Group Output',
                type: 'GROUP_OUTPUT',
                name: 'GROUP_OUTPUT',
                inputs: {
                    Seconds: {
                        type: 'linked',
                        links: [
                            {
                                node: 'Math.002',
                                socket: 'Value',
                            },
                        ],
                    },
                    '': {
                        value: null,
                        type: 'CUSTOM',
                    },
                },
                outputs: {},
                properties: {
                    is_active_output: true,
                },
            },
            'Group Input': {
                id: 'Group Input',
                type: 'GROUP_INPUT',
                name: 'GROUP_INPUT',
                inputs: {},
                outputs: {
                    '': null,
                },
                properties: {},
            },
            Value: {
                id: 'Value',
                type: 'VALUE',
                name: 'VALUE',
                inputs: {},
                outputs: {
                    Value: {
                        type: 'linked',
                        links: [
                            {
                                node: 'Math.002',
                                socket: 'Value',
                            },
                        ],
                    },
                },
                properties: {
                    drivers: [
                        {
                            socket: 'Value',
                            expression: 'frame',
                        },
                    ],
                    value: 45.0,
                },
            },
            'Math.002': {
                id: 'Math.002',
                type: 'MATH',
                name: 'MATH',
                inputs: {
                    Value: [
                        {
                            type: 'linked',
                            links: [
                                {
                                    node: 'Value',
                                    socket: 'Value',
                                },
                            ],
                        },
                        {
                            value: 60.0,
                            type: 'VALUE',
                        },
                    ],
                },
                outputs: {
                    Value: {
                        type: 'linked',
                        links: [
                            {
                                node: 'Group Output',
                                socket: 'Seconds',
                            },
                        ],
                    },
                },
                properties: {
                    operation: 'DIVIDE',
                    use_clamp: false,
                    drivers: [
                        {
                            socket: 'Value',
                            expression: 'bpy.context.scene.render.fps',
                        },
                    ],
                },
            },
        },
    },
    'Math.002': {
        id: 'Math.002',
        type: 'MATH',
        name: 'MATH',
        inputs: {
            Value: [
                {
                    type: 'linked',
                    links: [
                        {
                            node: 'Reroute',
                            socket: 'Output',
                        },
                    ],
                },
                {
                    value: 3.0,
                    type: 'VALUE',
                },
            ],
        },
        outputs: {
            Value: {
                type: 'linked',
                links: [
                    {
                        node: 'Math.001',
                        socket: 'Value',
                    },
                ],
            },
        },
        properties: {
            operation: 'MULTIPLY',
            use_clamp: false,
        },
    },
    Mapping: {
        id: 'Mapping',
        type: 'MAPPING',
        name: 'MAPPING',
        inputs: {
            Vector: {
                type: 'linked',
                links: [
                    {
                        node: 'Texture Coordinate',
                        socket: 'UV',
                    },
                ],
            },
            Location: {
                type: 'linked',
                links: [
                    {
                        node: 'Combine XYZ',
                        socket: 'Vector',
                    },
                ],
            },
            Rotation: {
                value: [0.0, 1.0157816410064697, 0.0],
                type: 'VECTOR',
            },
            Scale: {
                value: [1.0, 1.0, 1.0],
                type: 'VECTOR',
            },
        },
        outputs: {
            Vector: {
                type: 'linked',
                links: [
                    {
                        node: 'Noise Texture',
                        socket: 'Vector',
                    },
                ],
            },
        },
        properties: {
            vector_type: 'POINT',
        },
    },
    'Noise Texture': {
        id: 'Noise Texture',
        type: 'TEX_NOISE',
        name: 'TEX_NOISE',
        inputs: {
            Vector: {
                type: 'linked',
                links: [
                    {
                        node: 'Mapping',
                        socket: 'Vector',
                    },
                ],
            },
            Scale: {
                value: 0.7,
                type: 'VALUE',
            },
            Detail: {
                value: 2.2,
                type: 'VALUE',
            },
            Roughness: {
                value: 1.0,
                type: 'VALUE',
            },
            Lacunarity: {
                value: 2.0,
                type: 'VALUE',
            },
            Distortion: {
                value: 0.0,
                type: 'VALUE',
            },
        },
        outputs: {
            Fac: {
                type: 'linked',
                links: [
                    {
                        node: 'Reroute.003',
                        socket: 'Input',
                    },
                ],
            },
            Color: null,
        },
        properties: {
            noise_dimensions: '2D',
            noise_type: 'FBM',
            normalize: false,
        },
    },
    'Reroute.003': {
        id: 'Reroute.003',
        type: 'REROUTE',
        name: 'REROUTE',
        inputs: {
            Input: {
                type: 'linked',
                links: [
                    {
                        node: 'Noise Texture',
                        socket: 'Fac',
                    },
                ],
            },
        },
        outputs: {
            Output: {
                type: 'linked',
                links: [
                    {
                        node: 'Color Ramp.001',
                        socket: 'Fac',
                    },
                    {
                        node: 'Color Ramp',
                        socket: 'Fac',
                    },
                ],
            },
        },
        properties: {
            socket_idname: 'NodeSocketFloat',
        },
    },
    'Math.005': {
        id: 'Math.005',
        type: 'MATH',
        name: 'MATH',
        inputs: {
            Value: [
                {
                    type: 'linked',
                    links: [
                        {
                            node: 'Group',
                            socket: 'Seconds',
                        },
                    ],
                },
                {
                    value: 0.2,
                    type: 'VALUE',
                },
            ],
        },
        outputs: {
            Value: {
                type: 'linked',
                links: [
                    {
                        node: 'Math.006',
                        socket: 'Value',
                    },
                ],
            },
        },
        properties: {
            operation: 'MULTIPLY',
            use_clamp: false,
        },
    },
    'Combine XYZ': {
        id: 'Combine XYZ',
        type: 'COMBXYZ',
        name: 'COMBXYZ',
        inputs: {
            X: {
                type: 'linked',
                links: [
                    {
                        node: 'Math.006',
                        socket: 'Value',
                    },
                ],
            },
            Y: {
                type: 'linked',
                links: [
                    {
                        node: 'Separate XYZ.001',
                        socket: 'Y',
                    },
                ],
            },
            Z: {
                value: 0.0,
                type: 'VALUE',
            },
        },
        outputs: {
            Vector: {
                type: 'linked',
                links: [
                    {
                        node: 'Mapping',
                        socket: 'Location',
                    },
                ],
            },
        },
        properties: {},
    },
    'Separate XYZ.001': {
        id: 'Separate XYZ.001',
        type: 'SEPXYZ',
        name: 'SEPXYZ',
        inputs: {
            Vector: {
                type: 'linked',
                links: [
                    {
                        node: 'Texture Coordinate',
                        socket: 'UV',
                    },
                ],
            },
        },
        outputs: {
            X: {
                type: 'linked',
                links: [
                    {
                        node: 'Math.006',
                        socket: 'Value',
                    },
                ],
            },
            Y: {
                type: 'linked',
                links: [
                    {
                        node: 'Combine XYZ',
                        socket: 'Y',
                    },
                ],
            },
            Z: 0.0,
        },
        properties: {},
    },
    'Math.006': {
        id: 'Math.006',
        type: 'MATH',
        name: 'MATH',
        inputs: {
            Value: [
                {
                    type: 'linked',
                    links: [
                        {
                            node: 'Math.005',
                            socket: 'Value',
                        },
                    ],
                },
                {
                    type: 'linked',
                    links: [
                        {
                            node: 'Separate XYZ.001',
                            socket: 'X',
                        },
                    ],
                },
            ],
        },
        outputs: {
            Value: {
                type: 'linked',
                links: [
                    {
                        node: 'Combine XYZ',
                        socket: 'X',
                    },
                ],
            },
        },
        properties: {
            operation: 'ADD',
            use_clamp: false,
        },
    },
    Reroute: {
        id: 'Reroute',
        type: 'REROUTE',
        name: 'REROUTE',
        inputs: {
            Input: {
                type: 'linked',
                links: [
                    {
                        node: 'Group',
                        socket: 'Seconds',
                    },
                ],
            },
        },
        outputs: {
            Output: {
                type: 'linked',
                links: [
                    {
                        node: 'Math.002',
                        socket: 'Value',
                    },
                ],
            },
        },
        properties: {
            socket_idname: 'NodeSocketFloat',
        },
    },
};

// console.log(treeTest);

/* TODO internally we need to
    identify and track uniforms
    identify and track includes
    work out how to base things on existing material nodes?
        maybe this is done by including the original shader with main renamed and using it as a fn?
    handle the "no shadows" light path trick...
    decide how to handle noise nodes
    swap priority of internal nodes to favor code implementation
    hamdle image texture nodes...
    mix nodes will need to handle varying vector sizes?
    minify / prettify (dev mode) output?
*/
const compileShaderTree = createNodeTreeCompiler({
    type: 'ShaderTree',
});

const transpiledShader = compileShaderTree(colorRampTest);
console.log(transpiledShader);

ColorManagement.enabled = true;
const renderer = new WebGLRenderer({
    precision: 'highp',
});
renderer.toneMapping = AgXToneMapping;
renderer.toneMappingExposure = 1;
renderer.outputColorSpace = SRGBColorSpace;
renderer.setSize(256, 256);

const plane = new Mesh(
    new PlaneGeometry(4, 4),
    // new MeshBasicMaterial({
    //     color: 'red',
    // })
    new ShaderMaterial({
        side: DoubleSide,
        transparent: true,
        uniforms: transpiledShader.compilationCache.uniforms,
        vertexShader: glsl`
varying vec2 vUv;

void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.);
}
    `,

        fragmentShader: glsl`
varying vec2 vUv;
${Array.from(transpiledShader.compilationCache.defines).join('\n')}
${Array.from(transpiledShader.compilationCache.shaderIncludes.fragment).join(
    '\n'
)}

void main() {
    ${Object.values(transpiledShader.compilationCache.compiledInputs).join(
        '\n'
    )}
    ${transpiledShader.transpiled.join('\n')}
}
    `,
    })
);
plane.rotateX(-Math.PI / 2);
plane.rotateY(Math.PI);
console.log(plane.material.vertexShader);
console.log(plane.material.fragmentShader);

const scene = new Scene();
scene.add(plane);

const camera = new OrthographicCamera(2, -2, 2, -2, -1, 1000);
camera.position.set(0, 3, 0);
camera.lookAt(0, 0, 0);
scene.add(camera);

export const rendererContext = renderer.getContext() as WebGLRenderingContext;
export const canRenderToFloatType =
    rendererContext.getExtension('EXT_float_blend') &&
    rendererContext.getExtension('OES_texture_float_linear');

const parameters: RenderTargetOptions = {
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    format: RGBAFormat,
    type: canRenderToFloatType ? FloatType : HalfFloatType,
};

const renderTarget = new WebGLRenderTarget(256, 256, parameters);

renderer.initRenderTarget(renderTarget);

const composer = new EffectComposer(renderer, renderTarget);

composer.addPass(new RenderPass(scene, camera));
composer.addPass(new OutputPass());

window['transpiledShader'] = transpiledShader;

let time = Date.now();

function tick() {
    const newTime = Date.now();
    const delta = newTime - time;
    const deltaSeconds = delta / 1000;
    time = newTime;

    transpiledShader.compilationCache.uniforms.time.value += deltaSeconds;

    composer.render();

    requestAnimationFrame(tick);
}
// composer.render();
document.body.append(renderer.domElement);

if (transpiledShader.compilationCache.uniforms) {
    const uniformsElement = document.createElement('div');
    uniformsElement.style.display = 'inline-grid';
    uniformsElement.style.width = 'auto';
    uniformsElement.style.gridTemplateColumns = 'auto auto';
    uniformsElement.style.marginTop = '6px';
    uniformsElement.style.columnGap = uniformsElement.style.rowGap = '6px';
    uniformsElement.style.color = 'white';

    for (let key of Object.keys(transpiledShader.compilationCache.uniforms)) {
        const uniform = transpiledShader.compilationCache.uniforms[key];
        if (uniform.value instanceof CanvasTexture) {
            const canvas = uniform.value.source.data;
            if (canvas.height === 1) {
                canvas.style.width = '128px';
                canvas.style.height = '16px';
            } else {
                canvas.style.maxWidth = '256px';
            }
            canvas.style.aspectRatio = 'unset';
            uniformsElement.append(canvas);
            uniformsElement.append(key);
        }
    }

    document.body.append(uniformsElement);
}

tick();
