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
    ShaderMaterial,
    Vector2,
} from 'three';
import {
    GLTFLoader,
    OrbitControls,
    ShaderPass,
    UnrealBloomPass,
} from 'three-stdlib';
import { defaultComponentTypes, Manager } from '../ecs/manager';
import { Pipeline } from '../ecs/system';
import { applyEditorUIPlugin } from '../plugins/editorUIPlugin';
import rendererPlugin, {
    RendererPluginComponents,
    RenderPassPhase,
} from '../plugins/three/rendererPlugin';
import { now } from '../util/now';
import shaderTreePlugin, {
    ShaderTreeComponentTypes,
} from '../plugins/three/shaderTreePlugin';
import materialManagerPlugin from '../plugins/three/materialManagerPlugin';
import { enableNodeTreeBlenderConnection } from '../blender/realtime';

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
            // rToneMapping:
            rToneMapping: AgXToneMapping,
            rShadowMap: {
                enabled: false,
                type: PCFShadowMap,
                autoUpdate: true,
            },
        }
    );

const { materialPipeline } = materialManagerPlugin(em, [
    'object3D',
    'rProgram',
]);
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

const compositorPass = em.quickEntity(
    {
        isRenderPass: true,
        rPassPhase: RenderPassPhase.POST_PROCESS,
        rProgram: new ShaderPass(
            new ShaderMaterial({ name: 'test-color-composer' })
        ),
    },
    'compositorPassTest'
);

console.log('CompositorPass', compositorPass);

fetch('assets/shaders/test-color-composer.json')
    .then((response) => {
        return response.json();
    })
    .then((body) => {
        em.quickEntity({
            materialName: 'test-color-composer',
            shaderTree: body,
        });
        // compositorPass.components.materialName = 'test-color-composer';
        // compositorPass.components.shaderTree = body;
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
