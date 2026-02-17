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
import {
    EffectComposer,
    Pass,
    RenderPass,
    ShaderPass,
    TexturePass,
} from 'three-stdlib';
import {
    defaultComponentTypes,
    EntityWithComponents,
    Manager,
} from '../../ecs/manager';
import { Pipeline } from '../../ecs/system';
import { SingletonComponent } from '../../ecs/types';
import {
    resolutionUniform,
    uniformFrame,
    uniformTime,
} from '../nodeTrees/shader/uniforms';
import { sprixlePlugin } from '../../ecs/plugin';
import { DepthPass } from './pass/DepthPass';
import { ShaderTreeComponentTypes } from './shaderTreePlugin';
import { MaterialManagerComponentTypes } from './materialManagerPlugin';
import { PassTargets } from '../nodeTrees/shader/blender/viewLayer';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass';

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

export type ViewLayerComponents = {
    /** Like Blender's AOV outputs & Passes to separate, this handles which outputs will be available to POST_PROCESS programs */
    rPassTargets: PassTargets & SingletonComponent;
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
    PREPASS,
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
    /** which objects are included based on three.js layers */
    rLayers: THREE.Layers;

    /** Determines ordering within a rPassPhase */
    rOrder: number;
};

export type SceneComponents = {
    rScene: THREE.Scene & SingletonComponent;
    rCamera: THREE.Camera & SingletonComponent;
};

export type RendererPluginComponents = RenderPassComponents &
    RenderConfigurationComponents &
    ViewLayerComponents &
    SceneComponents &
    ShaderTreeComponentTypes &
    MaterialManagerComponentTypes;

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
    antialias: false,
};

