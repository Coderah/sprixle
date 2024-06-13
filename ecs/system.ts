import { Manager, defaultComponentTypes } from './manager';
import { Query } from './query';

export interface System<
    ExactComponentTypes extends defaultComponentTypes,
    TManager extends Manager<ExactComponentTypes>
> {
    source:
        | Query<ExactComponentTypes>
        | ReturnType<Query<ExactComponentTypes>['createConsumer']>;
    /** Runs every frame */
    tick?(delta: number): void;
    /** Runs at the end of a frame to do any cleanup necessary */
    cleanup?(entity: TManager['Entity']): void;
}

export interface ConsumerSystem<
    ExactComponentTypes extends defaultComponentTypes,
    TManager extends Manager<ExactComponentTypes> = Manager<ExactComponentTypes>
> extends System<ExactComponentTypes, TManager> {
    /** Runs for each entity that was updated each frame */
    updated?: (entity: TManager['Entity']) => boolean | void;
    /** Runs for each new entity each frame */
    new?: (entity: TManager['Entity']) => boolean | void;
    /** Runs for each entity that was removed from EntityManager each frame */
    removed?: (entity: TManager['Entity']) => boolean | void;
}

export interface QuerySystem<
    ExactComponentTypes extends defaultComponentTypes,
    TManager extends Manager<ExactComponentTypes> = Manager<ExactComponentTypes>
> extends System<ExactComponentTypes, TManager> {
    /** Runs for every entity every frame */
    all?: (entity: TManager['Entity']) => boolean | void;
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
                } else {
                    // TODO could be cleaner.
                    source.deletedEntities.clear();
                }
            }
            this.manager.subTick();
        });
    }

    cleanup() {
        this.systems.forEach((system) => {
            if (system.cleanup) {
                const { source } = system;

                if (source instanceof Query) {
                    source.for(system.cleanup);
                } else {
                    source.query.for(system.cleanup);
                }
            }
        });
    }
}
