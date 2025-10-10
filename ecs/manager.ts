import {
    ReceiveType,
    ReflectionClass,
    resolveReceiveType,
} from '@deepkit/type';
import { each } from 'lodash';
import uuid from 'uuid-random';
import { memoizedGlobalNow, now } from '../util/now';
import { keys } from './dict';
import { Vector2, Vector3 } from 'three';
import './object.extensions.ts';
import {
    Consumer,
    Query,
    QueryName,
    QueryParametersInput,
    QueryState,
} from './query';
import { ConsumerSystem, QuerySystem, System } from './system';
import { endPerformanceMeasure, startPerformanceMeasure } from './performance';

export type Keys<T> = keyof T;
export type EntityId = string;

export type Entity<ComponentTypes> = {
    id: EntityId;
    previousComponents: Readonly<ComponentTypes>;
    components: ComponentTypes;
    /** flag a deeper update to a component */
    flagUpdate: (componentType: keyof ComponentTypes) => void;

    /** quietly update a component (avoid update flagging) */
    quietSet: <T extends keyof ComponentTypes>(
        componentType: T,
        value: ComponentTypes[T]
    ) => void;
};

type EntitiesById<ComponentTypes> = Map<EntityId, Entity<ComponentTypes>>; //{ [id: string]: Entity<ComponentTypes> };
type EntityMap<ComponentTypes> = Map<Keys<ComponentTypes>, Set<EntityId>>; //{ [type in Keys<ComponentTypes>]?: Set<string> };
type ComponentMap<ComponentTypes> = Map<EntityId, Set<Keys<ComponentTypes>>>; //{ [id: string]: Set<Keys<ComponentTypes>> }; // TODO do we actually need ComponentMap for anything?
type QueryMap = Map<EntityId, Set<QueryName>>; //{ [id: string]: Set<Keys<ComponentTypes>> }; // TODO do we actually need ComponentMap for anything?

export type EntityAdminState<
    ComponentTypes,
    ExactComponentTypes extends defaultComponentTypes
> = {
    entities: EntitiesById<ComponentTypes>;
    /** Maps entity type to set of Entity Ids */
    entityMap: EntityMap<ComponentTypes>;
    /** Maps entity Id to set of ComponentTypes */
    componentMap: ComponentMap<ComponentTypes>;
    /** Maps entity Id to set of queries */
    queryMap: QueryMap;

    /** Queries effectively define archetypes and maintain performant query sets according to actual system needs */
    // TODO improve types
    queries: Map<string, Query<ExactComponentTypes, any, any, any, any>>;
    queryStates: Map<
        string,
        QueryState<ExactComponentTypes, any, any, any, any>
    >;
    // consumerStates: Array<>

    stagedUpdates: Map<Keys<ExactComponentTypes>, Set<EntityId>>;

    newEntities: Set<EntityId>;
    updatedEntities: Set<EntityId>;
    previouslyUpdatedEntities: Set<EntityId>;
    deletedEntities: Set<Entity<ComponentTypes>>;
};

export type defaultComponentTypes = {
    ownerId: string;
    createdAt: number;
    updatedAt: number;
};

export type EntityWithComponents<
    ExactComponentTypes extends defaultComponentTypes,
    M extends Manager<ExactComponentTypes>,
    Components extends Keys<ExactComponentTypes>
> = M['Entity'] & {
    components: {
        [K in Components]: ExactComponentTypes[K];
    };
};

// TODO: add `clone` method? Handle queries being made in a singleton manner.
// TODO: tie query/consumer and system together more meaningfully for performance and cleanup
export class Manager<ExactComponentTypes extends defaultComponentTypes> {
    readonly ComponentTypes: Partial<ExactComponentTypes>;
    readonly State: EntityAdminState<
        typeof this.ComponentTypes,
        ExactComponentTypes
    >;
    readonly Entity: Entity<typeof this.ComponentTypes>;
    componentTypesSet: Readonly<Set<keyof ExactComponentTypes>>;
    componentNames: readonly Keys<ExactComponentTypes>[];

