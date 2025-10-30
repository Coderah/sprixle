import { throttleLog } from '../util/log';
import uuid from 'uuid-random';
import {
    defaultComponentTypes,
    Entity,
    EntityId,
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
    /** [NOT IMPLEMENTED @todo */
    sliceNew?: boolean;
};

export type QueryParameters<ComponentTypes, IncludeKeys, IndexedComponent> = {
    flexible?: boolean;
    includes?: Set<Keys<IncludeKeys>>;
    excludes?: Set<Keys<ComponentTypes>>;
    timeSlicing?: QueryTimeSlicingParameters;
    index?: IndexedComponent;
};

export type QueryParametersInput<
    ComponentTypes,
    IncludeKeys,
    IndexedComponent
> = {
    /** Flexible queries match entities with any combination of `includes` */
    flexible?: boolean;

    /** These components will be included in the query (must have all unless `flexible` is true) */
    includes?: IncludeKeys;

    /** Entities with these components will be excluded. (this option is not affected by `flexible`) */
    excludes?: Keys<ComponentTypes>[];

    /** Time slicing allows handling fewer entities per tick. Percentage of total Query or exact count per tick. Handled in update tracking as well as for loops. */
    timeSlicing?: QueryTimeSlicingParameters;

    index?: IndexedComponent;
};

export interface QueryState<
    ExactComponentTypes extends defaultComponentTypes,
    Includes extends Keys<ExactComponentTypes>[],
    M extends Manager<ExactComponentTypes> = Manager<ExactComponentTypes>,
    IndexedComponent extends Keys<ExactComponentTypes> = null,
    E = EntityWithComponents<ExactComponentTypes, M, Includes[number]>
> {
    entities: Set<EntityId>;
    consumerStates: ConsumerState<E>[];

    indexed: Map<ExactComponentTypes[IndexedComponent], Set<EntityId>>;

    /** What entities are queued for future slices */
    queuedEntities: Set<EntityId>;
    /** tracks what entities are included in the current slice; cleared on tick. */
    entitiesInSlice: Set<EntityId>;

    lastEntity: EntityId;
    sliceHead: string | null;
    nextSliceHead: string | null;
}

export class Query<
    ExactComponentTypes extends defaultComponentTypes,
    Includes extends Keys<ExactComponentTypes>[],
    M extends Manager<ExactComponentTypes> = Manager<ExactComponentTypes>,
    IndexedComponent extends Keys<ExactComponentTypes> = null,
    E = EntityWithComponents<ExactComponentTypes, M, Includes[number]>
