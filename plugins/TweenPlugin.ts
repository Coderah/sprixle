import { lerp } from 'three/src/math/MathUtils';
import { Keys, Manager, defaultComponentTypes } from '../ecs/manager';
import { memoizedGlobalNow } from '../util/now';
import * as easing from 'easing-utils';

export type TweenComponents<ComponentTypes extends defaultComponentTypes> = {
    tweenTargetId: string;
    tweeningComponent: keyof ComponentTypes;
    tweenTo: number | number[];
    tweenLength: number;
    tweenFrom: number | number[];
    tweenStart: number;
    easeFn: keyof typeof easing;
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
                    easeFn,
                } = entity.components;

                const tweenTarget = manager.getEntity(tweenTargetId);

                if (
                    tweenTarget === undefined ||
                    tweenTo === undefined ||
                    tweenLength === undefined ||
                    tweenFrom === undefined ||
                    tweenStart === undefined ||
                    tweeningComponent === undefined
                )
                    return;

                const time = memoizedGlobalNow();

                let tweenDelta = (time - tweenStart) / tweenLength;
                if (easeFn) tweenDelta = easing[easeFn](tweenDelta);

                if (tweenDelta > 1) {
                    tweenTarget.components[tweeningComponent] = tweenTo;
                    manager.deregisterEntity(entity);
                } else {
                    const component = tweenTarget.components[tweeningComponent];
                    // TODO figure out why this happened and what to do about it...
                    if (component === undefined) return;
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
        }),
        tween<C extends Keys<ComponentTypes>, V extends number | number[]>(
            entity: typeof manager.Entity,
            tweeningComponent: C,
            tweenTo: V,
            tweenLength: number,
            easeFn: keyof typeof easing | undefined = undefined,
            tweenFrom = entity.components[tweeningComponent] as any as V,
            tweenStart = memoizedGlobalNow()
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
            tweenEntity.components.easeFn = easeFn;

            return tweenEntity;
        },
        clearTween<C extends Keys<ComponentTypes>>(
            entity: typeof manager.Entity,
            tweeningComponent: C
        ) {
            const tweenerId =
                entity.id + tweeningComponent.toString() + 'tween';

            const tweenEntity = manager.getEntity(tweenerId);
            if (tweenEntity) {
                manager.deregisterEntity(tweenEntity);
            }
        },
    };
}