    state: ReturnType<typeof this.createInitialState>;

    componentsReflection: ReflectionClass<ComponentTypes>;

    /**
     *
     * @param componentNames [DO NOT PASS] This is dynamic now and can be accessed at `new Manager<*>().componentNames` if needed
     */
    constructor(componentNames?: ReceiveType<ExactComponentTypes>) {
        if (
            componentNames instanceof Array &&
            typeof componentNames[0] === 'string'
        ) {
            console.warn(
                '[new Manager()] componentNames parameter is deprecated and should not be passed, instead its dynamically created from types. If you still need access to it you can get it from `new Manager<*>().componentNames`'
            );
            console.error(
                'Do not pass componentNames to new Manager() to resolve this:'
            );
        }
        const type = resolveReceiveType(componentNames);

        const reflection = (this.componentsReflection =
            ReflectionClass.from(type));

        const extractedComponentNames = reflection
            .getProperties()
            .map((p) => p.name) as readonly Keys<ExactComponentTypes>[];

        this.componentNames = extractedComponentNames;
        this.componentTypesSet = new Set(extractedComponentNames);

        this.state = this.createInitialState();
    }

    setState(
        newState:
            | typeof this.State
            | ((state: typeof this.State) => typeof this.State)
    ) {
        if (newState instanceof Function) {
            this.state = newState(this.state);
        } else {
            this.state = newState;
        }
    }

    createInitialState() {
        const newState: EntityAdminState<
            typeof this.ComponentTypes,
            ExactComponentTypes
        > = {
            entities: new Map(),
            entityMap: new Map(),
            componentMap: new Map(),
            queryMap: new Map(),

            queries: new Map(),
            queryStates: new Map(),

            stagedUpdates: new Map(),

            newEntities: new Set(),
            previouslyUpdatedEntities: new Set(),
            updatedEntities: new Set(),
            deletedEntities: new Set(),
        };

        this.componentTypesSet.forEach((type) => {
            newState.stagedUpdates.set(type, new Set());
        });

        return newState;
    }

    resetState() {
        const oldState = this.state;
        const newState = this.createInitialState();

        oldState.queries.forEach((query) => {
            query.resetConsumers();
            newState.queries.set(query.queryName, query);
        });

        this.state = newState;
    }

    createQuery<
        Includes extends Keys<ExactComponentTypes>[],
        IndexedComponent extends Keys<ExactComponentTypes>
    >(
        queryParameters: QueryParametersInput<
            typeof this.ComponentTypes,
            Includes,
            IndexedComponent
        >
    ) {
        const query = new Query(this, queryParameters);

        if (this.state.queries.has(query.queryName))
            return this.state.queries.get(query.queryName) as Query<
                ExactComponentTypes,
                Includes
            >;

        this.state.queries.set(query.queryName, query);

        return query;
    }

