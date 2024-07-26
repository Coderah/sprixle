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
            update: (
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
                    if (!create) return;

                    const uiElement = create(entity);

                    if (uiElement) entity.components.uiElement = uiElement;
                },
                updated(entity) {
                    // TODO call create if element not existing?
                    update(entity.components.uiElement, entity);
                },
            }) as ConsumerSystem<ComponentTypes, Keys<ComponentTypes>[], M>
        );
    }

    return new Pipeline(em, ...systems);
};
