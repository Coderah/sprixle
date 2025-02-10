import { Camera, Plane, Raycaster, Vector2, Vector3 } from 'three';
import {
    defaultComponentTypes,
    EntityWithComponents,
    Manager,
} from '../ecs/manager';
import { now } from '../util/now';
import { Pipeline } from '../ecs/system';
import { throttleLog } from '../util/log';

const mouseButtons = {
    0: 'Left',
    1: 'Middle',
    2: 'Right',
};

export type InputTypes = 'keyboard' | 'touch' | 'mouse' | 'gamepad';
export type Input =
    | `Key${string}`
    | `Mouse${string}`
    | `Touch${number}`
    | `Gamepad${string}`;

const gamepadButtons = [
    'A',
    'B',
    'X',
    'Y',
    'L1',
    'R1',
    'L2',
    'R2',
    'Select',
    'Start',
    'LB',
    'RB',
    'DUp',
    'DDown',
    'DLeft',
    'DRight',
];

// TODO allow normal to be modified
export const inputPlane = new Plane(new Vector3(0, -0.5, 0), 0.5);
export const inputRaycaster = new Raycaster();
inputRaycaster.layers.enableAll();
const intersectPoint = new Vector3();

const worldMousePosition = new Vector3();
const screenMousePosition = new Vector2();
const ndcMousePosition = new Vector2();

export const inputState = {
    screenMousePosition,
    ndcMousePosition,
    worldMousePosition,
    worldMouseY: 0.5,
};

window['inputState'] = inputState;

interface InputPluginOptions {
    useThreeForWorldPosition?: boolean;
    threeCamera?: Camera;
    allowOtherMouseEvents?: boolean;
}

export type InputComponents = {
    /** used to indicate an input binding (map multiple inputs and input types to a name) */
    inputBindName: string;
    /** the list of inputs that trigger a binding, must be paired with @inputBindName */
    inputBinds: Input[];
    /** determines activation type, defaults to press */
    inputBindActivationType: 'release' | 'press' | 'held';
    /** defines how long this binding must be held to repeat, does not repeat if not present */
    inputBindRepeat: number;

    /** indicates a raw input, will be paired with @inputState */
    inputName: Input;
    /** used internally. maps raw inputs to bind entities */
    inputBindIds: string[];

    /** used on both raw and bound inputs to indicate state and position */
    inputState: number | null;
    inputPosition: number | number[];

    activeInputMode: 'touch' | 'pointer' | 'keyboard' | 'gamepad';
};

export function applyInputPlugin<
    ComponentTypes extends defaultComponentTypes & InputComponents
