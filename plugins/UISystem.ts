import { map } from 'lodash';
import {
    EntityWithComponents,
    Keys,
    Manager,
    defaultComponentTypes,
} from '../ecs/manager';
import { ConsumerSystem, Pipeline, System } from '../ecs/system';
import { Query } from '../ecs/query';

export const createUISystem = <
    ComponentTypes extends defaultComponentTypes & {
        uiElement: HTMLElement;
    },
    M extends Manager<ComponentTypes>
>(
    em: M,
    uiComponents?: {
        [k in keyof Partial<ComponentTypes>]: {
            create?: (
                entity: EntityWithComponents<ComponentTypes, M, k>
            ) => HTMLElement | undefined;
            update?: (
                uiElement: HTMLElement,
                entity: EntityWithComponents<ComponentTypes, M, k>
            ) => void;
            removed?: (
                uiElement: HTMLElement,
                entity: EntityWithComponents<ComponentTypes, M, k>
            ) => void;
        };
    }
) => {
    const pipeline = new Pipeline(em);
    pipeline.tag = 'UIPipeline';

    function add<
        Includes extends Keys<ComponentTypes>[],
        Q extends Query<ComponentTypes, Includes, M, IndexedComponent>,
        IndexedComponent extends Keys<ComponentTypes> = null
    >(
        query: Q & Query<ComponentTypes, Includes, M, IndexedComponent>,
        handlers: {
            create?: (entity: Q['Entity']) => HTMLElement | undefined;
            update?: (uiElement: HTMLElement, entity: Q['Entity']) => void;
            removed?: (uiElement: HTMLElement, entity: Q['Entity']) => void;
        }
    ) {
        const { create, update } = handlers;

        pipeline.systems.add(
            em.createSystem(query.createConsumer(), {
                forNew(entity) {
                    if (!create || entity.components.uiElement) return;

                    const uiElement = create(entity);

                    if (!uiElement) return;
                    entity.components.uiElement = uiElement;

                    for (const component in uiComponents) {
                        if (component in entity.components) {
                            uiComponents[component]?.update?.(
                                uiElement,
                                entity
                            );
                        }
                    }
                    if (update) update(entity.components.uiElement, entity);
                },
                updated(entity) {
                    // TODO call create if element not existing?
                    if (!entity.components.uiElement) {
                        if (!create || entity.components.uiElement) return;

                        const uiElement = create(entity);

                        if (!uiElement) return;
                        entity.components.uiElement = uiElement;
                    }

                    if (update) update(entity.components.uiElement, entity);
                },
                removed(entity) {
                    entity.components.uiElement?.remove();

                    if (handlers.removed)
                        handlers.removed(entity.components.uiElement, entity);
                },
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

        add(componentQuery, uiComponent);
    }

    return { add, pipeline };
};
