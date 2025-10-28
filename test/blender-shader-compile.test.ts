import * as Stats from 'stats.js';
import {
    AgXToneMapping,
    AmbientLight,
    BufferAttribute,
    BufferGeometry,
    CanvasTexture,
    Color,
    ColorManagement,
    DoubleSide,
    FloatType,
    HalfFloatType,
    InstancedBufferAttribute,
    InstancedMesh,
    LinearFilter,
    Mesh,
    MeshLambertMaterial,
    MeshPhongMaterial,
    NoToneMapping,
    PerspectiveCamera,
    Points,
    ReinhardToneMapping,
    RenderTargetOptions,
    RGBAFormat,
    Scene,
    ShaderMaterial,
    SRGBColorSpace,
    TextureLoader,
    Vector2,
    WebGLRenderer,
    WebGLRenderTarget,
} from 'three';
import {
    EffectComposer,
    GLTFLoader,
    OrbitControls,
    RenderPass,
    Sky,
} from 'three-stdlib';
// import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import {
    createNodeTreeCompiler,
    NodeTree,
} from '../plugins/nodeTrees/createCompiler';
import blenderNoise from '../plugins/nodeTrees/shader/blender/noise';
import { getFeaturesFromName } from '../util/blender';
import { interval } from '../util/timing';
import { uniformTime } from '../render/const';
import {
    blenderEvents,
    enableNodeTreeBlenderConnection,
} from '../blender/realtime';

// console.log(treeTest);

/* TODO internally we need to
    handle the "no shadows" light path trick...
    minify / prettify (dev mode) output?
*/
ColorManagement.enabled = true;
const renderer = new WebGLRenderer({
    antialias: true,
    premultipliedAlpha: true,
    precision: 'highp',
});
renderer.setPixelRatio(0.4);
renderer.toneMapping = AgXToneMapping;
renderer.toneMappingExposure = 0.73;
renderer.outputColorSpace = SRGBColorSpace;
const renderSize = new Vector2(1280, 720);
renderer.setSize(renderSize.x, renderSize.y);

window.renderer = renderer;

document.body.append(renderer.domElement);

let material: ShaderMaterial | null = null;

let mesh: Mesh | null = null;

const compileShaderTree = createNodeTreeCompiler({
    type: 'ShaderTree',
});

const uniformsElement = document.createElement('div');
uniformsElement.style.display = 'inline-grid';
uniformsElement.style.width = 'auto';
uniformsElement.style.gridTemplateColumns = 'auto auto';
uniformsElement.style.marginTop = '6px';
uniformsElement.style.columnGap = uniformsElement.style.rowGap = '6px';
uniformsElement.style.color = 'white';
document.body.append(uniformsElement);

