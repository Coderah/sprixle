import { Manager, defaultComponentTypes } from './manager';
import { Query } from './query';

export interface System<
    ExactComponentTypes extends defaultComponentTypes,
    TManager extends Manager<ExactComponentTypes>
> {
    source:
        | Query<ExactComponentTypes>
        | ReturnType<Query<ExactComponentTypes>['createConsumer']>;
    tick?(delta: number): void;
}

export interface ConsumerSystem<
    T extends defaultComponentTypes,
    M extends Manager<T> = Manager<T>
> extends System<T, M> {
    updated?: (entity: M['Entity']) => boolean | void;
    new?: (entity: M['Entity']) => boolean | void;
    removed?: (entity: M['Entity']) => boolean | void;
}

export interface QuerySystem<
    T extends defaultComponentTypes,
    M extends Manager<T> = Manager<T>
> extends System<T, M> {
    all?: (entity: M['Entity']) => boolean | void;
}

export class Pipeline<ExactComponentTypes extends defaultComponentTypes> {
    manager: Manager<ExactComponentTypes>;
    systems: Array<
        QuerySystem<ExactComponentTypes> | ConsumerSystem<ExactComponentTypes>
    >;

    constructor(
        manager: Manager<ExactComponentTypes>,
        ...systems: Array<
            | QuerySystem<ExactComponentTypes>
            | ConsumerSystem<ExactComponentTypes>
        >
    ) {
        this.manager = manager;
        this.systems = systems;
    }

    tick(delta: number) {
        this.systems.forEach((system) => {
            const { source, tick } = system;

            if (tick) tick(delta);

            if (source instanceof Query) {
                if ('all' in system && system.all) {
                    source.for(system.all);
                }
            } else {
                if ('updated' in system && system.updated) {
                    source.forUpdated(system.updated);
                }
                if ('new' in system && system.new) {
                    source.forNew(system.new);
                }
                if ('removed' in system && system.removed) {
                    source.forDeleted(system.removed);
                }
            }
            this.manager.subTick();
        });
    }
}
