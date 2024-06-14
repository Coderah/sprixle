import { lerp } from 'three/src/math/MathUtils';
import { Manager, defaultComponentTypes } from '../ecs/manager';
import { now } from '../util/now';

export type TweenComponents<ComponentTypes extends defaultComponentTypes> = {
    tweenTarget: Manager<ComponentTypes>['Entity'];
    tweeningComponent: keyof ComponentTypes;
    tweenTo: number;
    tweenLength: number;
    tweenFrom: number;
    tweenStart: number;
};

export const TWEEN_COMPONENT_DEFAULTS: TweenComponents<defaultComponentTypes> =
    {
        tweenTarget: undefined,
        tweeningComponent: 'updatedAt',
        tweenTo: 0,
        tweenLength: 0,
        tweenFrom: 0,
        tweenStart: 0,
    };

export function applyTweenPlugin<
    ComponentTypes extends defaultComponentTypes &
        TweenComponents<ComponentTypes>
>(manager: Manager<ComponentTypes>) {
    const tweenerQuery = manager.createQuery({
        includes: ['tweenTarget'],
    });

    return {
        tweenerQuery,
        tweenSystem: manager.createSystem(tweenerQuery, {
            all(entity, delta) {
                const {
                    tweenTarget,
                    tweeningComponent,
                    tweenTo,
                    tweenLength,
                    tweenFrom,
                    tweenStart,
                } = entity.components;

                if (
                    !tweenTarget ||
                    !tweenTo ||
                    !tweenLength ||
                    !tweenFrom ||
                    !tweenStart ||
                    !tweeningComponent
                )
                    return;

                const time = now();

                const tweenDelta = (time - tweenStart) / tweenLength;
                if (tweenDelta > 1) {
                    tweenTarget.components[tweeningComponent] = tweenTo;
                    manager.deregisterEntity(entity);
                } else {
                    tweenTarget.components[tweeningComponent] = lerp(
                        tweenFrom,
                        tweenTo,
                        tweenDelta
                    );
                }
            },
            // cleanup(entity) {},
        }),
        tween(
            entity: typeof manager.Entity,
            tweeningComponent: keyof ComponentTypes,
            tweenTo: number,
            tweenLength: number,
            tweenFrom = entity.components[tweeningComponent] as any as number,
            tweenStart = now()
        ) {
            const tweenerId = entity.id + tweeningComponent + 'tween';

            const tweenEntity = manager.entityExists(tweenerId)
                ? manager.getEntity(tweenerId)
                : manager.createEntity(tweenerId);
            tweenEntity.components.tweenTarget = entity;
            tweenEntity.components.tweeningComponent = tweeningComponent;
            tweenEntity.components.tweenTo = tweenTo;
            tweenEntity.components.tweenLength = tweenLength;
            tweenEntity.components.tweenFrom = tweenFrom;
            tweenEntity.components.tweenStart = tweenStart;
            manager.registerEntity(tweenEntity);

            return tweenEntity;
        },
    };
}