>(manager: Manager<ComponentTypes>, options?: InputPluginOptions) {
    const inputBindingQuery = manager.createQuery({
        includes: ['inputBindName', 'inputBinds'],
    });
    const inputBindStateQuery = manager.createQuery({
        includes: ['inputBindName', 'inputState'],
    });
    const rawInputQuery = manager.createQuery({
        includes: ['inputName', 'inputState'],
        excludes: ['inputBindName'],
    });
    const inputBindStateQueryConsumer = inputBindStateQuery.createConsumer();

    const bindEntities = new Set<typeof manager.Entity>();

    function createBindEntityId(bindName: string) {
        return 'bind' + bindName;
    }

    function createInputEntityId(inputName: string) {
        return 'input' + inputName;
    }

    return {
        inputActiveModeSystem: manager.createSystem(
            rawInputQuery.createConsumer(),
            {
                init() {
                    manager.setSingletonEntityComponent(
                        'activeInputMode',
                        'pointer'
                    );
                },
                updated(entity) {
                    if (entity.components.inputName.startsWith('Mouse')) {
                        manager.setSingletonEntityComponent(
                            'activeInputMode',
                            'pointer'
                        );
                    } else if (
                        entity.components.inputName.startsWith('Touch')
                    ) {
                        manager.setSingletonEntityComponent(
                            'activeInputMode',
                            'touch'
                        );
                    } else if (
                        entity.components.inputName.startsWith('Gamepad')
                    ) {
                        manager.setSingletonEntityComponent(
                            'activeInputMode',
                            'gamepad'
                        );
                    } else {
                        manager.setSingletonEntityComponent(
                            'activeInputMode',
                            'keyboard'
                        );
                    }
                },
            }
        ),
        triggerInputBind(bindName: string) {
            const binding = manager.getEntity(createBindEntityId(bindName));
            if (!binding) {
                console.warn(
                    '[InputPlugin] attempted to trigger unknown binding',
                    bindName
                );
                return;
            }

            binding.components.inputState = now();
        },
        getInputState(input: InputComponents['inputName']) {
            const entity = manager.getEntity(createInputEntityId(input));

            if (!entity) return null;

            return entity.components.inputState;
        },
        getBindState(bindName: string) {
            const entity = manager.getEntity(createBindEntityId(bindName));

            if (!entity) return null;

            return entity.components.inputState;
        },
        resetInputBinds() {
            inputBindStateQuery.for((entity) => {
                entity.components.inputState = null;
            });
        },
        initInput(domElement: HTMLElement) {
            screenMousePosition.set(
                window.innerWidth / 2,
                window.innerHeight / 2
            );
            const handleMouseMove = (event: MouseEvent | TouchEvent) => {
                if (event instanceof MouseEvent) {
                    screenMousePosition.set(event.clientX, event.clientY);
                } else {
                    // const bounding = domElement.getBoundingClientRect();
                    screenMousePosition.set(
                        event.touches[0].clientX,
                        event.touches[0].clientY
                    );
                }
            };

            const handleMouseDown = (event: MouseEvent) => {
                if (
                    event.currentTarget === domElement &&
                    !options?.allowOtherMouseEvents
                ) {
                    event.preventDefault();
                }

                let mouseButton =
                    event.button in mouseButtons
                        ? 'Mouse' + mouseButtons[event.button]
                        : 'Mouse' + event.button;
                const entity =
                    manager.getEntity(createInputEntityId(mouseButton)) ||
                    manager.createEntity(createInputEntityId(mouseButton));
                entity.components.inputName = mouseButton as Input;
                entity.components.inputState = now();
                manager.registerEntity(entity);
            };

            const handleMouseUp = (event: MouseEvent) => {
                if (
                    event.currentTarget === domElement &&
                    !options?.allowOtherMouseEvents
                ) {
                    event.preventDefault();
                }
                let mouseButton =
                    event.button in mouseButtons
                        ? 'Mouse' + mouseButtons[event.button]
                        : 'Mouse' + event.button;
                const entity =
                    manager.getEntity(createInputEntityId(mouseButton)) ||
                    manager.createEntity(createInputEntityId(mouseButton));
                entity.components.inputName = mouseButton as Input;
                entity.components.inputState = null;
                manager.registerEntity(entity);
            };

            const handleTouchStart = (event: TouchEvent) => {
                if (event.currentTarget === domElement) {
                    event.preventDefault();
                    event.stopPropagation();
                    event.stopImmediatePropagation();
                }

                // const bounding = domElement.getBoundingClientRect();
                screenMousePosition.set(
                    event.touches[0].clientX,
                    event.touches[0].clientY
                );

                let touchIdentifier = 'Touch0';
                const entity =
                    manager.getEntity(createInputEntityId(touchIdentifier)) ||
                    manager.createEntity(createInputEntityId(touchIdentifier));
                entity.components.inputName = touchIdentifier as Input;
                entity.components.inputState = now();
                manager.registerEntity(entity);
            };

            const handleTouchEnd = (event: TouchEvent) => {
                if (event.currentTarget === domElement) {
                    event.preventDefault();
                    event.stopPropagation();
                    event.stopImmediatePropagation();
                }
                let touchIdentifier = 'Touch0';
                const entity =
                    manager.getEntity(createInputEntityId(touchIdentifier)) ||
                    manager.createEntity(createInputEntityId(touchIdentifier));
                entity.components.inputName = touchIdentifier as Input;
                entity.components.inputState = null;
                manager.registerEntity(entity);
            };

            const handleKeyDown = (event: KeyboardEvent) => {
                if (event.repeat) return;
                const key = ('Key' + event.code.replace('Key', '')) as Input;
                const entity =
                    manager.getEntity(createInputEntityId(key)) ||
                    manager.createEntity(createInputEntityId(key));
                entity.components.inputName = key;
                entity.components.inputState = now();
                manager.registerEntity(entity);
            };

            const handleKeyUp = (event: KeyboardEvent) => {
                const key = ('Key' + event.code.replace('Key', '')) as Input;
                const entity =
                    manager.getEntity(createInputEntityId(key)) ||
                    manager.createEntity(createInputEntityId(key));
                entity.components.inputName = key;
                entity.components.inputState = null;
                manager.registerEntity(entity);
            };

            domElement.addEventListener('contextmenu', (event) =>
                event.preventDefault()
            );

            document.addEventListener('keyup', handleKeyUp);
            document.addEventListener('keydown', handleKeyDown);
            domElement.addEventListener('touchstart', handleTouchStart);
            domElement.addEventListener('touchend', handleTouchEnd);
            domElement.addEventListener('mousedown', handleMouseDown);
            domElement.addEventListener('mouseup', handleMouseUp);
            domElement.addEventListener('dragend', handleMouseUp);
            domElement.addEventListener('mousemove', handleMouseMove);
            domElement.addEventListener('touchmove', handleMouseMove);
            domElement.addEventListener('mouseleave', handleMouseMove);
        },

        /** this system handles and propagates raw inputs to bindings, ensure it is run before any binding handler systems */
        inputSystem: new Pipeline(
            manager,
            // raw input system
            manager.createSystem(rawInputQuery.createConsumer(), {
                forNew(entity) {
                    entity.components.inputBindIds = [];
                    // TODO map raw input to binds
                    manager.getEntities('inputBinds').forEach((bindEntity) => {
                        if (
                            bindEntity.components.inputBinds.indexOf(
                                entity.components.inputName
                            ) > -1
                        ) {
                            entity.components.inputBindIds?.push(bindEntity.id);

                            bindEntity.components.inputState =
                                entity.components.inputState;
                            // ensure this is always treated as an update to avoid release binds that overlap multiple other binds
                            bindEntity.flagUpdate('inputState');
                            bindEntity.components.inputPosition =
                                entity.components.inputPosition;
                            bindEntity.components.inputName =
                                entity.components.inputName;
                        }
                    });
                },
                updated(entity, delta) {
                    entity.components.inputBindIds?.forEach((bindId) => {
                        const bindEntity = manager.getEntity(bindId);

                        if (bindEntity) {
                            // prevent de-triggering when another button has the bind active
                            if (
                                !entity.components.inputState &&
                                bindEntity.components.inputName !==
                                    entity.components.inputName
                            ) {
                                return;
                            }

                            const otherActiveInput =
                                bindEntity.components.inputBinds?.find(
                                    (key) =>
                                        manager.getEntity(
                                            createInputEntityId(key)
                                        )?.components.inputState
                                );

                            if (
                                !entity.components.inputState &&
                                otherActiveInput
                            ) {
                                // Find another input that would still keep this active and allow it to take over
                                bindEntity.components.inputName =
                                    otherActiveInput;

                                // TODO do we need to copy other components?
                            } else {
                                bindEntity.components.inputState =
                                    entity.components.inputState;
                                // ensure this is always treated as an update to avoid release binds that overlap multiple other binds
                                bindEntity.flagUpdate('inputState');
                                bindEntity.components.inputPosition =
                                    entity.components.inputPosition;
                                bindEntity.components.inputName =
                                    entity.components.inputName;
                            }
                        }
                    });
                },

                tick() {
                    if (options?.useThreeForWorldPosition) {
                        ndcMousePosition.set(
                            (screenMousePosition.x / window.innerWidth) * 2 - 1,
                            -(screenMousePosition.y / window.innerHeight) * 2 +
                                1
                        );
                        inputRaycaster.setFromCamera(
                            ndcMousePosition,
                            options.threeCamera
                        );
                        inputPlane.setComponents(
                            0,
                            1,
                            0,
                            -inputState.worldMouseY
                        );
                        inputRaycaster.ray.intersectPlane(
                            inputPlane,
                            intersectPoint
                        );

                        worldMousePosition.copy(intersectPoint);
                    }

                    // TODO support multiple players
                    const gamepad = navigator
                        .getGamepads?.()
                        ?.find((g) => g?.connected);

                    if (gamepad) {
                        gamepad.buttons.forEach((button, index) => {
                            const key = ('Gamepad' +
                                gamepadButtons[index]) as Input;
                            const entity =
                                manager.getEntity(createInputEntityId(key)) ||
                                manager.createEntity(createInputEntityId(key));
                            entity.components.inputName = key;
                            if (
                                (button.pressed &&
                                    entity.components.inputState) ||
                                (!button.pressed &&
                                    !entity.components.inputState)
                            ) {
                                return;
                            }
                            entity.components.inputState = button.pressed
                                ? now()
                                : null;

                            if (button.value) {
                                entity.components.inputPosition = button.value;
                            }
                            manager.registerEntity(entity);
                        });

                        // TODO improve repeating code for positive and negative shortcut inputs
                        gamepad.axes.forEach((axis, index) => {
                            const key = ('GamepadAxis' + index) as Input;
                            const positiveKey = (key + 'Positive') as Input;
                            const negativeKey = (key + 'Negative') as Input;
                            const entity =
                                manager.getEntity(createInputEntityId(key)) ||
                                manager.createEntity(createInputEntityId(key));
                            entity.components.inputName = key;

                            const positiveEntity =
                                manager.getEntity(
                                    createInputEntityId(positiveKey)
                                ) ||
                                manager.createEntity(
                                    createInputEntityId(positiveKey)
                                );
                            positiveEntity.components.inputName = positiveKey;
                            const negativeEntity =
                                manager.getEntity(
                                    createInputEntityId(negativeKey)
                                ) ||
                                manager.createEntity(
                                    createInputEntityId(negativeKey)
                                );
                            negativeEntity.components.inputName = negativeKey;

                            if (
                                Math.abs(axis) > 0.05 &&
                                entity.components.inputState
                            ) {
                                // return;
                            } else {
                                entity.components.inputState =
                                    Math.abs(axis) > 0.05 ? now() : null;
                            }

                            if (
                                axis > 0.5 &&
                                positiveEntity.components.inputState
                            ) {
                                // return;
                            } else {
                                positiveEntity.components.inputState =
                                    axis > 0.5 ? now() : null;
                            }

                            if (
                                axis < -0.5 &&
                                negativeEntity.components.inputState
                            ) {
                                // return;
                            } else {
                                negativeEntity.components.inputState =
                                    axis < -0.5 ? now() : null;
                            }

                            // improve inputPosition lookups, should map to all bindings more efficiently
                            entity.quietSet('inputPosition', axis);

                            entity.components.inputBindIds?.forEach(
                                (bindId) => {
                                    const bindEntity =
                                        manager.getEntity(bindId);

                                    bindEntity?.quietSet('inputPosition', axis);
                                }
                            );

                            positiveEntity.quietSet('inputPosition', axis);
                            negativeEntity.quietSet('inputPosition', axis);

                            manager.registerEntity(entity);
                            manager.registerEntity(positiveEntity);
                            manager.registerEntity(negativeEntity);
                        });
                    }
                },
            }),

            // bound inputs system
            manager.createSystem(inputBindingQuery.createConsumer(), {
                init() {
                    bindEntities.forEach((entity) =>
                        manager.registerEntity(entity)
                    );
                },
                forNew(entity) {
                    // TODO update existing raw inputs to include bind if necessary
                },
                updated(entity) {
                    // TODO update existing raw inputs to include bind if necessary
                },
            })
        ),

        upsertInputBinds(bindings: {
            [bindName: string]: {
                inputBinds: Input[];
                inputBindRepeat?: number;
                inputBindActivationType?: InputComponents['inputBindActivationType'];
            };
        }) {
            const entities: { [bindName: string]: typeof manager.Entity } = {};

            for (let bindName in bindings) {
                const bind = bindings[bindName];

                const entityId = createBindEntityId(bindName);
                const entity =
                    manager.getEntity(entityId) ||
                    manager.createEntity(entityId);

                manager.addComponents(entity, {
                    inputBindActivationType: 'press',
                    ...bind,
                    inputBindName: bindName,
                    inputState: null,
                } as Partial<ComponentTypes>);

                manager.registerEntity(entity);

                entities[bindName] = entity;
                bindEntities.add(entity);
            }

            return entities;
        },
        createInputBindHandlers(
            bindHandlers: {
                [bindName: string]: (
                    bindEntity: EntityWithComponents<
                        ComponentTypes,
                        Manager<ComponentTypes>,
                        'inputName'
                    >,
                    delta: number
                ) => void;
            },
            releaseHandlers?: {
                [bindName: string]: (
                    bindEntity: EntityWithComponents<
                        ComponentTypes,
                        Manager<ComponentTypes>,
                        'inputName'
                    >,
                    delta: number
                ) => void;
            },
            // TODO this is a hacky fix, sometimes you want key bind handler isolation other times you don't... how to resolve this?!
            uniqueConsumer: boolean = false
        ) {
            const consumer = uniqueConsumer
                ? inputBindStateQuery.createConsumer()
                : inputBindStateQueryConsumer;
            // Utilizing a standard query system and internally checking consumer.updatedEntities for improved performance (fewer loops)
            return manager.createSystem(inputBindStateQuery, {
                all(entity, delta) {
                    const handler =
                        bindHandlers[entity.components.inputBindName];
                    const releaseHandler =
                        releaseHandlers?.[entity.components.inputBindName];

                    if (!handler) return;

                    const wasUpdated = consumer.updatedEntities.has(entity.id);

                    if (wasUpdated && entity.components.inputState === null) {
                        if (
                            entity.components.inputBindActivationType ===
                            'release'
                        ) {
                            handler(entity, delta);
                        } else if (releaseHandler) {
                            releaseHandler(entity, delta);
                        }
                    } else if (entity.components.inputState) {
                        if (
                            entity.components.inputBindActivationType === 'held'
                        ) {
                            handler(entity, delta);
                        } else if (
                            entity.components.inputBindActivationType ===
                            'press'
                        ) {
                            let handle = wasUpdated;

                            if (!handle && entity.components.inputBindRepeat) {
                                if (
                                    now() - entity.components.inputState >
                                    entity.components.inputBindRepeat
                                ) {
                                    entity.quietSet('inputState', now());
                                    handle = true;
                                }
                            }

                            if (handle) handler(entity, delta);
                        }
                    }

                    consumer.updatedEntities.delete(entity.id);
                },
            });
        },

        rawInputQuery,
    };
}