const overdrawMaterial = new THREE.MeshBasicMaterial({
    color: 0x550000,
    transparent: true,
    alphaHash: false,
    // side: THREE.DoubleSide,
    opacity: 0.25, // Low opacity for accumulation
    blending: THREE.AdditiveBlending,
    depthWrite: true, // Ensure layers stack
});

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

    let multipassTarget: WebGLRenderTarget;

    let composer = new EffectComposer(renderer);

    // TODO allow disabling the basic rendering passes setup
    // em.quickEntity({
    //     isRenderPass: true,
    //     rPassPhase: RenderPassPhase.COLOR,
    // });

    // em.quickEntity({
    //     isRenderPass: true,
    //     rPassPhase: RenderPassPhase.PREPASS,
    // });

    const configurationQuery = em.createQuery({
        includes: Object.keys(renderConfigurationDefaults) as any,
    });

    // TODO detect rTargetPass changes and recompile shaders if necessary
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

    const renderTargetsQuery = em.createQuery({
        includes: ['rPassTargets'],
    });

    const configureTargetsSystem = em.createSystem(
        renderTargetsQuery.createConsumer(),
        {
            newOrUpdated(targetsEntity) {
                reconfigureComposer(configurationEntity);

                // recompile shaders.
                if (em.plugins.has('shaderTreePlugin')) {
                    em.getEntities('material').forEach((e) => {
                        if (e.previousComponents.shaderTree) {
                            e.components.shaderTree =
                                e.previousComponents.shaderTree;
                        }
                    });
                }
            },
        }
    );

    const renderPassQuery = em.createQuery({
        includes: ['isRenderPass', 'rPassPhase'],
        index: 'rPassPhase',
    });

    function setupRenderPass(entity: typeof renderPassQuery.Entity) {
        const { rPassPhase, rProgram } = entity.components;

        if (rPassPhase === RenderPassPhase.POST_PROCESS) {
            rProgram.renderToScreen = false;
            if (rProgram instanceof ShaderPass) {
                rProgram.uniforms = rProgram.material.uniforms;

                for (let i = 0; i < multipassTarget.textures.length; i++) {
                    const texture = multipassTarget.textures[i];
                    rProgram.uniforms['u' + texture.name] = { value: texture };
                }

                if (multipassTarget.depthTexture) {
                    rProgram.uniforms.uDepth = {
                        value: multipassTarget.depthTexture,
                    };
                }
            }
        }

        // if (rProgram) return;

        if (rPassPhase === RenderPassPhase.PREPASS) {
            entity.components.isExportedRenderPass = true;
            entity.components.rPassTextureUniform = new THREE.Uniform(null);
            entity.components.rProgram = new DepthPass(null, null);
            entity.components.rProgram.renderToScreen = true;
        }

        if (rPassPhase === RenderPassPhase.COLOR) {
            // TODO properly implement depth prepass culling when applicable.
            entity.components.rProgram = new TexturePass(
                multipassTarget.textures[0]
            );
            entity.components.rProgram.renderToScreen = true;
        }
    }

    function reconfigureComposer(entity: ConfigurationEntity) {
        const targets = em.getSingletonEntityComponent('rPassTargets');
        const { rPixelRatio, rSize, rMSAASamples } = entity.components;

        const depthPrepass = renderPassQuery
            .get(RenderPassPhase.PREPASS)
            ?.first();

        const depthTarget = targets?.find(
            (t) => t.internalShaderLogic === 'Depth'
        );
        const validTargets = targets?.filter(
            (t) => t.internalShaderLogic !== 'Depth'
        );

        const parameters: RenderTargetOptions = {
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
            format: THREE.RGBAFormat,
            type: canRenderToFloatType ? THREE.FloatType : THREE.HalfFloatType,
            anisotropy: maxAnisotropy,
        };

        // TODO differentiate between a depth pre-pass and including depth in the color renderPass.
        if (depthPrepass || depthTarget) {
            parameters.depthTexture = new THREE.DepthTexture(
                rSize.width,
                rSize.height
            );
            parameters.depthTexture.type = THREE.UnsignedInt248Type;
            // TODO how do shaders access the depth uniform if not prepass?
            if (depthPrepass?.components.rPassTextureUniform) {
                depthPrepass.components.rPassTextureUniform.value =
                    parameters.depthTexture;
            }
        }

        if (multipassTarget) {
            multipassTarget.dispose();
        }
        multipassTarget = new WebGLRenderTarget(
            // TODO is pixelRatio appropriate here?
            rSize.width * rPixelRatio,
            rSize.height * rPixelRatio,
            {
                ...parameters,
                depthBuffer: true,
                count: validTargets?.length || 1,
                samples: rMSAASamples,
            }
        );

        if (validTargets?.length) {
            for (let i = 0; i < validTargets.length; i++) {
                const target = validTargets[i];
                const texture = multipassTarget.textures[i];
                if (!texture) continue;

                texture.name = target.name;
                if (texture.format) {
                    texture.format = target.format;
                }
                if (target.type) {
                    texture.type = target.type;
                }
            }
        }
        console.log('multipassRenderer', multipassTarget);

        // TODO move?
        resolutionUniform.value.set(
            multipassTarget.width,
            multipassTarget.height
        );

        renderer.initRenderTarget(multipassTarget);

        const composerTarget = new WebGLRenderTarget(
            rSize.width * rPixelRatio,
            rSize.height * rPixelRatio,
            {
                ...parameters,
                depthBuffer: false,
                // depthBuffer: true,
                count: 1,
                // count: validTargets?.length || 1,
                samples: rMSAASamples,
            }
        );

        renderer.initRenderTarget(composerTarget);

        composer.renderTarget1?.dispose();
        composer.renderTarget2?.dispose();

        composer = new EffectComposer(renderer, composerTarget);

        if (depthPrepass) {
            setupRenderPass(depthPrepass);
            composer.addPass(depthPrepass.components.rProgram);
        }

        const colorPass = renderPassQuery.get(RenderPassPhase.COLOR)?.first();
        if (colorPass) {
            setupRenderPass(colorPass);
            composer.addPass(colorPass.components.rProgram);
        }

        const postProcessPasses = Array.from(
            renderPassQuery.get(RenderPassPhase.POST_PROCESS)
        ).sort(sortPasses);
        for (let pass of postProcessPasses) {
            if (!pass.components.rProgram) continue;
            setupRenderPass(pass);
            composer.addPass(pass.components.rProgram);
        }

        const outputPass = new OutputPass();
        outputPass.renderToScreen = true;
        composer.addPass(outputPass);

        // renderer.resetState();
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

            uniformFrame.value++;
            uniformTime.value += delta / 1000;
            renderer.setRenderTarget(null);
            activeCamera.layers.enableAll();

            // TODO implement visualization toggle, and support deferred/prepass stuff
            // activeScene.overrideMaterial = overdrawMaterial;
            // renderer.render(activeScene, activeCamera);
            // return;

            if (renderPassQuery.size) {
                // TODO move to an update() consumer system
                for (let passEntity of renderPassQuery) {
                    const { rProgram } = passEntity.components;
                    if (!rProgram) continue;

                    rProgram.scene = activeScene;
                    rProgram.camera = activeCamera;
                }

                renderer.setRenderTarget(multipassTarget);
                renderer.render(activeScene, activeCamera);
                renderer.setRenderTarget(null);

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
        configureTargetsSystem,
        actualRenderSystem
    );
    rendererPipeline.tag = 'rendererPipeline';

    function sortPasses(a: typeof em.Entity, b: typeof em.Entity) {
        return (a.components.rOrder || 0) > (b.components.rOrder || 0) ? 1 : -1;
    }

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
