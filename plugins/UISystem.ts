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
        element: HTMLElement;
    },
    M extends Manager<ComponentTypes>
>(
    em: M,
    uiComponents: {
        [k in keyof Partial<ComponentTypes>]: {
            element?: (
                entity: EntityWithComponents<ComponentTypes, M, k>
            ) => HTMLElement;
            update: (
                entity: EntityWithComponents<ComponentTypes, M, k>
            ) => void;
        };
    }
): System<ComponentTypes, M> => {
    const systems: ConsumerSystem<ComponentTypes, Keys<ComponentTypes>[], M>[] =
        [];
    for (const component in uiComponents) {
        const { element, update } = uiComponents[component];

        const componentQuery = em.createQuery({
            includes: [component],
        });

        systems.push(
            em.createSystem(componentQuery.createConsumer(), {
                new(entity) {
                    if (!element) return;

                    entity.components.element = element(entity);
                },
                updated: update,
            }) as ConsumerSystem<ComponentTypes, Keys<ComponentTypes>[], M>
        );
    }

    return new Pipeline(em, ...systems);
};
