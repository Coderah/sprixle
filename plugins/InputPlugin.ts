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
const plane = new Plane(new Vector3(0, 0, 1), 1);
export const raycaster = new Raycaster();
raycaster.layers.enableAll();
const intersectPoint = new Vector3();

const worldMousePosition = new Vector3();
const screenMousePosition = new Vector2();

export const inputState = {
    screenMousePosition,
    worldMousePosition,
};

window['inputState'] = inputState;

interface InputPluginOptions {
    useThreeForWorldPosition?: boolean;
    threeCamera: Camera;
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
};

export const INPUT_COMPONENT_DEFAULTS: InputComponents = {
    inputBindName: '',
    inputBindActivationType: 'press',
    inputBinds: [],
    inputBindRepeat: 500,
    inputName: 'MouseLeft',
    inputBindIds: [],
    inputState: null,
    inputPosition: [],
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
    });
    const inputBindStateQueryConsumer = inputBindStateQuery.createConsumer();

    const bindEntities = new Set<typeof manager.Entity>();

    return {
        triggerInputBind(bindName: string) {
            const binding = manager.getEntity('bind' + bindName);
            if (!binding) {
                console.warn(
                    '[InputPlugin] attempted to trigger unknown binding',
                    bindName
                );
                return;
            }

            binding.components.inputState = now();
        },
        resetInputBinds() {
            inputBindStateQuery.for((entity) => {
                entity.components.inputState = null;
            });
        },
        initInput(domElement: HTMLElement) {
            const handleMouseMove = (event: MouseEvent | TouchEvent) => {
                if (event instanceof MouseEvent) {
                    screenMousePosition.set(event.clientX, event.clientY);
                } else {
                    const bounding = domElement.getBoundingClientRect();
                    screenMousePosition.set(
                        event.touches[0].clientX - bounding.left,
                        event.touches[0].clientY - bounding.right
                    );
                }
            };

            const handleMouseDown = (event: MouseEvent) => {
                if (event.currentTarget === domElement) {
                    event.preventDefault();
                }

                let mouseButton =
                    event.button in mouseButtons
                        ? 'Mouse' + mouseButtons[event.button]
                        : 'Mouse' + event.button;
                const entity =
                    manager.getEntity('input' + mouseButton) ||
                    manager.createEntity('input' + mouseButton);
                entity.components.inputName = mouseButton as Input;
                entity.components.inputState = now();
                manager.registerEntity(entity);
            };

            const handleMouseUp = (event: MouseEvent) => {
                if (event.currentTarget === domElement) {
                    event.preventDefault();
                }
                let mouseButton =
                    event.button in mouseButtons
                        ? 'Mouse' + mouseButtons[event.button]
                        : 'Mouse' + event.button;
                const entity =
                    manager.getEntity('input' + mouseButton) ||
                    manager.createEntity('input' + mouseButton);
                entity.components.inputName = mouseButton as Input;
                entity.components.inputState = null;
                manager.registerEntity(entity);
            };

            const handleTouchStart = (event: TouchEvent) => {
                if (event.currentTarget === domElement) {
                    event.preventDefault();
                }

                const bounding = domElement.getBoundingClientRect();
                screenMousePosition.set(
                    event.touches[0].clientX - bounding.left,
                    event.touches[0].clientY - bounding.right
                );

                let touchIdentifier = 'Touch0';
                const entity =
                    manager.getEntity('input' + touchIdentifier) ||
                    manager.createEntity('input' + touchIdentifier);
                entity.components.inputName = touchIdentifier as Input;
                entity.components.inputState = now();
                manager.registerEntity(entity);
            };

            const handleTouchEnd = (event: TouchEvent) => {
                if (event.currentTarget === domElement) {
                    event.preventDefault();
                }
                let touchIdentifier = 'Touch0';
                const entity =
                    manager.getEntity('input' + touchIdentifier) ||
                    manager.createEntity('input' + touchIdentifier);
                entity.components.inputName = touchIdentifier as Input;
                entity.components.inputState = null;
                manager.registerEntity(entity);
            };

            const handleKeyDown = (event: KeyboardEvent) => {
                if (event.repeat) return;
                const key = ('Key' + event.code.replace('Key', '')) as Input;
                const entity =
                    manager.getEntity('input' + key) ||
                    manager.createEntity('input' + key);
                entity.components.inputName = key;
                entity.components.inputState = now();
                manager.registerEntity(entity);
            };

            const handleKeyUp = (event: KeyboardEvent) => {
                const key = ('Key' + event.code.replace('Key', '')) as Input;
                const entity =
                    manager.getEntity('input' + key) ||
                    manager.createEntity('input' + key);
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
                new(entity) {
                    entity.components.inputBindIds = [];
                    // TODO map raw input to binds
                    manager.getEntities('inputBinds').forEach((bindEntity) => {
                        if (
                            bindEntity.components.inputBinds.indexOf(
                                entity.components.inputName
                            ) > -1
                        ) {
                            entity.components.inputBindIds?.push(bindEntity.id);
                        }
                    });
                },

                tick() {
                    if (options?.useThreeForWorldPosition) {
                        raycaster.setFromCamera(
                            {
                                x:
                                    (screenMousePosition.x /
                                        window.innerWidth) *
                                        2 -
                                    1,
                                y:
                                    -(
                                        screenMousePosition.y /
                                        window.innerHeight
                                    ) *
                                        2 +
                                    1,
                            },
                            options.threeCamera
                        );
                        raycaster.ray.intersectPlane(plane, intersectPoint);

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
                                manager.getEntity('input' + key) ||
                                manager.createEntity('input' + key);
                            entity.components.inputName = key;
                            // TODO handle axis
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
                                manager.getEntity('input' + key) ||
                                manager.createEntity('input' + key);
                            entity.components.inputName = key;

                            const positiveEntity =
                                manager.getEntity('input' + positiveKey) ||
                                manager.createEntity('input' + positiveKey);
                            positiveEntity.components.inputName = positiveKey;
                            const negativeEntity =
                                manager.getEntity('input' + negativeKey) ||
                                manager.createEntity('input' + negativeKey);
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
                            positiveEntity.quietSet('inputPosition', axis);
                            negativeEntity.quietSet('inputPosition', axis);

                            manager.registerEntity(entity);
                            manager.registerEntity(positiveEntity);
                            manager.registerEntity(negativeEntity);
                        });
                    }
                },

                updated(entity, delta) {
                    entity.components.inputBindIds?.forEach((bindId) => {
                        const bindEntity = manager.getEntity(bindId);

                        if (bindEntity) {
                            bindEntity.components.inputState =
                                entity.components.inputState;
                            // ensure this is always treated as an update to avoid release binds that overlap multiple other binds
                            bindEntity.flagUpdate('inputState');
                            bindEntity.components.inputPosition =
                                entity.components.inputPosition;
                        }
                    });
                },
            }),

            // bound inputs system
            manager.createSystem(inputBindingQuery.createConsumer(), {
                init() {
                    bindEntities.forEach((entity) =>
                        manager.registerEntity(entity)
                    );
                },
                new(entity) {
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

                const entityId = 'bind' + bindName;
                const entity =
                    manager.getEntity(entityId) ||
                    manager.createEntity(entityId);

                manager.addComponents(entity, {
                    inputBindActivationType:
                        INPUT_COMPONENT_DEFAULTS['inputBindActivationType'],
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

                    if (!handler) return;

                    const wasUpdated = consumer.updatedEntities.has(entity.id);

                    if (wasUpdated && entity.components.inputState === null) {
                        if (
                            entity.components.inputBindActivationType ===
                            'release'
                        ) {
                            handler(entity, delta);
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
