import {
    AmbientLight,
    Color,
    Mesh,
    NeutralToneMapping,
    PCFShadowMap,
    PerspectiveCamera,
    Scene,
    ShaderMaterial,
    Vector2,
} from 'three';
import {
    FXAAShader,
    GLTFLoader,
    OrbitControls,
    ShaderPass,
    SMAAPass,
    UnrealBloomPass,
} from 'three-stdlib';
import { enableNodeTreeBlenderConnection } from '../blender/realtime';
import { defaultComponentTypes, Manager } from '../ecs/manager';
import { Pipeline } from '../ecs/system';
import { applyEditorUIPlugin } from '../plugins/editorUIPlugin';
import materialManagerPlugin from '../plugins/three/materialManagerPlugin';
import rendererPlugin, {
    RendererPluginComponents,
    RenderPassPhase,
} from '../plugins/three/rendererPlugin';
import shaderTreePlugin, {
    ShaderTreeComponentTypes,
} from '../plugins/three/shaderTreePlugin';
import { now } from '../util/now';

type ComponentTypes = defaultComponentTypes &
    RendererPluginComponents &
    ShaderTreeComponentTypes;

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
            // rMSAASamples: 8,
            rToneMapping: NeutralToneMapping,
            rShadowMap: {
                enabled: false,
                type: PCFShadowMap,
                autoUpdate: true,
            },
        }
    );

const { materialPipeline } = materialManagerPlugin(em);
const nodes = {};
const shaderTreeSystem = shaderTreePlugin<ComponentTypes, typeof nodes>(
    em,
    nodes
);

enableNodeTreeBlenderConnection();

// renderer.sortObjects = false;

document.body.append(glCanvas);

const mainPipeline = new Pipeline(
    em,
    editorPipeline,
    shaderTreeSystem,
    materialPipeline,
    rendererPipeline
);

mainPipeline.init();

const camera = new PerspectiveCamera(
    50,
    configurationEntity.components.rSize.x /
        configurationEntity.components.rSize.y
);
camera.far = 50;
camera.near = 1;
camera.position.set(5, 5, 5);
camera.lookAt(0, 0, 0);
em.setSingletonEntityComponent('rCamera', camera);
const scene = new Scene();

em.setSingletonEntityComponent('rScene', scene);

const orbitControls = new OrbitControls(camera, glCanvas);

const compositorPass = em.quickEntity(
    {
        isRenderPass: true,
        rPassPhase: RenderPassPhase.POST_PROCESS,
        rProgram: new ShaderPass(
            new ShaderMaterial({ name: 'test-color-composer' }),
            'tDiffuse'
        ),
    },
    'compositorPassTest'
);

// const bloomPass = em.quickEntity({
//     isRenderPass: true,
//     rPassPhase: RenderPassPhase.POST_PROCESS,
//     rProgram: new UnrealBloomPass(new Vector2(1024, 1024), 0.2, 0.001, 0.2),
// });

// const fxaaPass = em.quickEntity({
//     isRenderPass: true,
//     rPassPhase: RenderPassPhase.POST_PROCESS,
//     rProgram: new SMAAPass(1024, 1024),
// });

fetch('assets/shaders/test-color-composer.json')
    .then((response) => {
        return response.json();
    })
    .then((body) => {
        em.quickEntity({
            materialName: 'test-color-composer',
            shaderTree: body,
        });
    });

const gltfLoader = new GLTFLoader();

gltfLoader.loadAsync('assets/Scene.glb').then((gltf) => {
    // gltf.scene.scale.setScalar(0.2);
    const lights = [];

    gltf.scene.traverse((object) => {
        if (object instanceof Mesh) {
            em.quickEntity({
                object3D: object,
            });
        }
    });
    em.setSingletonEntityComponent('rCamera', gltf.cameras[0]);
    scene.add(gltf.scene);
    scene.add(new AmbientLight(0xffffff, 0.04 * 3.1));
    scene.background = new Color(0xffffff).multiplyScalar(0.04);
    console.log(gltf);
});

let time = now();
let rotation = 0;
function tick() {
    const newTime = now();
    const delta = newTime - time;
    time = newTime;

    // stats.begin();

    orbitControls.update();

    mainPipeline.tick(delta);

    em.tick();

    // stats.end();

    requestAnimationFrame(tick);
}

requestAnimationFrame(tick);
