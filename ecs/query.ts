import { throttleLog } from '../util/log';
import {
    defaultComponentTypes,
    Entity,
    entityId,
    EntityWithComponents,
    Keys,
    Manager,
} from './manager';

export type QueryName = string;

type QueryTimeSlicingParameters = (
    | {
          count: number;
      }
    | {
          percentage: number;
      }
) & {
    /** @todo */
    sliceNew?: boolean;
};

export type QueryParameters<ComponentTypes, IncludeKeys> = {
    flexible?: boolean;
    includes?: Set<Keys<ComponentTypes>>;
    excludes?: Set<Keys<ComponentTypes>>;
    timeSlicing?: QueryTimeSlicingParameters;
};

export type QueryParametersInput<ComponentTypes, IncludeKeys> = {
    /** Flexible queries match entities with any combination of `includes` */
    flexible?: boolean;

    /** These components will be included in the query (must have all unless `flexible` is true) */
    includes?: IncludeKeys;

    /** Entities with these components will be excluded. (this option is not affected by `flexible`) */
    excludes?: Keys<ComponentTypes>[];

    /** Time slicing allows handling fewer updates per tick. Percentage of total Query or exact count per tick. */
    timeSlicing?: QueryTimeSlicingParameters;
};

export class Query<
    ExactComponentTypes extends defaultComponentTypes,
    Includes extends Keys<ExactComponentTypes>[],
    M extends Manager<ExactComponentTypes> = Manager<ExactComponentTypes>,
    E = EntityWithComponents<ExactComponentTypes, M, Includes[number]>
