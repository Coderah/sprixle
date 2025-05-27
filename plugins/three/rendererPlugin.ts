import * as THREE from 'three';
import {
    BasicShadowMap,
    Color,
    NeutralToneMapping,
    RenderTargetOptions,
    SRGBColorSpace,
    WebGLRenderer,
    WebGLRendererParameters,
    WebGLRenderTarget,
} from 'three';
import { EffectComposer, Pass, RenderPass } from 'three-stdlib';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass';
import {
    defaultComponentTypes,
    EntityWithComponents,
    Manager,
} from '../../ecs/manager';
import { Pipeline } from '../../ecs/system';
import { SingletonComponent } from '../../ecs/types';
import { resolutionUniform, uniformTime } from '../nodeTrees/shader/uniforms';

type ExtraRendererConfigurationKeys = Pick<
    WebGLRenderer,
    'toneMapping' | 'toneMappingExposure' | 'outputColorSpace'
> & {
    shadowMap: Pick<
        WebGLRenderer['shadowMap'],
        'enabled' | 'autoUpdate' | 'type'
    >;
};

// TODO add more control over primary renderTarget
export type RenderConfigurationComponents = {
    isRendererConfiguration: true;

    /** Defines the size of the renderer in pixels. Defaults to window size. Gets multiplied by rPixelRatio internally. */
    rSize: THREE.Vector2;

    /** Pixel ratio to render at, defaults to {@link window.devicePixelRatio} */
    rPixelRatio: number;

    /** specify internal color target's {@link RenderTargetOptions.samples} */
    rMSAASamples: number;

    rClearColor: Color;
    rClearAlpha: number;
} & {
    [K in keyof ExtraRendererConfigurationKeys as `r${Capitalize<K>}`]: ExtraRendererConfigurationKeys[K];
};

export enum RenderPassPhase {
    /** DATA passes are rendered entirely on their own to a texture that can be utilized in the later steps. Much like a depth pass */
    PREPASS,
    DEPTH,
    COLOR,
    POST_PROCESS,
    /** BASIC renders skip all compositing, can be useful to render a 3D UI layer. */
    BASIC,
}

/** @todo implement, intended to map to blender's AOV (depth pass would be defined as such) */
export type RenderPassComponents = {
    isRenderPass: true;
    rPassPhase: RenderPassPhase;
    rProgram: Pass;
    rLayers: THREE.Layers;
};

export type SceneComponents = {
    rScene: THREE.Scene & SingletonComponent;
    rCamera: THREE.Camera & SingletonComponent;
};

export type RendererPluginComponents = RenderPassComponents &
    RenderConfigurationComponents &
    SceneComponents;

const renderConfigurationDefaults: RenderConfigurationComponents = {
    isRendererConfiguration: true,

    rSize: new THREE.Vector2(window.innerWidth, window.innerHeight),

    rClearColor: new Color('black'),
    rClearAlpha: 1,

    rPixelRatio: window.devicePixelRatio,

    rMSAASamples: 0,

    rOutputColorSpace: SRGBColorSpace,
    rToneMapping: NeutralToneMapping,
    rToneMappingExposure: 1,

    rShadowMap: {
        enabled: false,
        type: BasicShadowMap,
        autoUpdate: false,
    },
};

const defaultRenderParameters: WebGLRendererParameters = {
    precision: 'mediump',
    logarithmicDepthBuffer: false,
    reverseDepthBuffer: false,
    premultipliedAlpha: false,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: false,
    antialias: true,
};

// TODO support editorPlugin somehow? want debug passes
export function applyRendererPlugin<
    C extends RendererPluginComponents & defaultComponentTypes