    createSystem<Includes extends Keys<ExactComponentTypes>[]>(
        source: Partial<
            System<ExactComponentTypes, Manager<ExactComponentTypes>, Includes>
        >
    ): System<ExactComponentTypes, Manager<ExactComponentTypes>, Includes>;
    createSystem<
        Includes extends Keys<ExactComponentTypes>[],
        IndexedComponent extends Keys<ExactComponentTypes> = null
    >(
        source: Query<
            ExactComponentTypes,
            Includes,
            Manager<ExactComponentTypes>,
            IndexedComponent
        >,
        system: Partial<QuerySystem<ExactComponentTypes, Includes>>
    ): QuerySystem<ExactComponentTypes, Includes>;
    createSystem<
        Includes extends Keys<ExactComponentTypes>[],
        IndexedComponent extends Keys<ExactComponentTypes> = null
    >(
        source: ReturnType<
            Query<
                ExactComponentTypes,
                Includes,
                Manager<ExactComponentTypes>,
                IndexedComponent
            >['createConsumer']
        >,
        system: Partial<ConsumerSystem<ExactComponentTypes, Includes>>
    ): ConsumerSystem<ExactComponentTypes, Includes>;
    createSystem<
        Includes extends Keys<ExactComponentTypes>[],
        IndexedComponent extends Keys<ExactComponentTypes> = null
    >(
        sourceOrSystem:
            | Partial<
                  System<
                      ExactComponentTypes,
                      Manager<ExactComponentTypes>,
                      Includes
                  >
              >
            | Query<
                  ExactComponentTypes,
                  Includes,
                  Manager<ExactComponentTypes>,
                  IndexedComponent
              >
            | ReturnType<
                  Query<ExactComponentTypes, Includes>['createConsumer']
              >,
        system?:
            | Partial<
                  QuerySystem<
                      ExactComponentTypes,
                      Includes,
                      Manager<ExactComponentTypes>,
                      IndexedComponent
                  >
              >
            | Partial<ConsumerSystem<ExactComponentTypes, Includes>>
    ):
        | System<ExactComponentTypes, Manager<ExactComponentTypes>, Includes>
        | QuerySystem<ExactComponentTypes, Includes>
        | ConsumerSystem<ExactComponentTypes, Includes> {
        if (system) {
            if (!system.tag) {
                if (sourceOrSystem instanceof Query) {
                    system.tag = `System[${sourceOrSystem.queryName}]`;
                } else if (sourceOrSystem instanceof Consumer) {
                    system.tag = `System[CONSUMER:${sourceOrSystem.query.queryName}]`;
                }
            }
            return { source: sourceOrSystem, ...system };
        } else {
            if (!sourceOrSystem.tag)
                sourceOrSystem.tag = 'UntaggedSystem[' + now() + ']';
            return sourceOrSystem;
        }
    }

    createEntity(id = uuid()): typeof this.Entity {
        const timestamp = now();

        const manager = this;

        function flagUpdate(
            entity: typeof this.Entity,
            componentType: keyof ExactComponentTypes
        ) {
            manager.state.stagedUpdates.get(componentType)?.add(id);

            const value = entity.components[componentType];
            if (
                value &&
                (value instanceof Vector2 || value instanceof Vector3)
            ) {
                if (!entity.previousComponents[componentType]) {
                    entity.previousComponents[componentType] = value.clone();
                } else {
                    entity.previousComponents[componentType].copy(value);
                }
            }
        }

        const components = {
            createdAt: timestamp,
            updatedAt: timestamp,
        } as typeof this.ComponentTypes;

        const entity = {
            id,
            previousComponents: {},
            components: new Proxy(components, {
                set(target, componentType, value = null) {
                    // TODO handle setting undefined (should removeComponent)

                    try {
                        const reflectionType =
                            manager.componentsReflection.hasProperty(
                                componentType
                            )
                                ? manager.componentsReflection.getProperty(
                                      componentType
                                  )
                                : manager.componentsReflection.getMethod(
                                      componentType
                                  );

                        if (
                            reflectionType.type.decorators?.find(
                                (d) => d.typeName === 'SingletonComponent'
                            ) &&
                            manager.state.entityMap.get(componentType as any)
                                ?.size > 1
                        ) {
                            throw new Error(
                                `[Entity.components.${
                                    componentType as string
                                }] singleton component being used more than once.`
                            );
                        }
                    } catch (e) {
                        console.warn(
                            'Error finding type info for componentType',
                            componentType
                        );
                    }

                    const entityIsRegistered = manager.state.entities.has(id);

                    if (componentType !== 'updatedAt' && entityIsRegistered) {
                        if (
                            (value instanceof Vector2 ||
                                value instanceof Vector3) &&
                            target[componentType]
                        ) {
                            if (!entity.previousComponents[componentType]) {
                                entity.previousComponents[componentType] =
                                    target[componentType].clone();
                            } else {
                                entity.previousComponents[componentType].copy(
                                    target[componentType]
                                );
                            }
                        } else {
                            entity.previousComponents[componentType] =
                                target[componentType];

                            if (target[componentType] !== value) {
                                flagUpdate(
                                    entity,
                                    componentType as keyof ExactComponentTypes
                                );
                            }
                        }
                    }

                    let newComponent = false;
                    if (!(componentType in target)) {
                        newComponent = true;
                    }
                    target[componentType] = value;

                    if (entityIsRegistered && newComponent) {
                        const existingQueryMappings =
                            manager.state.queryMap.get(entity.id);

                        // TODO should be in subTick?
                        manager.state.queries.forEach((query, queryName) => {
                            if (
                                query.componentMatches(
                                    componentType as keyof ExactComponentTypes
                                )
                            ) {
                                query.handleEntity(entity);
                            } else if (
                                existingQueryMappings?.has(queryName) &&
                                !query.entityMatches(entity)
                            ) {
                                query.removeEntity(entity);
                            }
                        });
                        manager.addEntityMapping(
                            entity,
                            componentType as keyof ExactComponentTypes
                        );
                    }

                    return true;
                },
                deleteProperty(target, p) {
                    // @ts-ignore
                    entity.previousComponents[p as keyof ExactComponentTypes] =
                        entity.components[p as keyof ExactComponentTypes];
                    delete target[p];
                    manager.removeEntityMapping(
                        entity,
                        p as keyof ExactComponentTypes
                    );
                    return true;
                },
            }),
            flagUpdate: (componentType: keyof ExactComponentTypes) =>
                flagUpdate(entity, componentType),
            quietSet(componentType, value) {
                components[componentType] = value;
            },
        } as typeof this.Entity;

        return entity;
    }

