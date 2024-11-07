import {
    defaultComponentTypes,
    EntityWithComponents,
    Manager,
} from '../ecs/manager';
import { now } from '../util/now';

type EnumValue<TEnum> = (TEnum[keyof TEnum] & number) | string;
type Enum<TEnum> = {
    [k: number]: string;
    [k: string]: EnumValue<TEnum>;
};

export type StateMachineComponents<
    T extends string | number,
    StateName extends string = 'state'
> = {
    [key in StateName]: T;
} & {
    [key in `${StateName}StartedAt`]: number;
};

export function applyStateMachinePlugin<
    ComponentTypes extends defaultComponentTypes &
        StateMachineComponents<T, StateName>,
    T extends string | number,
    STATES extends Enum<T> = Enum<T>,
    StateName extends string = 'state',
    M extends Manager<ComponentTypes> = Manager<ComponentTypes>,
    E extends EntityWithComponents<
        ComponentTypes,
        M,
        StateName | `${StateName}StartedAt`
    > = EntityWithComponents<
        ComponentTypes,
        M,
        StateName | `${StateName}StartedAt`
    >
>(
    manager: M,
    {
        states,
        stateName,
        getValidTransition,
    }: {
        states: STATES;
        stateName: StateName;
        getValidTransition: (
            entity: typeof manager.Entity,
            desiredState: T
        ) => boolean;
    }
) {
    const query = manager.createQuery({
        includes: [stateName],
    });

    const inStateLogic: {
        [state in T]?: (entity: E) => void;
    } = {};

    const enteredStateLogic: {
        [state in T]?: (entity: E) => void;
    } = {};

    const stateMachineSystem = manager.createSystem(query.createConsumer(), {
        tick(delta) {
            query.for((entity) => {
                const { [stateName]: state } = entity.components;

                // apply inStateLogic
                if (state in inStateLogic) {
                    inStateLogic[state]?.(entity as E);
                }
            });
        },
        newOrUpdated(entity) {
            const { [stateName]: state } = entity.components;

            // TODO find some reasonable way to support this generically?
            // if (moveState in shadowParameters?.moveModifiers) {
            //     shadowParameters.moveModifiers[moveState]?.forEach(
            //         (modifier) => {
            //             enteredStateLogic[modifier]?.(entity);
            //         }
            //     );
            // }

            if (state in enteredStateLogic) {
                enteredStateLogic[state]?.(entity as E);
            }
        },
    });

    function isStateValid(entity: typeof manager.Entity, desiredState: T) {
        // TODO probably clean this up, seems redundant now

        if (!getValidTransition(entity, desiredState)) return false;

        return true;
    }

    function attemptChangeState(
        entity: typeof manager.Entity,
        desiredState: T,
        ignoreValidTransition = false
    ) {
        const { [stateName]: state } = entity.components;

        if (!ignoreValidTransition && !isStateValid(entity, desiredState))
            return false;

        // TODO fix types I guess.. generic enums are rude.

        if (entity.components[stateName] !== desiredState) {
            // @ts-ignore
            entity.components[`${stateName}StartedAt`] = now();
        } else {
            return true;
        }

        console.log(
            '[changeState] changed state',
            entity.id,
            states[state],
            '->',
            states[desiredState]
        );
        entity.components[stateName] = desiredState;

        return true;
    }

    function setInStateLogic(
        state: T,
        logic: (entity: typeof manager.Entity) => void
    ) {
        inStateLogic[state] = logic;
    }

    function setEnteredStateLogic(
        state: T,
        logic: (entity: typeof manager.Entity) => void
    ) {
        enteredStateLogic[state] = logic;
    }

    return {
        system: stateMachineSystem,
        query,
        isStateValid,
        attemptChangeState,
        setInStateLogic,
        setEnteredStateLogic,
    };
}