>(
    em: Manager<C>,
    renderParameters: WebGLRendererParameters,
    configuration?: Partial<RenderConfigurationComponents>
) {
    type M = Manager<C>;
    type ConfigurationEntity = EntityWithComponents<
        C,
        M,
        keyof RenderConfigurationComponents
    >;

    const configurationEntity = em.quickEntity(
        {
            ...renderConfigurationDefaults,
            ...configuration,
        } as Partial<C>,
        'rendererConfiguration'
    ) as ConfigurationEntity;

    THREE.ColorManagement.enabled = true;

    const renderer = new WebGLRenderer({
        ...renderParameters,
        ...defaultRenderParameters,
    });

    function configureRenderer(entity: ConfigurationEntity) {
        const { rSize } = entity.components;
        renderer.setSize(rSize.width, rSize.height);
        renderer.setClearColor(entity.components.rClearColor);
        renderer.setClearAlpha(entity.components.rClearAlpha);

        Object.assign(renderer.shadowMap, entity.components.rShadowMap);
        renderer.toneMapping = entity.components.rToneMapping;
        renderer.toneMappingExposure = entity.components.rToneMappingExposure;
        renderer.outputColorSpace = entity.components.rOutputColorSpace;

        renderer.setPixelRatio(entity.components.rPixelRatio);
    }

    const { capabilities } = renderer;
    const rendererContext = renderer.getContext() as WebGLRenderingContext;
    const canRenderToFloatType =
        rendererContext.getExtension('EXT_float_blend') &&
        rendererContext.getExtension('OES_texture_float_linear');
    const maxAnisotropy = capabilities.getMaxAnisotropy();

    let composer = new EffectComposer(renderer);
    let renderPass = new RenderPass(null, null);

    function reconfigureComposer(entity: ConfigurationEntity) {
        const { rPixelRatio, rSize, rMSAASamples } = entity.components;
        const parameters: RenderTargetOptions = {
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
            format: THREE.RGBAFormat,
            type: THREE.HalfFloatType,
            anisotropy: maxAnisotropy,
        };

        // TODO introduce depth pass as a isRenderPass entity, add a helper to create it easily.
        // const depthTarget = new WebGLRenderTarget(
        //     rSize.width,
        //     rSize.height,
        //     parameters
        // );

        // depthComposer.renderTarget1?.dispose();
        // depthComposer.renderTarget2?.dispose();
        // depthComposer = new EffectComposer(renderer, depthTarget);
        // depthComposer.renderToScreen = false;

        // const depthPass = new RenderPass(em.getSingletonEntityComponent('rScene'), em.getSingletonEntityComponent('rCamera'), depthMaterial);
        // depthComposer.addPass(depthPass);

        // depthComposer.addPass(new OutputPass());

        // TODO we should be able to re-use and simply resize?
        const renderTarget = new WebGLRenderTarget(
            rSize.width * rPixelRatio,
            rSize.height * rPixelRatio,
            parameters
        );

        resolutionUniform.value.set(renderTarget.width, renderTarget.height);
        renderTarget.samples = rMSAASamples;

        // TODO if renderTarget is not getting re-used the old one should be disposed.
        renderer.initRenderTarget(renderTarget);

        // debugTexturePass.map = depthTarget.texture;
        // depthUniform.value = depthTarget.texture;

        composer.renderTarget1?.dispose();
        composer.renderTarget2?.dispose();

        composer = new EffectComposer(renderer, renderTarget);

        // TODO turn into a isRenderPass entity
        renderPass = new RenderPass(null, null);
        renderPass.clearAlpha = 0;
        composer.addPass(renderPass);

        // TODO utilize isRenderPass POST_PROCESS entities here.

        composer.addPass(new OutputPass());
    }

    const configurationQuery = em.createQuery({
        includes: Object.keys(renderConfigurationDefaults) as any,
    });

    const configureRenderSystem = em.createSystem(
        configurationQuery.createConsumer(),
        {
            tag: 'configureRenderSystem',
            init() {
                reconfigureComposer(configurationEntity);
            },
            newOrUpdated(entity) {
                configureRenderer(entity as ConfigurationEntity);
                reconfigureComposer(entity as ConfigurationEntity);
            },
        }
    );

    // TODO make configurable?
    window.addEventListener('resize', () => {
        configurationEntity.components.rSize.set(
            window.innerWidth,
            window.innerHeight
        );
        configurationEntity.flagUpdate('rSize');
    });

    const actualRenderSystem = em.createSystem({
        tag: 'actualRenderSystem',
        tick(delta) {
            const activeCamera = em.getSingletonEntityComponent('rCamera');
            const activeScene = em.getSingletonEntityComponent('rScene');

            if (!activeCamera || !activeScene) return;

            renderPass.scene = activeScene;
            renderPass.camera = activeCamera;

            uniformTime.value += delta / 1000;
            renderer.setRenderTarget(null);
            activeCamera.layers.enableAll();

            // TODO implement DEPTH and PREPASS isRenderPass entities here
            // utilize rLayers
            // depthComposer.render(delta);

            composer.render(delta);

            // TODO implement BASIC/FLAT isRenderPass entities here
            // activeCamera.layers.set(UI_LAYER);
            // renderer.render(activeScene, activeCamera);
        },
    });

    const rendererPipeline = new Pipeline(
        em,
        configureRenderSystem,
        actualRenderSystem
    );
    rendererPipeline.tag = 'rendererPipeline';

    return { rendererPipeline, configurationEntity };
}
