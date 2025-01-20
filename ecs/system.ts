import { setTimeActivePipeline } from '../util/now';
import { interval } from '../util/timing';
import {
    EntityWithComponents,
    Keys,
    Manager,
    defaultComponentTypes,
} from './manager';
import { Consumer, Query } from './query';

export interface System<
    ExactComponentTypes extends defaultComponentTypes,
    TManager extends Manager<ExactComponentTypes>,
    Includes extends Keys<ExactComponentTypes>[]
> {
    /** holds all updates and only runs when this interval passes */
    interval?: ReturnType<typeof interval>;
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
    /**
     * Please replace with forNew otherwise your build will error. This is an unfortunate consequence of introducing type reflection in build steps
     * @deprecated
     */
    new?: (error: Error) => {};
    /** Runs for each new entity each frame */
    forNew?: (
        entity: EntityWithComponents<
            ExactComponentTypes,
            TManager,
            Includes[number]
        >,
        delta: number
    ) => boolean | void;
    /** Runs for each entity that is new or was updated each frame */
    newOrUpdated?: (
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
> extends SourceSystem<ExactComponentTypes, TManager, Includes> {}

export type AnySystem<ExactComponentTypes extends defaultComponentTypes> =
    | System<ExactComponentTypes, Manager<ExactComponentTypes>, any>
    | QuerySystem<ExactComponentTypes, any>
    | ConsumerSystem<ExactComponentTypes, any>;

/** Pipelines compose Systems (and other Pipelines). They will properly run in sequence and ensure internal processing is done between each. */
export class Pipeline<ExactComponentTypes extends defaultComponentTypes> {
    protected manager: Manager<ExactComponentTypes>;
    systems: Set<AnySystem<ExactComponentTypes>>;

    /** if set ticks will be broken up into substeps to match delta per tick */
    deltaPerTick: number = 0;
    lag: number = 0;

    /** if set this pipeline will maintain its own simulation time and now() will use the internal clock */
    useInternalTime: boolean = false;

    getTimeScale?: () => number;

    constructor(
        manager: Manager<ExactComponentTypes>,
        ...systems: Array<AnySystem<ExactComponentTypes>>
    ) {
        this.manager = manager;
        this.systems = new Set(systems);
    }

    init() {
        if (this.useInternalTime) setTimeActivePipeline(this);

        this.systems.forEach((system) => {
            system.init?.();
        });

        if (this.useInternalTime) setTimeActivePipeline(null);
    }

    reset() {
        if (this.useInternalTime) setTimeActivePipeline(this);

        this.systems.forEach((system) => {
            system.reset?.();
        });

        if (this.useInternalTime) setTimeActivePipeline(null);
    }

    now = 0;

    tick(delta: number) {
        if (this.useInternalTime) setTimeActivePipeline(this);

        if (!this.deltaPerTick) {
            this.realTick(delta);

            if (this.useInternalTime) setTimeActivePipeline(null);

            return;
        }

        this.lag += delta;
        while (this.lag >= this.deltaPerTick) {
            this.realTick(this.deltaPerTick);
            this.lag -= this.deltaPerTick;
        }

        if (this.useInternalTime) setTimeActivePipeline(null);
    }

    private realTick(delta: number) {
        if (this.getTimeScale) delta = delta * this.getTimeScale();
        if (delta <= 0) return;
        if (this.useInternalTime) this.now += delta;
        this.systems.forEach((system) => {
            let systemDelta = delta;
            if (system.interval) {
                const intervalDelta = system.interval(delta);
                if (!intervalDelta) return;
                systemDelta = intervalDelta;
            }
            if (system.tick) system.tick(systemDelta);

            if (!('source' in system)) return;
            const { source } = system;

            if (source instanceof Query) {
                if ('all' in system && system.all) {
                    source.for(system.all, systemDelta);
                }
            } else if (source instanceof Consumer) {
                if (
                    ('updated' in system && system.updated) ||
                    ('forNew' in system && system.forNew) ||
                    ('newOrUpdated' in system && system.newOrUpdated)
                ) {
                    source.forNewOrUpdated(
                        system.forNew,
                        system.newOrUpdated,
                        system.updated,
                        systemDelta
                    );
                }
                if ('all' in system && system.all) {
                    source.query.for(system.all, systemDelta);
                }
                if ('removed' in system && system.removed) {
                    source.forDeleted(system.removed, systemDelta);
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
                    for (let entity of source.IterateIgnoringSlice()) {
                        system.cleanup?.(entity);
                    }
                } else {
                    for (let entity of source.query.IterateIgnoringSlice()) {
                        system.cleanup?.(entity);
                    }
                }
            }
        });
    }
}
