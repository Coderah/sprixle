// credit to https://github.com/pmndrs/drei/blob/master/src/web/Html.tsx

import {
    Camera,
    Matrix4,
    Object3D,
    OrthographicCamera,
    PerspectiveCamera,
    Raycaster,
    Vector2,
    Vector3,
    WebGLRenderer,
} from 'three';
import {
    EntityWithComponents,
    Keys,
    Manager,
    defaultComponentTypes,
} from '../ecs/manager';
import { Query } from '../ecs/query';
import { ConsumerSystem, Pipeline } from '../ecs/system';
import { interval } from '../util/timing';

const v1 = /* @__PURE__ */ new Vector3();
const v2 = /* @__PURE__ */ new Vector3();
const v3 = /* @__PURE__ */ new Vector3();
const v4 = /* @__PURE__ */ new Vector2();

function defaultCalculatePosition(
    el: Object3D,
    camera: Camera,
    size: { width: number; height: number }
) {
    const objectPos = v1.setFromMatrixPosition(el.matrixWorld);
    objectPos.project(camera);
    const widthHalf = size.width / 2;
    const heightHalf = size.height / 2;
    return [
        objectPos.x * widthHalf + widthHalf,
        -(objectPos.y * heightHalf) + heightHalf,
    ];
}

export type CalculatePosition = typeof defaultCalculatePosition;

function isObjectBehindCamera(el: Object3D, camera: Camera) {
    const objectPos = v1.setFromMatrixPosition(el.matrixWorld);
    const cameraPos = v2.setFromMatrixPosition(camera.matrixWorld);
    const deltaCamObj = objectPos.sub(cameraPos);
    const camDir = camera.getWorldDirection(v3);
    return deltaCamObj.angleTo(camDir) > Math.PI / 2;
}

function isObjectVisible(
    el: Object3D,
    camera: Camera,
    raycaster: Raycaster,
    occlude: Object3D[]
) {
    const elPos = v1.setFromMatrixPosition(el.matrixWorld);
    const screenPos = elPos.clone();
    screenPos.project(camera);
    v4.set(screenPos.x, screenPos.y);
    raycaster.setFromCamera(v4, camera);
    const intersects = raycaster.intersectObjects(occlude, true);
    if (intersects.length) {
        const intersectionDistance = intersects[0].distance;
        const pointDistance = elPos.distanceTo(raycaster.ray.origin);
        return pointDistance < intersectionDistance;
    }
    return true;
}

function objectScale(el: Object3D, camera: Camera) {
    if (camera instanceof OrthographicCamera) {
        return camera.zoom;
    } else if (camera instanceof PerspectiveCamera) {
        const objectPos = v1.setFromMatrixPosition(el.matrixWorld);
        const cameraPos = v2.setFromMatrixPosition(camera.matrixWorld);
        const vFOV = (camera.fov * Math.PI) / 180;
        const dist = objectPos.distanceTo(cameraPos);
        const scaleFOV = 2 * Math.tan(vFOV / 2) * dist;
        return 1 / scaleFOV;
    } else {
        return 1;
    }
}

function objectZIndex(
    el: Object3D,
    camera: Camera,
    zIndexRange: Array<number>
) {
    if (
        camera instanceof PerspectiveCamera ||
        camera instanceof OrthographicCamera
    ) {
        const objectPos = v1.setFromMatrixPosition(el.matrixWorld);
        const cameraPos = v2.setFromMatrixPosition(camera.matrixWorld);
        const dist = objectPos.distanceTo(cameraPos);
        const A =
            (zIndexRange[1] - zIndexRange[0]) / (camera.far - camera.near);
        const B = zIndexRange[1] - A * camera.far;
        return Math.round(A * dist + B);
    }
    return undefined;
}

const epsilon = (value: number) => (Math.abs(value) < 1e-10 ? 0 : value);

function getCSSMatrix(matrix: Matrix4, multipliers: number[], prepend = '') {
    let matrix3d = 'matrix3d(';
    for (let i = 0; i !== 16; i++) {
        matrix3d +=
            epsilon(multipliers[i] * matrix.elements[i]) +
            (i !== 15 ? ',' : ')');
    }
    return prepend + matrix3d;
}

const getCameraCSSMatrix = ((multipliers: number[]) => {
    return (matrix: Matrix4) => getCSSMatrix(matrix, multipliers);
})([1, -1, 1, 1, 1, -1, 1, 1, 1, -1, 1, 1, 1, -1, 1, 1]);

