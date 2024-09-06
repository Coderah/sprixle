import { map } from 'lodash';
import {
    EntityWithComponents,
    Keys,
    Manager,
    defaultComponentTypes,
} from '../ecs/manager';
import { ConsumerSystem, Pipeline, System } from '../ecs/system';

export const createUISystem = <
    ComponentTypes extends defaultComponentTypes & {
        uiElement: HTMLElement;
    },
    M extends Manager<ComponentTypes>
>(
    em: M,
    uiComponents: {
        [k in keyof Partial<ComponentTypes>]: {
            create?: (
                entity: EntityWithComponents<ComponentTypes, M, k>
            ) => HTMLElement | undefined;
            update?: (
                uiElement: HTMLElement,
                entity: EntityWithComponents<ComponentTypes, M, k>
            ) => void;
        };
    }
): System<ComponentTypes, M, any> => {
    const systems: ConsumerSystem<ComponentTypes, Keys<ComponentTypes>[], M>[] =
        [];
    for (const component in uiComponents) {
        const uiComponent = uiComponents[component];
        if (!uiComponent) continue;
        const { create, update } = uiComponent;

        const componentQuery = em.createQuery({
            includes: [component],
        });

        systems.push(
            em.createSystem(componentQuery.createConsumer(), {
                new(entity) {
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
                },
                updated(entity) {
                    // TODO call create if element not existing?
                    if (update) update(entity.components.uiElement, entity);
                },
                removed(entity) {
                    entity.components.uiElement?.remove();
                },
            }) as ConsumerSystem<ComponentTypes, Keys<ComponentTypes>[], M>
        );
    }

    return new Pipeline(em, ...systems);
};
