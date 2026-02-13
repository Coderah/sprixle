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
import { EffectComposer, Pass, RenderPass, ShaderPass } from 'three-stdlib';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass';
import {
    defaultComponentTypes,
    EntityWithComponents,
    Manager,
} from '../../ecs/manager';
import { Pipeline } from '../../ecs/system';
import { SingletonComponent } from '../../ecs/types';
import { resolutionUniform, uniformTime } from '../nodeTrees/shader/uniforms';
import { sprixlePlugin } from '../../ecs/plugin';
import { DepthPass } from './pass/DepthPass';

THREE.ColorManagement.enabled = true;

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
    AOV,
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
    isExportedRenderPass: true;
    /** if isExportedRenderPass this will get populated */
    // TODO make uniform?
    rPassTextureUniform: THREE.Uniform<THREE.DepthTexture | null>;
    // r;
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

    rPixelRatio: window.devicePixelRatio || 1,

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
    premultipliedAlpha: false,
    powerPreference: 'high-performance',
    preserveDrawingBuffer: false,
    antialias: true,
};

// TODO support editorPlugin somehow? want debug passes
export default sprixlePlugin(function RendererPlugin<
    C extends RendererPluginComponents & defaultComponentTypes =
        RendererPluginComponents & defaultComponentTypes,
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

    // TODO allow disabling the basic rendering passes setup
    em.quickEntity({
        isRenderPass: true,
        rPassPhase: RenderPassPhase.COLOR,
    });

    em.quickEntity({
        isRenderPass: true,
        rPassPhase: RenderPassPhase.DEPTH,
    });

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

    const renderPassQuery = em.createQuery({
        includes: ['isRenderPass', 'rPassPhase'],
        index: 'rPassPhase',
    });

    function setupRenderPass(entity: typeof renderPassQuery.Entity) {
        const { rPassPhase, rProgram } = entity.components;

        if (rProgram) return;

        if (rPassPhase === RenderPassPhase.DEPTH) {
            entity.components.isExportedRenderPass = true;
            entity.components.rPassTextureUniform = new THREE.Uniform(null);
            entity.components.rProgram = new DepthPass(null, null);
            entity.components.rProgram.renderToScreen = true;
        }

        if (rPassPhase === RenderPassPhase.COLOR) {
            // TODO properly implement depth prepass culling when applicable.
            entity.components.rProgram = new RenderPass(null, null);
            entity.components.rProgram.renderToScreen = true;
        }

        if (
            rPassPhase === RenderPassPhase.POST_PROCESS &&
            rProgram instanceof ShaderPass
        ) {
            rProgram.uniforms = rProgram.material.uniforms;
        }
    }

    function reconfigureComposer(entity: ConfigurationEntity) {
        const { rPixelRatio, rSize, rMSAASamples } = entity.components;

        const depthPass = renderPassQuery.get(RenderPassPhase.DEPTH)?.first();

        const parameters: RenderTargetOptions = {
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
            format: THREE.RGBAFormat,
            type: canRenderToFloatType ? THREE.FloatType : THREE.HalfFloatType,
            anisotropy: maxAnisotropy,
            depthBuffer: true,
            // depth: 2,
            // TODO prepass count (Blender AOV)
            // count: 1
        };

        if (depthPass && depthPass.components.rPassTextureUniform) {
            parameters.depthTexture = new THREE.DepthTexture(
                rSize.width,
                rSize.height
            );
            depthPass.components.rPassTextureUniform.value =
                parameters.depthTexture;
        }

        // TODO we should be able to re-use and simply resize?
        const renderTarget = new WebGLRenderTarget(
            // TODO is pixelRatio appropriate here?
            rSize.width * rPixelRatio,
            rSize.height * rPixelRatio,
            parameters
        );

        resolutionUniform.value.set(renderTarget.width, renderTarget.height);
        renderTarget.samples = rMSAASamples;

        // TODO if renderTarget is not getting re-used the old one should be disposed.
        renderer.initRenderTarget(renderTarget);

        composer.renderTarget1?.dispose();
        composer.renderTarget2?.dispose();

        composer = new EffectComposer(renderer, renderTarget);

        if (depthPass) {
            setupRenderPass(depthPass);
            composer.addPass(depthPass.components.rProgram);
            // depthPass.components.rProgram
        }

        // TODO turn into a isRenderPass entity
        const colorPass = renderPassQuery.get(RenderPassPhase.COLOR)?.first();
        if (colorPass) {
            setupRenderPass(colorPass);
            composer.addPass(colorPass.components.rProgram);
        }
        // renderPass = new RenderPass(null, null);
        // renderPass.clearAlpha = 0;
        // composer.addPass(renderPass);

        // TODO utilize isRenderPass POST_PROCESS entities here.
        const postProcessPasses = renderPassQuery.get(
            RenderPassPhase.POST_PROCESS
        );
        // TODO enable sortOrder or some such component here when post process passes are order dependent
        for (let pass of postProcessPasses) {
            if (!pass.components.rProgram) continue;
            setupRenderPass(pass);
            composer.addPass(pass.components.rProgram);
        }

        composer.addPass(new OutputPass());
    }

    // TODO make configurable?
    window.addEventListener('resize', () => {
        configurationEntity.willUpdate('rSize');
        configurationEntity.components.rSize.set(
            window.innerWidth,
            window.innerHeight
        );
    });

    const actualRenderSystem = em.createSystem({
        tag: 'actualRenderSystem',
        tick(delta) {
            const activeCamera = em.getSingletonEntityComponent('rCamera');
            const activeScene = em.getSingletonEntityComponent('rScene');

            if (!activeCamera || !activeScene) return;

            uniformTime.value += delta / 1000;
            renderer.setRenderTarget(null);
            activeCamera.layers.enableAll();

            // TODO implement DEPTH and PREPASS isRenderPass entities here
            // utilize rLayers
            // depthComposer.render(delta);

            if (renderPassQuery.size) {
                // TODO move to an update() consumer system
                for (let passEntity of renderPassQuery) {
                    const { rProgram } = passEntity.components;
                    if (!rProgram) continue;
                    // if ('scene' in rProgram) {

                    rProgram.scene = activeScene;
                    rProgram.camera = activeCamera;
                    // }
                    // TODO move this to materialManagerPlugin?
                    if (rProgram instanceof ShaderPass) {
                        if (passEntity.components.material) {
                            rProgram.material = passEntity.components.material;
                        }
                    }
                }
                composer.render(delta);
            } else {
                renderer.render(activeScene, activeCamera);
            }

            // TODO implement BASIC/FLAT isRenderPass entities here
            // activeCamera.layers.set(UI_LAYER);
            // renderer.render(activeScene, activeCamera);
        },
    });

    const rendererPipeline = new Pipeline(
        em,
        // renderPassSetupSystem,
        configureRenderSystem,
        actualRenderSystem
    );
    rendererPipeline.tag = 'rendererPipeline';

    return {
        renderer,
        glCanvas: renderer.domElement,
        rendererPipeline,
        renderPassQuery,
        configurationEntity,
        checks: {
            maxAnisotropy,
            canRenderToFloatType,
        },
    };
});