    /** Creates or gets entity, add components and registers it immediately */
    quickEntity(components: Partial<ExactComponentTypes>, id = uuid()) {
        const entity = this.getEntity(id) || this.createEntity(id);
        this.addComponents(entity, components);
        this.registerEntity(entity);

        return entity;
    }

    cloneEntity(
        entity: typeof this.Entity,
        exclude: Array<keyof ExactComponentTypes> = []
    ) {
        const newEntity = this.createEntity();

        for (let component in entity.components) {
            if (exclude.includes(component)) continue;
            newEntity.components[component] = entity.components[component];
        }

        return newEntity;
    }

    protected updatedEntity(
        entity: typeof this.Entity,
        firstTime = false,
        updateAllQueries = true
    ) {
        if (!firstTime) entity.components.updatedAt = now();
        this.state.updatedEntities.add(entity.id);

        if (updateAllQueries) {
            this.state.queryMap.get(entity.id)?.forEach((queryName) => {
                this.state.queries.get(queryName)?.updatedEntity(entity);
            });
        }
    }

    /** to be called after each system */
    subTick() {
        startPerformanceMeasure(this);
        const { state } = this;
        state.stagedUpdates.forEach((componentUpdates, componentType) => {
            componentUpdates.forEach((entityId) => {
                const entity = this.getEntity(entityId);
                if (entity && !this.state.updatedEntities.has(entityId)) {
                    this.updatedEntity(entity, false, false);
                }

                this.state.queryMap.get(entityId)?.forEach((queryName) => {
                    const query = this.state.queries.get(queryName);
                    if (query?.componentMatches(componentType)) {
                        query?.updatedEntity(entity);
                        // throttleLog(
                        //     '[subTick] update',
                        //     entityId,
                        //     componentType,
                        //     query.queryName
                        // );
                    } else if (query.queryParameters.index === componentType) {
                        query.indexEntity(entity);
                    }
                });
            });

            componentUpdates.clear();
        });
        endPerformanceMeasure(this);
    }

    tickHandlers = new Set<() => void>();

    /** to be called after each set of systems (end of a frame) */
    tick() {
        startPerformanceMeasure(this);
        this.subTick();

        const { state } = this;
        state.previouslyUpdatedEntities.clear();
        state.newEntities.clear();

        // TODO more efficient?
        state.updatedEntities.forEach((e) =>
            state.previouslyUpdatedEntities.add(e)
        );
        state.updatedEntities.clear();
        state.deletedEntities.clear();

        this.state.queries.forEach((q) => q.tick());

        this.tickHandlers.forEach((h) => {
            h();
            this.tickHandlers.delete(h);
        });

        memoizedGlobalNow.cache.clear?.();
        endPerformanceMeasure(this);
    }

