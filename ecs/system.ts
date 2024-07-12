import {
    EntityWithComponents,
    Keys,
    Manager,
    defaultComponentTypes,
} from './manager';
import { Query } from './query';

export interface System<
    ExactComponentTypes extends defaultComponentTypes,
    TManager extends Manager<ExactComponentTypes>,
    Includes extends Keys<ExactComponentTypes>[]
> {
    /** runs when initing or resetting a pipeline, can be run to explicitly init the system  */
    init?();
    /** Runs every frame */
    tick?(delta: number): void;
    /** Runs at the end of a frame to do any cleanup necessary */
    cleanup?(
        entity: EntityWithComponents<
            ExactComponentTypes,
            TManager,
            Includes[number]
        >
    ): void;

    /** runs when reseting (to do integration cleanup and such) */
    reset?();
}

export interface SourceSystem<
    ExactComponentTypes extends defaultComponentTypes,
    TManager extends Manager<ExactComponentTypes>,
    Includes extends Keys<ExactComponentTypes>[]
> extends System<ExactComponentTypes, TManager, Includes> {
    source:
        | Query<ExactComponentTypes, Includes>
        | ReturnType<Query<ExactComponentTypes, Includes>['createConsumer']>;
}

export interface ConsumerSystem<
    ExactComponentTypes extends defaultComponentTypes,
    Includes extends Keys<ExactComponentTypes>[],
    TManager extends Manager<ExactComponentTypes> = Manager<ExactComponentTypes>
> extends SourceSystem<ExactComponentTypes, TManager, Includes> {
    /** Runs for each entity that was updated each frame */
    updated?: (
        entity: EntityWithComponents<
            ExactComponentTypes,
            TManager,
            Includes[number]
        >,
        delta: number
    ) => boolean | void;
    /** Runs for each new entity each frame */
    new?: (
        entity: EntityWithComponents<
            ExactComponentTypes,
            TManager,
            Includes[number]
        >,
        delta: number
    ) => boolean | void;
    /** Runs for each entity that was removed from EntityManager each frame */
    removed?: (
        entity: EntityWithComponents<
            ExactComponentTypes,
            TManager,
            Includes[number]
        >,
        delta: number
    ) => boolean | void;
}

export interface QuerySystem<
    ExactComponentTypes extends defaultComponentTypes,
    Includes extends Keys<ExactComponentTypes>[],
    TManager extends Manager<ExactComponentTypes> = Manager<ExactComponentTypes>
> extends SourceSystem<ExactComponentTypes, TManager, Includes> {
    /** Runs for every entity every frame */
    all?: (
        entity: EntityWithComponents<
            ExactComponentTypes,
            TManager,
            Includes[number]
        >,
        delta: number
    ) => boolean | void;
}

/** Pipelines compose Systems (and other Pipelines). They will properly run in sequence and ensure internal processing is done between each. */
export class Pipeline<ExactComponentTypes extends defaultComponentTypes> {
    manager: Manager<ExactComponentTypes>;
    systems: Array<
        | System<ExactComponentTypes, Manager<ExactComponentTypes>, any>
        | QuerySystem<ExactComponentTypes, any>
        | ConsumerSystem<ExactComponentTypes, any>
    >;

    constructor(
        manager: Manager<ExactComponentTypes>,
        ...systems: Array<
            | System<ExactComponentTypes, Manager<ExactComponentTypes>, any>
            | QuerySystem<ExactComponentTypes, any>
            | ConsumerSystem<ExactComponentTypes, any>
        >
    ) {
        this.manager = manager;
        this.systems = systems;
    }

    init() {
        this.systems.forEach((system) => {
            system.init?.();
        });
    }

    reset() {
        this.systems.forEach((system) => {
            system.reset?.();
        });
    }

    tick(delta: number) {
        this.systems.forEach((system) => {
            if (system.tick) system.tick(delta);

            if (!system.source) return;
            const { source } = system;

            if (source instanceof Query) {
                if ('all' in system && system.all) {
                    source.for(system.all, delta);
                }
            } else {
                if ('updated' in system && system.updated) {
                    source.forUpdated(system.updated, delta);
                }
                if ('new' in system && system.new) {
                    source.forNew(system.new, delta);
                }
                if ('removed' in system && system.removed) {
                    source.forDeleted(system.removed, delta);
                } else {
                    // TODO could be cleaner.
                    source.deletedEntities.clear();
                }
            }
            this.manager.subTick();
        });
    }

    /** cleanup an entity before tick finishes */
    cleanup() {
        this.systems.forEach((system) => {
            if (system.cleanup) {
                const { source } = system;
                if (!source) return;

                if (source instanceof Query) {
                    source.for(system.cleanup);
                } else {
                    source.query.for(system.cleanup);
                }
            }
        });
    }
}
