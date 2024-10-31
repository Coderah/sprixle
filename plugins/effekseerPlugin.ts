/// <reference path="./effekseer/effekseer.d.ts" />
import {
    Cache,
    Camera,
    Loader,
    LoadingManager,
    Object3D,
    PerspectiveCamera,
    Scene,
    Vector3,
    WebGLRenderer,
} from 'three';
import { defaultComponentTypes, Manager } from '../ecs/manager';
import { throttleLog } from '../util/log';
import { Pass } from 'three/examples/jsm/postprocessing/Pass.js';

/**
 * 1. add effekseer.min.js and effekseer.wasm to /assets
 * 2. enable plugin as usual
 * 3. use renderParticles or EffekseerRenderPass to render
 */

export type effekseerComponents = {
    position: Vector3;
    effectName: string;
    effectHandle: effekseer.EffekseerHandle;
    effectTarget: Object3D;
    // effectActive
};

class EffekseerLoader extends Loader {
    context: effekseer.EffekseerContext;

    constructor(manager: LoadingManager, context: effekseer.EffekseerContext) {
        super(manager);
        this.context = context;
    }

    load(
        url: string,
        onLoad?: (effect: effekseer.EffekseerEffect) => void,
        onProgress?,
        onError?: () => void
    ): effekseer.EffekseerEffect {
        if (this.path !== undefined) url = this.path + url;

        url = this.manager.resolveURL(url);

        const scope = this;

        const cached = Cache.get(url) as effekseer.EffekseerEffect;

        if (cached !== undefined) {
            scope.manager.itemStart(url);

            setTimeout(function () {
                if (onLoad) onLoad(cached);

                scope.manager.itemEnd(url);
            }, 0);

            return cached;
        }

        const effect = scope.context.loadEffect(
            url,
            1.0,
            function () {
                Cache.add(url, effect);

                if (onLoad) onLoad(effect);

                scope.manager.itemEnd(url);
            },
            onError
        );

        scope.manager.itemStart(url);

        return effect;
    }
    loadAsync(url: string) {
        return new Promise<effekseer.EffekseerEffect>((resolve, reject) => {
            return this.load(url, resolve, () => {}, reject);
        });
    }
}

export const effekseerComponentNames = [
    'position',
    'effectName',
    'effectHandle',
    'effectTarget',
];

const tempObject3D = new Object3D();
// TODO move loadingManager up to sprixle
export default async function applyEffekseerPlugin<
    ComponentTypes extends defaultComponentTypes & effekseerComponents
>(
    em: Manager<ComponentTypes>,
    renderer: WebGLRenderer,
    loadingManager: LoadingManager,
    { fastMode }: { fastMode: boolean } = { fastMode: false }
) {
    await new Promise<void>((resolve, reject) => {
        effekseer.initRuntime('assets/effekseer.wasm', resolve, reject);
    });

    const effekseerContext = effekseer.createContext();
    effekseerContext.init(renderer.getContext(), {
        enableTimerQuery: true, // enable GPU timer query
        onTimerQueryReport: (nanoTime) => {
            // called when GPU timer query is reported
            throttleLog(`Effekseer timer query report: ${nanoTime} ns`);
        },
        timerQueryReportIntervalCount: 60, // interval dray count to report GPU timer query
    });

    const effectLoader = new EffekseerLoader(loadingManager, effekseerContext);

    // TODO fast render mode?
    if (fastMode) {
        effekseerContext.setRestorationOfStatesFlag(false);
    }

    const effectQuery = em.createQuery({
        includes: ['effectName', 'position'],
    });

    return {
        effekseerContext,
        render: (camera: PerspectiveCamera) => {
            effekseerContext.setProjectionMatrix(
                camera.projectionMatrix.elements
            );
            effekseerContext.setCameraMatrix(
                camera.matrixWorldInverse.elements
            );
            effekseerContext.draw();
            if (fastMode) renderer.resetState();
        },
        system: em.createSystem(effectQuery.createConsumer(), {
            async new(entity) {
                if (entity.components.effectHandle) return;
                const { position, effectName } = entity.components;

                const effect = await effectLoader.loadAsync(effectName);

                const effectHandle = (entity.components.effectHandle =
                    effekseerContext.play(effect, 0, 0, 0));
                // effectHandle.setScale(0.3, 0.3, 0.3);
            },

            tick(delta) {
                effekseerContext.update(delta / 16.7);
            },

            all(entity) {
                const { position, effectHandle, effectTarget } =
                    entity.components;

                if (!effectHandle) return;

                if (!effectHandle.exists) {
                    // em.removeComponent(entity, 'effectHandle');
                    em.deregisterEntity(entity);
                    return;
                }

                if (effectTarget) {
                    tempObject3D.rotation.copy(effectTarget.rotation);
                    tempObject3D.position.copy(effectTarget.position);

                    tempObject3D.translateX(position.x);
                    tempObject3D.translateY(position.y);
                    tempObject3D.translateZ(position.z);

                    tempObject3D.updateMatrixWorld();
                    effectHandle.setMatrix(tempObject3D.matrixWorld.elements);
                } else {
                    effectHandle.setLocation(
                        position.x,
                        position.y,
                        position.z
                    );
                }
            },
        }),
    };
}

export class EffekseerRenderPass extends Pass {
    scene: Scene;
    camera: PerspectiveCamera;
    context: effekseer.EffekseerContext;

    constructor(
        scene: Scene,
        camera: PerspectiveCamera,
        context: effekseer.EffekseerContext
    ) {
        super();
        this.scene = scene;
        this.camera = camera;
        this.context = context;
        this.needsSwap = false;
    }
    render(renderer, writeBuffer, readBuffer /*, deltaTime, maskActive */) {
        renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
        this.context.setProjectionMatrix(this.camera.projectionMatrix.elements);
        this.context.setCameraMatrix(this.camera.matrixWorldInverse.elements);
        this.context.draw();
    }
}