    // TODO handle deserialized (no proxy or flagUpdate)
    registerEntity(entity: typeof this.Entity) {
        if (this.entityExists(entity.id)) return;
        const { state } = this;

        state.entities.set(entity.id, entity);
        this.updatedEntity(entity, true, false);

        keys(entity.components).forEach((key) => {
            this.addEntityMapping(entity, key);
        });

        // TODO: optimize this a bit?
        this.state.queries.forEach((query, queryName) => {
            query.handleEntity(entity);
        });

        return entity;
    }

    deregisterEntity(entity: typeof this.Entity) {
        const { state } = this;
        keys(entity.components).forEach((key) => {
            this.removeEntityMapping(entity, key);
        });

        state.entities.delete(entity.id);
        state.componentMap.delete(entity.id);
        state.deletedEntities.add(entity);

        this.state.queryMap.get(entity.id)?.forEach((queryName) => {
            const query = this.state.queries.get(queryName);

            query?.removeEntity(entity);
            this.state.queryMap.get(entity.id)?.delete(queryName);
        });

        this.updatedEntity(entity, false, false);
    }

    addEntityMapping(
        entity: typeof this.Entity,
        componentType: Keys<typeof this.ComponentTypes>
    ) {
        const { state } = this;
        if (!state.entityMap.has(componentType))
            state.entityMap.set(componentType, new Set());
        state.entityMap.get(componentType)?.add(entity.id);

        if (!state.componentMap.has(entity.id))
            state.componentMap.set(entity.id, new Set());
        state.componentMap.get(entity.id)?.add(componentType);
    }

    // TODO double check we aren't doubling removing from query with deregisterEntity
    removeEntityMapping(
        entity: typeof this.Entity,
        componentType: Keys<typeof this.ComponentTypes>
    ) {
        const { state } = this;
        state.entityMap.get(componentType)?.delete(entity.id);
        state.componentMap.get(entity.id)?.delete(componentType);
        // TODO add new mappings!

        this.state.queryMap.get(entity.id)?.forEach((queryName) => {
            const query = this.state.queries.get(queryName);

            if (query.queryParameters.index === componentType) {
                query.indexEntity(entity);
            }

            if (!query?.componentMatches(componentType)) {
                return;
            }

            query?.removeEntity(entity);
        });

        this.state.queries.forEach((query) => {
            if (
                query.queryParameters.excludes?.has(componentType) &&
                query.entityMatches(entity)
            ) {
                query.addEntity(entity);
            }
        });
    }

    getEntity(id: string) {
        return this.state.entities.get(id);
    }

    entityExists(id: string) {
        return this.state.entities.has(id);
    }

    getSingletonEntity<
        K extends Keys<typeof this.ComponentTypes>,
        E = EntityWithComponents<
            ExactComponentTypes,
            Manager<ExactComponentTypes>,
            K
        >
    >(componentType: K): E {
        // TODO: should we share all singleton under one roof?
        if (!this.entityExists(componentType as string)) {
            const entity = this.createEntity(componentType as string);
            // this.addComponent(entity, componentType);
            this.registerEntity(entity);

            return entity as E;
        }

        return this.getEntity(componentType as string) as E;
    }

    setSingletonEntityComponent<K extends Keys<typeof this.ComponentTypes>>(
        componentType: K,
        value: (typeof this.ComponentTypes)[K]
    ) {
        const entity = this.getSingletonEntity(componentType);
        entity.components[componentType] = value;

        return entity;
    }

    getSingletonEntityComponent<K extends Keys<typeof this.ComponentTypes>>(
        componentType: K
    ): (typeof this.ComponentTypes)[K] {
        return this.getComponent(
            this.getSingletonEntity(componentType),
            componentType
        );
    }

