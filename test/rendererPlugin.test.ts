import {
    AgXToneMapping,
    AmbientLight,
    BasicShadowMap,
    Camera,
    Light,
    Material,
    Mesh,
    Object3D,
    PCFShadowMap,
    PerspectiveCamera,
    Scene,
    Vector2,
} from 'three';
import { GLTFLoader, OrbitControls, UnrealBloomPass } from 'three-stdlib';
import { defaultComponentTypes, Manager } from '../ecs/manager';
import { Pipeline } from '../ecs/system';
import { applyEditorUIPlugin } from '../plugins/editorUIPlugin';
import rendererPlugin, {
    RendererPluginComponents,
    RenderPassPhase,
} from '../plugins/three/rendererPlugin';
import { now } from '../util/now';

type ComponentTypes = defaultComponentTypes & RendererPluginComponents;

const em = new Manager<ComponentTypes>();
window['em'] = em;

const {
    tweakpane,
    addDeltaGraph,
    pipeline: editorPipeline,
} = applyEditorUIPlugin(em);

addDeltaGraph(true);

const { renderer, glCanvas, rendererPipeline, configurationEntity } =
    rendererPlugin(
        em,
        {
            // antialias: true,
            // premultipliedAlpha: true,
            powerPreference: 'high-performance',
            precision: 'highp',
            // reversedDepthBuffer: true,
            // outputBufferType: HalfFloatType,
        },
        {
            // rToneMapping:
            rToneMapping: AgXToneMapping,
            rShadowMap: {
                enabled: true,
                type: PCFShadowMap,
                autoUpdate: true,
            },
        }
    );

// renderer.sortObjects = false;

document.body.append(glCanvas);

const mainPipeline = new Pipeline(em, editorPipeline, rendererPipeline);

mainPipeline.init();

const camera = new PerspectiveCamera(
    39,
    configurationEntity.components.rSize.x /
        configurationEntity.components.rSize.y
);
camera.far = 50;
camera.near = 1;
camera.position.set(5, 5, 5);
camera.lookAt(0, 0, 0);
em.setSingletonEntityComponent('rCamera', camera);
const scene = new Scene();

// const light = new DirectionalLight('yellow', 3);
// light.castShadow = true;
// light.shadow.mapSize.width = 2048; // default is 512
// light.shadow.mapSize.height = 2048; // default is 512
// light.shadow.camera.near = 0.5; // default is 0.5
// light.shadow.camera.far = 20; // default is 50
// // For DirectionalLight, an OrthographicCamera is used for the shadow view, so adjust the size
// light.shadow.camera.left = -8;
// light.shadow.camera.right = 8;
// light.shadow.camera.top = 8;
// light.shadow.camera.bottom = -8;
// // light.shadow.radius = 0.2;
// // light.shadow.blurSamples = 2;
// light.shadow.bias = -0.000005;
// light.shadow.normalBias = 0.4;
// light.position.set(-3, 3, 3);
// light.lookAt(0, 0, 0);
const lightParent = new Object3D();
scene.add(lightParent);
// lightParent.add(light);
scene.add(new AmbientLight('white', 0.05 * 3));

const gltfLoader = new GLTFLoader();

gltfLoader.loadAsync('assets/sponza-test.glb').then((gltf) => {
    // gltf.scene.scale.setScalar(0.2);
    const lights = [];
    gltf.scene.traverse((o) => {
        if (o instanceof Mesh) {
            // o.frustumCulled = false;
            o.castShadow = o.receiveShadow = true;
            if (o.material instanceof Material) {
                if (o.material.transparent || o.material.alphaHash) {
                    // o.material.depthTest = false;
                    // o.material.side = DoubleSide;
                    // o.material.depthWrite = false;
                    // o.material.depthFunc = LessEqualDepth;
                    // o.layers.set(2);
                    o.material.allowOverride = false;
                    // o.renderOrder = 2;
                }
                // o.material.side = FrontSide;
                // o.material.transparent = true;
                // o.material.alph;
                // o.material.alphaTest = 0.05;
            }
        } else if (o instanceof Light) {
            console.log('light setup shadow', o);
            lights.push(o);
            o.castShadow = true;
            o.shadow.mapSize.width = 2048; // default is 512
            o.shadow.mapSize.height = 2048; // default is 512
            o.shadow.camera.near = 0.5; // default is 0.5
            o.shadow.camera.far = 20; // default is 50
            // For Directionalo, an OrthographicCamera is used for the shadow view, so adjust the size
            o.shadow.camera.left = -10;
            o.shadow.camera.right = 10;
            o.shadow.camera.top = 10;
            o.shadow.camera.bottom = -10;
            o.shadow.radius = 0.2;
            o.shadow.blurSamples = 2;
            o.shadow.bias = -0.001;
            o.shadow.normalBias = 0.1;
        } else if (o instanceof Camera) {
            em.setSingletonEntityComponent('rCamera', o);
        }
    });
    lightParent.add(...lights);
    scene.add(gltf.scene);
    console.log(gltf);
});

// for (let i = -250; i < 250; i++) {
//     const mesh = new Mesh(
//         new SphereGeometry(1),
//         new MeshLambertMaterial({
//             // roughness: 0.2,
//             // metalness: 0.5,
//             color: 'white',
//         })
//     );

//     mesh.position.x = i * 1.5;
//     mesh.castShadow = true;
//     mesh.receiveShadow = true;

//     scene.add(mesh);
// }

em.setSingletonEntityComponent('rScene', scene);

const orbitControls = new OrbitControls(camera, glCanvas);

// mainPipeline.interval = interval(1000 / 80);
// mainPipeline.interval.accumulative = false;

// renderer.autoClear = false;
// renderer.autoClearDepth = false;

const bloomPass = em.quickEntity({
    isRenderPass: true,
    rPassPhase: RenderPassPhase.POST_PROCESS,
    rProgram: new UnrealBloomPass(new Vector2(1024, 1024), 0.2, 0.001, 0.2),
});

let time = now();
let rotation = 0;
function tick() {
    const newTime = now();
    const delta = newTime - time;
    time = newTime;

    // stats.begin();

    // orbitControls.object = em.getSingletonEntityComponent('rCamera');

    orbitControls.update();

    rotation += delta * 0.0005;
    // lightParent.rotation.x = Math.sin(rotation) * 0.2;
    lightParent.rotation.y = Math.sin(rotation) * 0.2;

    mainPipeline.tick(delta);

    em.tick();

    // stats.end();

    requestAnimationFrame(tick);
}

requestAnimationFrame(tick);
