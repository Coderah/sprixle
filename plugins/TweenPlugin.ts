import { lerp } from 'three/src/math/MathUtils';
import { Keys, Manager, defaultComponentTypes } from '../ecs/manager';
import { now } from '../util/now';

export type TweenComponents<ComponentTypes extends defaultComponentTypes> = {
    tweenTargetId: string;
    tweeningComponent: Keys<ComponentTypes>;
    tweenTo: number | number[];
    tweenLength: number;
    tweenFrom: number | number[];
    tweenStart: number;
};

export const TWEEN_COMPONENT_DEFAULTS: TweenComponents<defaultComponentTypes> =
    {
        tweenTargetId: '',
        tweeningComponent: 'updatedAt',
        tweenTo: 0,
        tweenLength: 0,
        tweenFrom: 0,
        tweenStart: 0,
    };

// TODO figure out typing to force only number | number[] components within tween functions
export function applyTweenPlugin<
    ComponentTypes extends defaultComponentTypes &
        TweenComponents<ComponentTypes>
>(manager: Manager<ComponentTypes>) {
    const tweenerQuery = manager.createQuery({
        includes: ['tweenTargetId'],
    });

    return {
        tweenerQuery,
        tweenSystem: manager.createSystem(tweenerQuery, {
            all(entity, delta) {
                const {
                    tweenTargetId,
                    tweeningComponent,
                    tweenTo,
                    tweenLength,
                    tweenFrom,
                    tweenStart,
                } = entity.components;

                const tweenTarget = manager.getEntity(tweenTargetId);

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
                    const component = tweenTarget.components[tweeningComponent];
                    if (component.length) {
                        (component as number[]).forEach((v, i) => {
                            component[i] = lerp(
                                tweenFrom[i],
                                tweenTo[i],
                                tweenDelta
                            );
                        });

                        tweenTarget.flagUpdate(tweeningComponent);
                    } else {
                        tweenTarget.components[tweeningComponent] = lerp(
                            tweenFrom as number,
                            tweenTo as number,
                            tweenDelta
                        );
                    }
                }
            },
            // cleanup(entity) {},
        }),
        tween<C extends Keys<ComponentTypes>, V extends number | number[]>(
            entity: typeof manager.Entity,
            tweeningComponent: C,
            tweenTo: V,
            tweenLength: number,
            tweenFrom = entity.components[tweeningComponent] as any as V,
            tweenStart = now()
        ) {
            const tweenerId =
                entity.id + tweeningComponent.toString() + 'tween';

            let tweenEntity = manager.getEntity(tweenerId);

            if (!tweenEntity) tweenEntity = manager.createEntity(tweenerId);

            tweenEntity.components.tweenTargetId = entity.id;
            tweenEntity.components.tweeningComponent = tweeningComponent;
            tweenEntity.components.tweenTo = tweenTo;
            tweenEntity.components.tweenLength = tweenLength;
            tweenEntity.components.tweenFrom = tweenFrom;
            tweenEntity.components.tweenStart = tweenStart;

            return tweenEntity;
        },
    };
}
