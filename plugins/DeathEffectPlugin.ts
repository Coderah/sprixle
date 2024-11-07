import { Manager, defaultComponentTypes } from '../ecs/manager';
import { now } from '../util/now';

export type DeathEffectComponents<
    ComponentTypes extends defaultComponentTypes
> = {
    deadAt: number;
    deathEffect: {
        id: string;
        components: Partial<ComponentTypes>;
    };
};

/** Creates a system that as a side-effect of one entity dying creates an entity or applies components to another existing entity. */
export function applyDeathEffectPlugin<
    M extends Manager<ComponentTypes>,
    ComponentTypes extends defaultComponentTypes &
        DeathEffectComponents<ComponentTypes>
>(manager: M) {
    const deathEffectQuery = manager.createQuery({
        includes: ['deathEffect'],
    });

    return {
        deathEffectQuery,
        deathEffectSystem: manager.createSystem(
            deathEffectQuery.createConsumer(),
            {
                tick() {
                    const time = now();

                    manager.getEntities('deadAt').forEach((entity) => {
                        if (entity.components.deadAt <= time) {
                            manager.deregisterEntity(entity);
                        }
                    });
                },
                removed(entity) {
                    const { deathEffect } = entity.components;

                    const existingEntityForEffect = manager.getEntity(
                        deathEffect.id
                    );

                    if (existingEntityForEffect) {
                        manager.addComponents(
                            existingEntityForEffect,
                            deathEffect.components
                        );
                    } else {
                        manager.registerEntity(deathEffect as M['Entity']);
                    }
                },
            }
        ),
    };
}