const getObjectCSSMatrix = ((scaleMultipliers: (n: number) => number[]) => {
    return (matrix: Matrix4, factor: number) =>
        getCSSMatrix(matrix, scaleMultipliers(factor), 'translate(-50%,-50%)');
})((f: number) => [
    1 / f,
    1 / f,
    1 / f,
    1,
    -1 / f,
    -1 / f,
    -1 / f,
    -1,
    1 / f,
    1 / f,
    1 / f,
    1,
    1,
    1,
    1,
    1,
]);

export type zUIComponents<ComponentTypes> = {
    object3D: Object3D;
    zUIElements: { [K in Keys<ComponentTypes>]?: HTMLElement };
};

type UIHandlers<
    ComponentTypes extends defaultComponentTypes &
        zUIComponents<ComponentTypes>,
    M extends Manager<ComponentTypes>,
    k extends keyof Partial<ComponentTypes>
> = {
    create?: (
        entity: EntityWithComponents<ComponentTypes, M, k | 'zUIElements'>
    ) => HTMLElement | undefined;
    update?: (
        uiElement: HTMLElement,
        entity: EntityWithComponents<ComponentTypes, M, k | 'zUIElements'>
    ) => void;
    removed?: (
        uiElement: HTMLElement,
        entity: EntityWithComponents<ComponentTypes, M, k | 'zUIElements'>
    ) => void;
    getObject3D?: (
        entity: EntityWithComponents<ComponentTypes, M, k | 'object3D'>
    ) => Object3D;
    getNeedsUpdate?: (
        entity: EntityWithComponents<ComponentTypes, M, k | 'object3D'>
    ) => boolean;
};

const size = new Vector2();
const tempVector = new Vector3();

// TODO implement options.transform (use matrix or simply position)
export const createZUISystem = <
    ComponentTypes extends defaultComponentTypes &
        zUIComponents<ComponentTypes>,
    M extends Manager<ComponentTypes>