> implements Iterable<E>
{
    Entity: E;
    manager: M;
    queryName: QueryName;

    queryParameters: QueryParameters<Partial<ExactComponentTypes>, Includes>;
    entities = new Set<entityId>();
    consumers = new Array<Consumer<ExactComponentTypes, Includes, M, E>>();

    /** What entities are queued for future slices */
    queuedEntities = new Set<entityId>();
    /** tracks what entities are included in the current slice; cleared on tick. */
    entitiesInSlice = new Set<entityId>();

    private lastEntity: E | undefined;

    *[Symbol.iterator]() {
        for (let id of this.entities) {
            yield this.manager.getEntity(id) as E;
        }
    }

    constructor(
        manager: M,
        parameters: QueryParametersInput<Partial<ExactComponentTypes>, Includes>
    ) {
        this.manager = manager;

        this.queryName = '';

        this.queryParameters = {
            flexible: parameters.flexible,
            timeSlicing: parameters.timeSlicing,
        };

        if (parameters.includes) {
            const includesArray = parameters.includes.sort((a, b) =>
                a.toString()[0] > b.toString()[0] ? 1 : -1
            );
            this.queryName += includesArray
                .map((c) => '+' + c.toString())
                .join(',');

            this.queryParameters.includes = new Set(parameters.includes);
        }
        if (parameters.excludes) {
            const excludesArray = parameters.excludes.sort((a, b) =>
                a.toString()[0] > b.toString()[0] ? 1 : -1
            );
            if (this.queryName) this.queryName += ',';
            this.queryName += excludesArray
                .map((c) => '-' + c.toString())
                .join(',');

            this.queryParameters.excludes = new Set(parameters.excludes);
        }

        // TODO: handle existing entities
        manager.state.entities.forEach((entity) => {
            if (this.entityMatches(entity)) this.addEntity(entity);
        });
    }

    componentMatches(component: keyof typeof this.manager.ComponentTypes) {
        return this.queryParameters.includes
            ? this.queryParameters.includes.has(component)
            : this.queryParameters.excludes
            ? !this.queryParameters.excludes.has(component)
            : true;
    }

    entityMatches(entity: typeof this.manager.Entity) {
        if (
            this.queryParameters.includes &&
            (this.queryParameters.flexible
                ? !this.queryParameters.includes.some(
                      (component) => component in entity.components
                  )
                : !this.queryParameters.includes.every(
                      (component) => component in entity.components
                  ))
        )
            return false;
        if (
            this.queryParameters.excludes &&
            this.queryParameters.excludes.some(
                (component) => component in entity.components
            )
        )
            return false;

        return true;
    }

    createConsumer() {
        const newConsumer = new Consumer(this);
        this.consumers.push(newConsumer);
        return newConsumer;
    }

    resetConsumers() {
        this.entities = new Set();
        this.consumers.forEach((consumer) => {
            consumer.clear();
        });
    }

    private indexEntity(entity: typeof this.manager.Entity) {
        this.entities.add(entity.id);
    }

    handleEntity(entity: typeof this.manager.Entity) {
        const matches = this.entityMatches(entity);

        if (this.entities.has(entity.id)) {
            if (!matches) {
                throttleLog(
                    '[QUERY]',
                    this.queryName,
                    'removed entity',
                    entity.id
                );
                this.removeEntity(entity);
            } else {
                throttleLog(
                    '[QUERY]',
                    this.queryName,
                    'updated entity',
                    entity.id
                );
                this.updatedEntity(entity);
            }
        } else if (matches) {
            throttleLog('[QUERY]', this.queryName, 'added entity', entity.id);
            this.addEntity(entity);
        }
    }

    protected updateTimeSlice() {
        const { timeSlicing } = this.queryParameters;
        if (!timeSlicing || !this.queuedEntities.size) return;

        let sliceTarget = 0;

        if ('percentage' in timeSlicing) {
            // TODO get percentage of entities within queue and apply them
            sliceTarget = Math.floor(
                (this.entities.size * timeSlicing.percentage) / 100
            );
        } else if ('count' in timeSlicing) {
            sliceTarget = timeSlicing.count;
        }

        if (this.entitiesInSlice.size >= sliceTarget) return;

        for (let queuedEntityId of this.queuedEntities) {
            this.entitiesInSlice.add(queuedEntityId);
            this.queuedEntities.delete(queuedEntityId);
            this.handleEntity(this.manager.getEntity(queuedEntityId));

            if (this.entitiesInSlice.size >= sliceTarget) return;
        }
    }

    addEntity(entity: typeof this.manager.Entity) {
        this.consumers.forEach((c) => c.add(entity.id));
        this.indexEntity(entity);

        if (!this.manager.state.queryMap.has(entity.id)) {
            this.manager.state.queryMap.set(entity.id, new Set());
        }
        this.manager.state.queryMap.get(entity.id)?.add(this.queryName);
        this.lastEntity = entity as E;
    }

    updatedEntity(entity: typeof this.manager.Entity) {
        if (!this.entities.has(entity.id)) return;

        if (
            this.queryParameters.timeSlicing &&
            !this.entitiesInSlice.has(entity.id)
        ) {
            if (this.queuedEntities.has(entity.id)) return;

            this.queuedEntities.add(entity.id);
            this.updateTimeSlice();
            return;
        }

        this.consumers.forEach((c) => {
            c.updatedEntities.add(entity.id);
            c.consumedEntities.delete(entity.id);
        });
    }

    removeEntity(entity: typeof this.manager.Entity) {
        this.entities.delete(entity.id);
        this.consumers.forEach((c) => {
            c.remove(entity);
        });

        if (this.lastEntity === entity) {
            const lastID = Array.from(this.entities).pop();
            this.lastEntity = lastID
                ? (this.manager.getEntity(lastID) as E)
                : undefined;
        }

        this.manager.state.queryMap.get(entity.id)?.delete(this.queryName);
    }

    get size() {
        return this.entities.size;
    }

    for(
        handler: (entity: E, delta?: number) => boolean | void,
        delta?: number
    ) {
        this.entities.forEach((id) => {
            return handler(this.manager.getEntity(id) as any as E, delta);
        });
    }

    map<V>(handler: (entity: E) => V, delta?: number) {
        return Array.from(this.entities).map((id) => {
            return handler(this.manager.getEntity(id) as any as E);
        });
    }

    first() {
        return this.manager.getEntity(this.entities.first()) as E;
    }

    last() {
        return this.lastEntity;
    }

    find(handler: (entity: E) => boolean) {
        let foundEntity: E;

        this.for((possibleEntity) => {
            if (handler(possibleEntity)) {
                foundEntity = possibleEntity;
                return true;
            }
        });

        return foundEntity;
    }

    filter(handler: (entity: E) => boolean) {
        let foundEntities: E[] = [];

        this.for((possibleEntity) => {
            if (handler(possibleEntity)) {
                foundEntities.push(possibleEntity);
            }
        });

        return foundEntities;
    }

    tick() {
        this.consumers.forEach((c) => c.tick());

        this.entitiesInSlice.clear();

        this.updateTimeSlice();
    }
}