function compile(tree: NodeTree, name = '') {
    const transpiledShader = compileShaderTree(tree);
    // console.log(transpiledShader);
    console.groupCollapsed('Shader ' + name);
    console.groupCollapsed('Tree');
    console.log(tree);
    console.groupEnd();

    if (material) material.dispose();
    // return new MeshLambertMaterial({
    //     map:
    // })
    material = new ShaderMaterial({
        lights: transpiledShader.compilationCache.features.has('lights'),
        side: DoubleSide,
        transparent: true,
        alphaTest: 0.1,
        // dithering: true,
        // depthWrite: false,
        // depthTest: false,

        uniforms: {
            ...transpiledShader.compilationCache.uniforms,
            // TODO get from geometry bounding box
            // size: { value: 90 },
            // scale: { value: 1 },
        },
        defines: Array.from(transpiledShader.compilationCache.defines).reduce(
            (defines, v) => {
                defines[v] = '';
                return defines;
            },
            {}
            // { USE_POINTS: '', USE_POINTS_UV: '' }
        ),
        vertexShader: transpiledShader.vertexShader,
        fragmentShader: transpiledShader.fragmentShader,
    });
    material.name = name;

    material.onBeforeRender = (
        renderer,
        scene,
        camera,
        geometry,
        object,
        group
    ) => {
        if ('USE_OBJECT_INFO' in material.defines) {
            material.uniforms.objectLocation.value = object.position;
            material.uniformsNeedUpdate = true;
        }

        if (object instanceof InstancedMesh) {
            material.defines['USE_INSTANCING'] = '';
        } else if ('USE_INSTANCING' in material.defines) {
            delete material.defines['USE_INSTANCING'];
        }
    };

    console.groupCollapsed('uniforms');
    console.log(material.uniforms);
    console.groupEnd();

    console.groupCollapsed('vertexShader');
    console.log(material.vertexShader);
    console.groupEnd();

    console.groupCollapsed('fragmentShader');
    console.log(
        material.fragmentShader.replace(
            blenderNoise,
            '//shortened for log\n#include <blenderNoise>'
        )
    );
    console.groupEnd();
    // if (mesh) mesh.material = material;

    uniformsElement.innerHTML = '';
    if (transpiledShader.compilationCache.uniforms) {
        for (let key of Object.keys(
            transpiledShader.compilationCache.uniforms
        )) {
            const uniform = transpiledShader.compilationCache.uniforms[key];
            if (uniform.value instanceof CanvasTexture) {
                const canvas = uniform.value.source.data;
                canvas.style.border = '2px solid #ACACAC';
                if (canvas.height === 1) {
                    canvas.style.width = '128px';
                    canvas.style.height = '16px';
                } else {
                    canvas.style.maxWidth = `${renderSize.x}px`;
                }
                canvas.style.aspectRatio = 'unset';
                uniformsElement.append(canvas);
                uniformsElement.append(key);
            }
        }
    }
    console.groupEnd();
    return material;
}

// compile();

// const plane = new Mesh(
//     new BoxGeometry(2, 2, 2),
//     new ShaderMaterial({
//         lights: transpiledShader.compilationCache.features.has('lights'),
//         side: DoubleSide,
//         transparent: true,
//         uniforms: transpiledShader.compilationCache.uniforms,
//         defines: Array.from(transpiledShader.compilationCache.defines).reduce(
//             (defines, v) => {
//                 defines[v] = '';
//                 return defines;
//             },
//             {}
//         ),
//         vertexShader: transpiledShader.vertexShader,
//         fragmentShader: transpiledShader.fragmentShader,
//     })
// );
// plane.rotateX(-Math.PI / 4);
// plane.rotateY(Math.PI / 4);
// plane.material.onBeforeCompile = (parameters) => {
//     console.log('beforeCompile', parameters);
// };

