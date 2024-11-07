/// <reference path="./effekseer/effekseer.d.ts" />
import {
    Cache,
    Camera,
    Loader,
    LoadingManager,
    Object3D,
    PerspectiveCamera,
    Scene,
    Vector2,
    Vector3,
    WebGLRenderer,
} from 'three';
import { defaultComponentTypes, Manager } from '../ecs/manager';
import { throttleLog } from '../util/log';
import { Pass } from 'three/examples/jsm/postprocessing/Pass.js';

Cache.enabled = true;

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
            if (onLoad) onLoad(cached);
            return cached;
        }

        scope.manager.itemStart(url);
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
// TODO preload effects api
// TODO move loadingManager up to sprixle
export default async function applyEffekseerPlugin<
    ComponentTypes extends defaultComponentTypes & effekseerComponents
>(
    em: Manager<ComponentTypes>,
    renderer: WebGLRenderer,
    loadingManager: LoadingManager,
    { fastMode }: { fastMode: boolean } = { fastMode: false }
) {
    loadingManager.itemStart('effekseer wasm initialization');
    await new Promise<void>((resolve, reject) => {
        effekseer.initRuntime('assets/effekseer.wasm', resolve, reject);
    });
    loadingManager.itemEnd('effekseer wasm initialization');
    effekseer.setLogEnabled(true);

    const effekseerContext = effekseer.createContext();
    // console.log('renderer context attributes', renderer.);

    effekseerContext.init(renderer.getContext(), {
        premultipliedAlpha: true,
        // enableTimerQuery: true, // enable GPU timer query
        // onTimerQueryReport: (nanoTime) => {
        //     // called when GPU timer query is reported
        //     console.log(`Effekseer timer query report: ${nanoTime} ns`);
        // },
        // timerQueryReportIntervalCount: 60, // interval dray count to report GPU timer query
    });

    // NOTE: has to be called outside of any real rendering loop to be initialized the first time, otherwise it will error out.
    // effekseerContext.captureDepth();

    const effectLoader = new EffekseerLoader(loadingManager, effekseerContext);

    // TODO fast render mode?
    if (fastMode) {
        effekseerContext.setRestorationOfStatesFlag(false);
    }

    const effectQuery = em.createQuery({
        includes: ['effectName', 'position'],
    });

    function positionEffect(entity: typeof effectQuery.Entity) {
        const { position, effectHandle, effectTarget } = entity.components;

        if (!effectHandle) return;

        if (!effectHandle.exists) {
            // em.removeComponent(entity, 'effectHandle');
            em.deregisterEntity(entity);
            return;
        }

        if (effectTarget) {
            tempObject3D.position.copy(effectTarget.position);
            tempObject3D.rotation.copy(effectTarget.rotation);

            tempObject3D.translateX(position.x);
            tempObject3D.translateY(position.y);
            tempObject3D.translateZ(position.z);

            tempObject3D.updateMatrixWorld();
            effectHandle.setMatrix(tempObject3D.matrixWorld.elements);
        } else {
            effectHandle.setLocation(position.x, position.y, position.z);
        }
    }

    return {
        effekseerContext,
        render: (camera: PerspectiveCamera) => {
            effekseerContext.setProjectionMatrix(
                camera.projectionMatrix.elements
            );
            effekseerContext.setCameraMatrix(
                camera.matrixWorldInverse.elements
            );
            // const size = new Vector2();
            // const target = renderer.getRenderTarget();
            // if (target) {
            //     size.set(target.width, target.height);
            // } else {
            //     renderer.getSize(size);
            // }
            // renderer.getContext().viewport(0, 0, size.width, size.height);
            // effekseerContext.captureBackground(0, 0, size.x, size.y);
            // effekseerContext.captureDepth(size.width, size.height);
            effekseerContext.draw();
            if (fastMode) renderer.resetState();
        },
        system: em.createSystem(effectQuery.createConsumer(), {
            async forNew(entity) {
                if (entity.components.effectHandle) return;
                const { position, effectName } = entity.components;

                const effect = await effectLoader.loadAsync(effectName);

                entity.components.effectHandle = effekseerContext.play(
                    effect,
                    0,
                    0,
                    0
                );
                positionEffect(entity);
                // effectHandle.setScale(0.3, 0.3, 0.3);
            },

            tick(delta) {
                effekseerContext.update(delta / 16.7);
            },

            all(entity) {
                positionEffect(entity);
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
        this.clear = false;
    }
    render(renderer, writeBuffer, readBuffer /*, deltaTime, maskActive */) {
        renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
        this.context.setProjectionMatrix(this.camera.projectionMatrix.elements);
        this.context.setCameraMatrix(this.camera.matrixWorldInverse.elements);
        // const size = renderer.getSize(new Vector2());
        // renderer.getContext().viewport(0, 0, size.width, size.height);
        // this.context.captureBackground(0, 0, size.x, size.y);
        this.context.draw();
    }
}