    getEntityIds(componentType: Keys<typeof this.ComponentTypes>): Set<string> {
        // TODO: optimize?
        const { state } = this;
        const entityMap = state.entityMap.get(componentType);
        return entityMap || new Set();
    }

    /**
     * Get all Entities that have a component of type
     */
    // TODO introduce forEntities (and with and of)
    getEntities<
        K extends Keys<typeof this.ComponentTypes>,
        E = EntityWithComponents<
            ExactComponentTypes,
            Manager<ExactComponentTypes>,
            K
        >
    >(componentType: K): Set<E> {
        // TODO update this to handle removing component type mapping at point of lookup?
        return this.getEntityIds(componentType).map(
            (id) => this.getEntity(id) as E
        );
    }

    /** Run `handler` for every entity with `componentType` ends early if `handler` returns `true` */
    for(
        componentType: Keys<typeof this.ComponentTypes>,
        handler: (entity: typeof this.Entity) => boolean
    ) {
        this.getEntityIds(componentType).forEach((id) =>
            handler(this.getEntity(id))
        );
    }

    /** Get Entities that have these specific component types (intersection) */
    getEntitiesWith<
        K extends Keys<typeof this.ComponentTypes>,
        E = EntityWithComponents<
            ExactComponentTypes,
            Manager<ExactComponentTypes>,
            K
        >
    >(types: Set<K>): Set<E> {
        const { state } = this;
        const entityMaps = types.map(
            (type) => state.entityMap.get(type) || new Set<string>()
        );

        const intersectedEntities = (
            entityMaps.first() || new Set<string>()
        ).intersect(...entityMaps);

        return intersectedEntities.map((id) => this.getEntity(id) as E);
    }

    getEntityIdsOf(types: Set<Keys<typeof this.ComponentTypes>>): Set<string> {
        return types.reduce(
            (entities, type) => entities.union(this.getEntityIds(type)),
            new Set<string>()
        );
    }

    /** Get all entities that have any of a set of component types */
    getEntitiesOf(
        types: Set<Keys<typeof this.ComponentTypes>>
    ): Set<typeof this.Entity> {
        return types.reduce(
            (entities, type) => entities.union(this.getEntities(type)),
            new Set<typeof this.Entity>()
        );
    }

    addComponent<
        T extends typeof this.Entity,
        K extends Keys<typeof this.ComponentTypes>,
        E = EntityWithComponents<
            ExactComponentTypes,
            Manager<ExactComponentTypes>,
            K
        >
    >(entity: T, type: K, value: (typeof this.ComponentTypes)[K]): E {
        entity.components[type] = value;
        return entity as any as E;
    }

    removeComponent<
        T extends typeof this.Entity,
        K extends Keys<typeof this.ComponentTypes>
    >(entity: T, type: K) {
        delete entity.components[type];
        return entity;
    }

    addComponents(
        entity: typeof this.Entity,
        components: typeof this.ComponentTypes
    ) {
        each(components, (value, type) => {
            entity = this.addComponent(
                entity,
                type as keyof ExactComponentTypes,
                value
            );
        });

        return entity;
    }

    updateComponent<
        T extends typeof this.Entity,
        K extends Keys<typeof this.ComponentTypes>,
        E = EntityWithComponents<
            ExactComponentTypes,
            Manager<ExactComponentTypes>,
            K
        >
    >(
        entity: T,
        type: K,
        modifier:
            | (typeof this.ComponentTypes)[K]
            | ((
                  currentValue: (typeof this.ComponentTypes)[K]
              ) => (typeof this.ComponentTypes)[K])
    ): E {
        // Weird fix for typescript issue (can't use K here), and cant cast as const even with type as...
        const path = ['components', type] as const;

        const currentValue = entity.components[type];

        entity.components[type] =
            modifier instanceof Function ? modifier(currentValue) : modifier;

        return entity as any as E;
    }

    getComponent<K extends Keys<typeof this.ComponentTypes>>(
        entity: typeof this.Entity,
        type: K
    ): (typeof this.ComponentTypes)[K] {
        return entity.components[type];
    }
}