let controls: OrbitControls;
new GLTFLoader().load('assets/shader-compile-test.glb', (gltf) => {
    console.log(gltf.scene);
    gltf.scene.traverse((o) => {
        // console.log(o);
        if (o instanceof Mesh) {
            // mesh = o;
            if (controls) {
                controls.target = o.position.clone().setY(camera.position.y);
                controls.update();
            }

            // o.material = material;
        } else if (o instanceof PerspectiveCamera) {
            console.log('camera?', o);
            camera = o;
            camera.far = 10000;
            // scene.add(camera);
            // controls.object = camera;

            controls = new OrbitControls(camera, renderer.domElement);
            // controls.target =

            composer = new EffectComposer(renderer, renderTarget);

            composer.addPass(new RenderPass(scene, camera));
            // composer.addPass(new OutputPass());
            // controls.target =
        }

        // if (o.userData.name.startsWith('GN_Instance'))
        const features = getFeaturesFromName(o);
        if (features.instances) {
            if (!(o.children[0] instanceof Mesh)) return;
            // console.log(o.children[0].geometry);
            const shaderTree = JSON.parse(
                o.children[0].material.userData.shaderTree
            );

            // console.log('SEARCH FOR NORMAL', o, o.children, geometry);

            // console.log(JSON.parse(o.children[0].material.userData.shaderTree));
            const geometry = o.children[0].geometry as BufferGeometry;
            const instancedMesh = new InstancedMesh(
                geometry,
                // new MeshLambertMaterial({
                //     map: new TextureLoader().load(
                //         'assets/spritesheet-leaf-1.webp'
                //     ),
                //     transparent: true,
                //     alphaTest: 0.5,
                //     side: DoubleSide,
                // }),
                // o.children[0].material,
                compile(shaderTree, o.children[0].material.name),
                o.children.length
            );
            mesh = instancedMesh;
            instancedMesh.position.copy(o.position);
            instancedMesh.rotation.copy(o.rotation);
            instancedMesh.scale.copy(o.scale);

            o.children.forEach((c, i) => {
                // console.log(c);
                instancedMesh.setMatrixAt(i, c.matrix);
            });

            // const geometry = new BufferGeometry();

            // const instancedMesh = new Points(
            //     geometry,
            //     compile(shaderTree, o.children[0].material.name)
            // );
            // mesh = instancedMesh;

            // const positionAttribute = new BufferAttribute(
            //     new Float32Array(o.children.length * 3),
            //     3
            // );
            // instancedMesh.geometry.setAttribute('position', positionAttribute);
            // instancedMesh.position.copy(o.position);
            // instancedMesh.rotation.copy(o.rotation);
            // instancedMesh.scale.copy(o.scale);

            // o.children.forEach((c, i) => {
            //     // console.log(c);
            //     // if (c)
            //     positionAttribute.set(c.position.toArray(), i * 3);
            // });

            for (let key in o.userData) {
                const dataFeatures = getFeaturesFromName(key);
                const data = o.userData[key];

                if (dataFeatures.attribute) {
                    console.log(
                        'creating attribute',
                        dataFeatures.reference,
                        data
                    );

                    const parsedData = JSON.parse(data);

                    if (parsedData instanceof Array) {
                        const itemSize = Array.isArray(parsedData[0])
                            ? parsedData[0].length
                            : 1;
                        const attribute = new InstancedBufferAttribute(
                            new Float32Array(parsedData.flat()),
                            itemSize,
                            false,
                            1
                        );

                        geometry.setAttribute(
                            dataFeatures.reference as string,
                            attribute
                        );
                    }
                }
            }

            o.children = [];

            scene.add(instancedMesh);
        }
    });

    scene.add(...gltf.scene.children);
    console.log(scene.children);

    enableNodeTreeBlenderConnection();
});

const scene = new Scene();
// scene.add(plane);

// const camera = new OrthographicCamera(2, -2, 2, -2, -1, 1000);
let camera = new PerspectiveCamera(50);
camera.position.set(3, 3, 3);
camera.lookAt(0, 0, 0);
// scene.add(camera);

// const orbitControls = new OrbitControls(camera, renderer.domElement);
// controls = new OrbitControls(camera, renderer.domElement);

const ambientLight = new AmbientLight(new Color('#FFF'), 0.2);
scene.add(ambientLight);

// scene.environment = new Sky

// const light = new DirectionalLight(new Color('#fff'), 6);
// light.position.set(-1, -5, 0);
// light.lookAt(0, 0, 0);
// scene.add(light);
// scene.add(new DirectionalLightHelper(light));

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

const renderTarget = new WebGLRenderTarget(
    renderSize.x,
    renderSize.y,
    parameters
);

renderer.initRenderTarget(renderTarget);

let composer: EffectComposer; // = new EffectComposer(renderer, renderTarget);

// composer.addPass(new RenderPass(scene, camera));
// composer.addPass(new OutputPass());

let time = Date.now();

const stats = new Stats();
document.body.append(stats.dom);

const shaderInterval = interval(1000 / 30);
shaderInterval.accumulative = false;
// shaderInterval.

function tick() {
    const newTime = Date.now();
    const delta = newTime - time;
    const deltaSeconds = delta / 1000;
    time = newTime;

    stats.begin();

    // TODO genericise this concept
    if (shaderInterval(delta)) {
        uniformTime.value += deltaSeconds;
    }

    if (composer) {
        composer.render();
    } else {
        renderer.render(scene, camera);
    }

    stats.end();

    requestAnimationFrame(tick);
}
// composer.render();

tick();

blenderEvents.addEventListener('shaderTree', (e) => {
    const { name, tree } = e.detail;
    const newMaterial = compile(tree, name);
    scene.traverse((o) => {
        if (o instanceof Mesh || o instanceof InstancedMesh) {
            if (o.material.name === name) {
                o.material = newMaterial;
            }
        }
    });
});