>(
    em: M,
    parameters: {
        renderer: WebGLRenderer;
        camera: Camera;
        use3DTransforms?: boolean;
    },
    uiComponents: {
        [k in keyof Partial<ComponentTypes>]?: UIHandlers<ComponentTypes, M, k>;
    } = {},
    getObject3D = (
        entity: EntityWithComponents<ComponentTypes, M, 'object3D'>
    ) => entity.components.object3D,
    getNeedsUpdate = (
        entity: EntityWithComponents<ComponentTypes, M, 'zUIElements'>
    ) => true
) => {
    parameters = {
        use3DTransforms: false,
        ...parameters,
    };

    const { renderer, camera } = parameters;

    const cameraContainer = document.createElement('div');
    cameraContainer.className = 'camera-zui-container';

    function getInnerElement(entity: typeof em.Entity, component: string) {
        const elementID = `${entity.id}${component}`;
        let element: HTMLElement = cameraContainer.querySelector(
            `[data-id="${elementID}"]`
        );

        if (!element) {
            element = document.createElement('div');
            element.dataset.id = elementID;
            cameraContainer.append(element);
        }

        return element;
    }

    // TODO performance check
    const pipeline = new Pipeline(em);
    pipeline.tag = 'zUIPipeline';

    if (parameters.use3DTransforms) {
        pipeline.systems.add(
            em.createSystem({
                tick() {
                    renderer.getSize(size);

                    const [widthHalf, heightHalf] = [
                        size.width / 2,
                        size.height / 2,
                    ];
                    const fov =
                        camera.projectionMatrix.elements[5] * heightHalf;
                    const { isOrthographicCamera, top, left, bottom, right } =
                        camera as OrthographicCamera;

                    const cameraMatrix = getCameraCSSMatrix(
                        camera.matrixWorldInverse
                    );
                    const cameraTransform = isOrthographicCamera
                        ? `scale(${fov})translate(${epsilon(
                              -(right + left) / 2
                          )}px,${epsilon((top + bottom) / 2)}px)`
                        : `translateZ(${fov}px)`;

                    cameraContainer.style.transform = `${cameraTransform}${cameraMatrix}translate(${widthHalf}px,${heightHalf}px)`;
                    cameraContainer.style.transformStyle = 'preserve-3d';
                    cameraContainer.style.width = size.width + 'px';
                    cameraContainer.style.height = size.height + 'px';
                },
            })
        );
    }

    function add<
        Includes extends Keys<ComponentTypes>[],
        Q extends Query<ComponentTypes, Includes, M, IndexedComponent>,
        IndexedComponent extends Keys<ComponentTypes>
    >(
        component: IndexedComponent,
        query: Q & Query<ComponentTypes, Includes, M, IndexedComponent>,
        handlers: UIHandlers<ComponentTypes, M, IndexedComponent>
    ) {
        const { create, update } = handlers;

        function handleCreate(entity: typeof query.Entity) {
            let zUIElements = entity.components.zUIElements;
            if (!create || zUIElements?.[component])
                return zUIElements?.[component];
            if (!zUIElements) entity.components.zUIElements = zUIElements = {};

            const uiElement = create(entity);

            if (!uiElement) return;
            zUIElements[component] = uiElement;

            entity.flagUpdate('zUIElements');

            if (parameters.use3DTransforms) {
                const innerElement = getInnerElement(entity, component);
                const innerMostElement = document.createElement('div');
                innerMostElement.append(uiElement);
                innerElement.append(innerMostElement);
                cameraContainer.append(innerElement);
            }

            return uiElement;

            // for (const component in uiComponents) {
            //     if (component in entity.components) {
            //         uiComponents[component]?.update?.(
            //             uiElement,
            //             entity
            //         );
            //     }
            // }
        }

        function handlePositioning(
            entity: typeof query.Entity,
            element?: HTMLElement
        ) {
            const needsUpdate = (handlers.getNeedsUpdate || getNeedsUpdate)(
                entity
            );

            if (!needsUpdate) return;

            const object3D = (handlers.getObject3D || getObject3D)(entity);

            if (!object3D) return;

            object3D.updateWorldMatrix(true, true);

            if (!parameters.use3DTransforms) {
                if (!element) return;
                object3D.getWorldPosition(tempVector);
                tempVector.project(camera);
                const x = Math.round(
                    (0.5 + tempVector.x / 2) * renderer.domElement.width
                );
                const y = Math.round(
                    (0.5 - tempVector.y / 2) * renderer.domElement.height
                );

                element.style.position = 'absolute';
                element.style.left = x + 'px';
                element.style.top = y + 'px';
                element.style.transform = `translate(-50%, -50%)`;

                return;
            }

            // object3d.update
            const innerElement = getInnerElement(entity, component);

            innerElement.style.transform = getObjectCSSMatrix(
                object3D.matrixWorld,
                1 / (10 / 400)
            );
            innerElement.style.transformStyle = 'preserve-3d';
            innerElement.style.position = 'absolute';
            innerElement.style.top = innerElement.style.left = '0px';

            const [widthHalf, heightHalf] = [size.width / 2, size.height / 2];
            const fov = camera.projectionMatrix.elements[5] * heightHalf;
            const innerMostElement = innerElement.children[0] as HTMLElement;

            innerMostElement.style.width = size.width + 'px';
            innerMostElement.style.height = size.height + 'px';
            innerMostElement.style.position = 'absolute';
            innerMostElement.style.top = innerMostElement.style.left = '0px';
            innerMostElement.style.perspective =
                camera instanceof OrthographicCamera ? '' : `${fov}px`;
        }

        pipeline.systems.add(
            em.createSystem(query.createConsumer(), {
                newOrUpdated(entity) {
                    const element = handleCreate(entity);

                    if (update) update(element, entity);
                },
                all(entity) {
                    const element = entity.components.zUIElements?.[component];

                    handlePositioning(entity, element);
                },
                // TODO
                // removed(entity) {
                //     entity.components.zUIElements?.[component].remove();
                //     delete entity.components.zUIElements?.[component];

                //     if (handlers.removed)
                //         handlers.removed(entity.components.uiElement, entity);
                // },
            }) as ConsumerSystem<ComponentTypes, Keys<ComponentTypes>[], M>
        );
    }

    for (const component in uiComponents) {
        const uiComponent = uiComponents[component];
        if (!uiComponent) continue;

        const includes: (keyof ComponentTypes)[] = [component];
        if (!uiComponent.create) {
            includes.push('uiElement');
        }

        const componentQuery = em.createQuery({
            includes,
        });

        add(component, componentQuery, uiComponent);
    }

    return { add, pipeline, cameraContainer };
};