> implements Iterable<E>
{
    Entity: E;
    manager: M;
    queryName: QueryName;

    queryParameters: QueryParameters<
        Partial<ExactComponentTypes>,
        Includes,
        IndexedComponent
    >;

    consumers = new Array<
        Consumer<ExactComponentTypes, Includes, M, IndexedComponent, E>
    >();

    get state() {
        return this.manager.state.queryStates.get(this.queryName) as QueryState<
            ExactComponentTypes,
            Includes,
            M,
            IndexedComponent,
            E
        >;
    }

    get entities() {
        return this.state.entities;
    }

    set entities(v) {
        this.state.entities = v;
    }

    // entities = new Set<entityId>();

    get indexed() {
        return this.state.indexed;
    }
    // indexed: Map<ExactComponentTypes[IndexedComponent], Set<entityId>> =
    //     new Map();

    /** What entities are queued for future slices */
    private get queuedEntities() {
        return this.state.queuedEntities;
    }
    // private queuedEntities = new Set<entityId>();
    /** tracks what entities are included in the current slice; cleared on tick. */
    get entitiesInSlice() {
        return this.state.entitiesInSlice;
    }
    // entitiesInSlice = new Set<entityId>();

    private get lastEntity() {
        return this.manager.getEntity(this.state.lastEntity);
    }
    private set lastEntity(v) {
        if (!v) return;
        this.state.lastEntity = v.id;
    }
    // private lastEntity: E | undefined;
    private get sliceHead() {
        return this.state.sliceHead;
    }
    private set sliceHead(v) {
        this.state.sliceHead = v;
    }
    // private sliceHead: string | null = null;
    private get nextSliceHead() {
        return this.state.nextSliceHead;
    }
    private set nextSliceHead(v) {
        this.state.nextSliceHead = v;
    }
    // private nextSliceHead: string | null = null;

    *[Symbol.iterator]() {
        const sliceSize = this.getSliceSize();

        let active = !sliceSize;
        let count = 0;
        for (let id of this.entities) {
            if (!active && (!this.sliceHead || id === this.sliceHead)) {
                // console.log(
                //     '[Query.iterator] starting loop at sliceHead',
                //     this.sliceHead,
                //     this.entities.size
                // );
                active = true;
            }

            if (!active) continue;

            if (sliceSize && count >= sliceSize) {
                // console.log(
                //     '[Query.iterator] ending loop with nextSliceHead',
                //     id
                // );
                this.nextSliceHead = id;
                return;
            }

            if (active) {
                if (sliceSize) count++;
                yield this.manager.getEntity(id) as E;
            }
        }
        // console.log(
        //     '[Query.iterator] loop ended with',
        //     count,
        //     this.nextSliceHead
        // );
    }
    *IterateIgnoringSlice() {
        for (let id of this.entities) {
            yield this.manager.getEntity(id) as E;
        }
    }

    constructor(
        manager: M,
        parameters: QueryParametersInput<
            Partial<ExactComponentTypes>,
            Includes,
            IndexedComponent
        >
    ) {
        this.manager = manager;

        this.queryName = '';

        this.queryParameters = {
            flexible: parameters.flexible,
            timeSlicing: parameters.timeSlicing,
            index: parameters.index,
        };

        if (parameters.index) {
            this.queryName += `[${parameters.index as string}]`;
        }

        this.queryName += parameters.flexible ? '|' : '&';

        if (parameters.includes) {
            const includesArray = parameters.includes.sort((a, b) =>
                a.toString()[0] > b.toString()[0] ? 1 : -1
            );
            this.queryName +=
                '(' +
                includesArray.map((c) => '+' + c.toString()).join('') +
                ')';

            this.queryParameters.includes = new Set(parameters.includes) as any;
        }
        if (parameters.excludes) {
            const excludesArray = parameters.excludes.sort((a, b) =>
                a.toString()[0] > b.toString()[0] ? 1 : -1
            );
            this.queryName += excludesArray
                .map((c) => '-' + c.toString())
                .join('');

            this.queryParameters.excludes = new Set(parameters.excludes);
        }

        if (manager.state.queryStates.has(this.queryName)) {
            this.queryName += uuid();
        }
        manager.state.queryStates.set(
            this.queryName,
            this.createInitialState()
        );

        // TODO: handle existing entities
        manager.state.entities.forEach((entity) => {
            if (this.entityMatches(entity)) this.addEntity(entity);
        });
    }

    createInitialState(): QueryState<ExactComponentTypes, any, any, any> {
        return {
            entities: new Set(),
            consumerStates: this.consumers.map((consumer) =>
                consumer.createInitialState()
            ),

            indexed: new Map(),

            queuedEntities: new Set(),
            entitiesInSlice: new Set(),

            lastEntity: undefined,
            sliceHead: null,
            nextSliceHead: null,
        };
    }

    componentMatches(component: keyof ExactComponentTypes) {
        return this.queryParameters.includes
            ? this.queryParameters.includes.has(component)
            : this.queryParameters.excludes
            ? !this.queryParameters.excludes.has(component)
            : true;
    }

    entityMatches(entity: E) {
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

    /** for internal use */
    indexEntity(entity: E) {
        // TODO split add and update for performance?

        this.entities.add(entity.id);

        const indexedComponent = this.queryParameters.index as IndexedComponent;

        if (!indexedComponent) return;

        const value = entity.components[indexedComponent];
        const previousValue = entity.previousComponents[indexedComponent];

        if (previousValue && previousValue !== value) {
            this.indexed.get(previousValue)?.delete(entity.id);
        }

        if (value && (!previousValue || value !== previousValue)) {
            if (!this.indexed.has(value)) {
                this.indexed.set(value, new Set());
            }

            const indexSet = this.indexed.get(value);
            indexSet.add(entity.id);
        }
    }

    handleEntity(entity: E) {
        const matches = this.entityMatches(entity);

        if (this.entities.has(entity.id)) {
            if (!matches) {
                this.removeEntity(entity);
            } else {
                this.updatedEntity(entity);
            }
        } else if (matches) {
            this.addEntity(entity);
        }
    }

    private getSliceSize() {
        const { timeSlicing } = this.queryParameters;
        if (!timeSlicing) return 0;

        if ('percentage' in timeSlicing) {
            // TODO get percentage of entities within queue and apply them
            return Math.floor(
                (this.entities.size * timeSlicing.percentage) / 100
            );
        } else if ('count' in timeSlicing) {
            return timeSlicing.count;
        }

        return 0;
    }

    protected updateTimeSlice() {
        const { timeSlicing } = this.queryParameters;
        if (!timeSlicing || !this.queuedEntities.size) return;

        const sliceSize = this.getSliceSize();

        if (this.entitiesInSlice.size >= sliceSize) return;

        for (let queuedEntityId of this.queuedEntities) {
            this.entitiesInSlice.add(queuedEntityId);
            this.queuedEntities.delete(queuedEntityId);
            this.handleEntity(this.manager.getEntity(queuedEntityId));

            if (this.entitiesInSlice.size >= sliceSize) return;
        }
    }

    addEntity(entity: E) {
        this.consumers.forEach((c) => c.add(entity.id));
        this.indexEntity(entity);

        if (!this.manager.state.queryMap.has(entity.id)) {
            this.manager.state.queryMap.set(entity.id, new Set());
        }
        this.manager.state.queryMap.get(entity.id)?.add(this.queryName);
        this.lastEntity = entity as E;

        console.log('[QUERY]', this.queryName, 'added entity', entity.id);
    }

    updatedEntity(entity: E) {
        if (!this.entities.has(entity.id)) return;

        throttleLog('[QUERY]', this.queryName, 'updated entity', entity.id);
        this.indexEntity(entity);

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

    removeEntity(entity: E) {
        this.entities.delete(entity.id);
        this.queuedEntities.delete(entity.id);
        this.entitiesInSlice.delete(entity.id);
        this.consumers.forEach((c) => {
            c.remove(entity);
        });

        if (this.queryParameters.index) {
            this.indexed
                .get(
                    (entity.components[
                        this.queryParameters.index
                    ] as ExactComponentTypes[IndexedComponent]) ||
                        (entity.previousComponents[
                            this.queryParameters.index
                        ] as ExactComponentTypes[IndexedComponent])
                )
                ?.delete(entity.id);
        }

        if (this.lastEntity === entity) {
            const lastID = Array.from(this.entities).pop();
            this.lastEntity = lastID
                ? (this.manager.getEntity(lastID) as E)
                : undefined;
        }

        this.manager.state.queryMap.get(entity.id)?.delete(this.queryName);
        console.log('[QUERY]', this.queryName, 'removed entity', entity.id);
    }

    get size() {
        return this.entities.size;
    }

    for(
        handler: (entity: E, delta?: number) => boolean | void,
        delta?: number
    ) {
        for (let entity of this[Symbol.iterator]()) {
            if (handler(entity, delta)) return;
        }
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

    // TODO iterator
    get(
        indexedValue: ExactComponentTypes[IndexedComponent]
    ): Set<typeof this.Entity> {
        if (!this.queryParameters.index) {
            throw new Error(
                '[Query] ' + this.queryName + ' does not have indexed entities'
            );
        }

        return (this.indexed.get(indexedValue) || new Set()).map(
            (id) => this.manager.getEntity(id) as typeof this.Entity
        );
    }

    find(handler: (entity: E) => boolean) {
        for (let possibleEntity of this.IterateIgnoringSlice()) {
            if (handler(possibleEntity)) {
                return possibleEntity;
            }
        }
    }

    filter(handler: (entity: E) => boolean) {
        let foundEntities: E[] = [];

        for (let possibleEntity of this.IterateIgnoringSlice()) {
            if (handler(possibleEntity)) {
                foundEntities.push(possibleEntity);
            }
        }

        return foundEntities;
    }

    tick() {
        this.consumers.forEach((c) => c.tick());

        this.entitiesInSlice.clear();
        this.updateTimeSlice();

        this.sliceHead = this.nextSliceHead;
        this.nextSliceHead = null;
    }
}

export interface ConsumerState<E> {
    updatedEntities: Set<EntityId>;
    newEntities: Set<EntityId>;
    deletedEntities: Set<E>;
    consumed: boolean;
    consumedEntities: Set<EntityId>;
}

// TODO: revisit this.consumed concept
/** Consumers track updated and new entities until consumed for a given Query */
export class Consumer<
    ExactComponentTypes extends defaultComponentTypes,
    Includes extends Keys<ExactComponentTypes>[],
    M extends Manager<ExactComponentTypes> = Manager<ExactComponentTypes>,
    IndexedComponent extends Keys<ExactComponentTypes> = null,
    E = EntityWithComponents<ExactComponentTypes, M, Includes[number]>
> {
    query: Query<ExactComponentTypes, Includes, M, IndexedComponent, E>;

    consumerId: number;

    get state() {
        let state = this.query.state.consumerStates[this.consumerId];
        if (!state) {
            state = this.createInitialState();
            this.query.state.consumerStates[this.consumerId] = state;
        }
        return state;
    }

    // updatedEntities = new Set<entityId>();
    get updatedEntities() {
        return this.state.updatedEntities;
    }
    set updatedEntities(v) {
        this.state.updatedEntities = v;
    }

    // newEntities = new Set<entityId>();
    get newEntities() {
        return this.state.newEntities;
    }
    set newEntities(v) {
        this.state.newEntities = v;
    }

    // deletedEntities = new Set<typeof this.query.manager.Entity>();
    get deletedEntities() {
        return this.state.deletedEntities;
    }
    set deletedEntities(v) {
        this.state.deletedEntities = v;
    }

    // consumed = false;
    get consumed() {
        return this.state.consumed;
    }
    set consumed(v) {
        this.state.consumed = v;
    }

    // consumedEntities = new Set<entityId>();
    get consumedEntities() {
        return this.state.consumedEntities;
    }
    set consumedEntities(v) {
        this.state.consumedEntities = v;
    }

    constructor(
        query: Query<ExactComponentTypes, Includes, M, IndexedComponent, E>
    ) {
        this.query = query;

        this.consumerId = query.consumers.length;

        query.state.consumerStates[this.consumerId] = this.createInitialState();

        if (query.entities.size) {
            query.entities.forEach((entity) => this.add(entity));
        }
    }

    createInitialState(): ConsumerState<E> {
        return {
            updatedEntities: new Set(),
            newEntities: new Set(),
            deletedEntities: new Set(),
            consumed: false,
            consumedEntities: new Set(),
        };
    }

    clear() {
        this.updatedEntities = new Set();
        this.newEntities = new Set();
        this.deletedEntities = new Set();
        this.consumed = false;
        this.consumedEntities = new Set();
    }

    /** called by Query when adding an entity, for internal use */
    add(id: EntityId) {
        this.newEntities.add(id);
        const deletedEntity = this.deletedEntities.find((e) => e.id === id);
        if (deletedEntity) {
            this.deletedEntities.delete(deletedEntity);
        }
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
    updated(id: EntityId) {
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