// TODO: revisit this.consumed concept
/** Consumers track updated and new entities until consumed for a given Query */
export class Consumer<
    ExactComponentTypes extends defaultComponentTypes,
    Includes extends Keys<ExactComponentTypes>[],
    M extends Manager<ExactComponentTypes> = Manager<ExactComponentTypes>,
    E = EntityWithComponents<ExactComponentTypes, M, Includes[number]>
> {
    query: Query<ExactComponentTypes, Includes, M, E>;
    updatedEntities = new Set<entityId>();
    newEntities = new Set<entityId>();
    deletedEntities = new Set<typeof this.query.manager.Entity>();

    consumed = false;
    consumedEntities = new Set<entityId>();

    constructor(query: Query<ExactComponentTypes, Includes, M, E>) {
        this.query = query;

        if (query.entities.size) {
            query.entities.forEach((entity) => this.add(entity));
        }
    }

    clear() {
        this.updatedEntities = new Set();
        this.newEntities = new Set();
        this.deletedEntities = new Set();
        this.consumed = false;
        this.consumedEntities = new Set();
    }

    /** called by Query when adding an entity, for internal use */
    add(id: entityId) {
        this.newEntities.add(id);
        // this.updated(id);
    }

    *New() {
        for (let id of this.newEntities) {
            yield this.query.manager.getEntity(id) as E;
        }
    }

    *Updated() {
        for (let id of this.updatedEntities) {
            yield this.query.manager.getEntity(id) as E;
        }
    }

    /** called by Query when updating an entity, for internal use */
    updated(id: entityId) {
        this.updatedEntities.add(id);
    }

    remove(entity: typeof this.query.manager.Entity) {
        this.updatedEntities.delete(entity.id);
        this.newEntities.delete(entity.id);
        this.deletedEntities.add(entity);
    }

    // for(handler: (entity: typeof this.query.manager.Entity) => boolean | void) {
    //     this.query.for(handler);
    // }

    /** primarily intended to be used within pipeline as an optimization for systems */
    forNewOrUpdated(
        newHandler?: (entity: E, delta?: number) => boolean | void,
        newOrUpdated?: (entity: E, delta?: number) => boolean | void,
        updated?: (entity: E, delta?: number) => boolean | void,
        delta?: number
    ) {
        const entitiesConsumed: typeof this.updatedEntities = new Set();

        this.newEntities.forEach((id) => {
            const entity = this.query.manager.getEntity(id) as E;
            newHandler?.(entity, delta);

            entitiesConsumed.add(id);
            newOrUpdated?.(entity, delta);
            this.newEntities.delete(id);
        });

        if (!updated && !newOrUpdated) return;

        this.updatedEntities.forEach((id) => {
            const entity = this.query.manager.getEntity(id) as E;
            updated?.(entity, delta);

            if (entitiesConsumed.has(id)) {
                this.updatedEntities.delete(id);
                return;
            }
            newOrUpdated?.(entity, delta);
            this.updatedEntities.delete(id);
        });
    }

    forUpdated(
        handler: (entity: E, delta?: number) => boolean | void,
        delta?: number
    ) {
        this.consumed = true;

        this.updatedEntities.forEach((id) => {
            this.updatedEntities.delete(id);
            // this.consumedEntities.add(id);
            return handler(this.query.manager.getEntity(id) as E, delta);
        });
    }

    forNew(
        handler: (entity: E, delta?: number) => boolean | void,
        delta?: number
    ) {
        this.consumed = true;

        this.newEntities.forEach((id) => {
            this.newEntities.delete(id);
            return handler(this.query.manager.getEntity(id) as E, delta);
        });
    }

    forDeleted(
        handler: (entity: E, delta?: number) => boolean | void,
        delta?: number
    ) {
        this.consumed = true;

        this.deletedEntities.forEach((entity) => {
            this.deletedEntities.delete(entity);
            return handler(entity as E, delta);
        });
    }

    tick() {
        if (this.consumed) {
            // this.newEntities.clear();
            // this.deletedEntities.clear();
            // this.consumedEntities.forEach((id) => {
            //     this.updatedEntities.delete(id);
            // });
            // this.consumedEntities.clear();
        }
    }
}

/*
TODO:
* figure out how to provide exact types to consumers/queries so there is no "this might not exist" for component lookups
* figure out if there is a way to optimize query being used in multiple systems?
* utilize bitmasks for faster matching and queries
* do we update queries in realtime? or delay/commit them on tick
* handle removal / deregistering an entity
* make sure entities can't hangout or be re-indexed if they're not registered
*/
