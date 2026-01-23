import {
    AmbientLight,
    BasicShadowMap,
    DirectionalLight,
    DoubleSide,
    FrontSide,
    HalfFloatType,
    LessEqualDepth,
    Material,
    Mesh,
    MeshBasicMaterial,
    MeshLambertMaterial,
    MeshStandardMaterial,
    Object3D,
    PCFShadowMap,
    PCFSoftShadowMap,
    PerspectiveCamera,
    Scene,
    SphereGeometry,
    Vector2,
    VSMShadowMap,
} from 'three';
import { GLTFLoader, OrbitControls, UnrealBloomPass } from 'three-stdlib';
import { defaultComponentTypes, Manager } from '../ecs/manager';
import { Pipeline } from '../ecs/system';
import rendererPlugin, {
    RendererPluginComponents,
    RenderPassPhase,
} from '../plugins/three/rendererPlugin';
import { memoizedGlobalNow, now } from '../util/now';
import { applyEditorUIPlugin } from '../plugins/editorUIPlugin';
import { interval } from '../util/timing';

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
            rShadowMap: {
                enabled: true,
                type: BasicShadowMap,
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

const light = new DirectionalLight('yellow', 3);
light.castShadow = true;
light.shadow.mapSize.width = 2048; // default is 512
light.shadow.mapSize.height = 2048; // default is 512
light.shadow.camera.near = 0.5; // default is 0.5
light.shadow.camera.far = 20; // default is 50
// For DirectionalLight, an OrthographicCamera is used for the shadow view, so adjust the size
light.shadow.camera.left = -8;
light.shadow.camera.right = 8;
light.shadow.camera.top = 8;
light.shadow.camera.bottom = -8;
// light.shadow.radius = 0.2;
// light.shadow.blurSamples = 2;
light.shadow.bias = -0.000005;
light.shadow.normalBias = 0.4;
light.position.set(-3, 3, 3);
light.lookAt(0, 0, 0);
const lightParent = new Object3D();
scene.add(lightParent);
lightParent.add(light);
scene.add(new AmbientLight('white', 0.25));

const gltfLoader = new GLTFLoader();

gltfLoader
    .loadAsync('assets/full_gameready_city_buildings_iv_hongkong.glb')
    .then((gltf) => {
        // gltf.scene.scale.setScalar(0.2);
        gltf.scene.traverse((o) => {
            if (o instanceof Mesh) {
                o.frustumCulled = false;
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
            }
        });
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
    rProgram: new UnrealBloomPass(new Vector2(512, 512), 0.2, 0.001, 0.2),
});

let time = now();
function tick() {
    const newTime = now();
    const delta = newTime - time;
    time = newTime;

    // stats.begin();

    orbitControls.update();

    mainPipeline.tick(delta);
    lightParent.rotateY(0.005);

    em.tick();

    // stats.end();

    requestAnimationFrame(tick);
}

requestAnimationFrame(tick);
