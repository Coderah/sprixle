import { getBSONDeserializer, getBSONSerializer } from '@deepkit/bson';
import {
    groupAnnotation,
    ReceiveType,
    ReflectionClass,
    resolveReceiveType,
} from '@deepkit/type';
import { each } from 'lodash';
import { Vector2, Vector3 } from 'three';
import uuid from 'uuid-random';
import '../data/bsonPointerSerializer';
import { setSerializationManagerContext } from '../data/bsonPointerSerializer';
import { memoizedGlobalNow, now } from '../util/now';
import { keys } from './dict';
import './object.extensions';
import { endPerformanceMeasure, startPerformanceMeasure } from './performance';
import { PooledMap } from './pool';
import {
    Consumer,
    Query,
    QueryName,
    QueryParametersInput,
    QueryState,
} from './query';
import { ConsumerSystem, QuerySystem, System } from './system';
import { Annotations } from './types';

export type Keys<T> = keyof T;
export type EntityId = string | bigint;

export type Entity<ComponentTypes> = {
    id: EntityId;
    components: ComponentTypes;
    previousComponents: Readonly<ComponentTypes>;
    /** @deprecated use `willUpdate` instead. */
    flagUpdate: (componentType: keyof ComponentTypes) => void;
    /** flag a deeper update to a component, call this before changing values within a component's data structure. */
    willUpdate: (componentType: keyof ComponentTypes) => void;

    /** quietly update a component (avoid update flagging) */
    quietSet: <T extends keyof ComponentTypes>(
        componentType: T,
        value: ComponentTypes[T]
    ) => void;
};

export type SerializableEntity<ComponentTypes> = Omit<
    Entity<ComponentTypes>,
    'previousComponents' | 'quietSet' | 'flagUpdate' | 'willUpdate'
>;

type EntityMap<ComponentTypes> = Map<Keys<ComponentTypes>, Set<EntityId>>; //{ [type in Keys<ComponentTypes>]?: Set<string> };
type ComponentMap<ComponentTypes> = Map<EntityId, Set<Keys<ComponentTypes>>>; //{ [id: EntityId]: Set<Keys<ComponentTypes>> }; // TODO do we actually need ComponentMap for anything?
type QueryMap = Map<EntityId, Set<QueryName>>; //{ [id: EntityId]: Set<Keys<ComponentTypes>> }; // TODO do we actually need ComponentMap for anything?

// TODO use pooled objects for more things.
export type EntityAdminState<
    ComponentTypes,
    ExactComponentTypes extends defaultComponentTypes,
    E = Entity<ComponentTypes>
> = {
    entities: Map<EntityId, E>;
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

    stagedUpdates: PooledMap<EntityId, Set<Keys<ExactComponentTypes>>>;

    newEntities: Set<EntityId>;
    updatedEntities: Set<EntityId>;
    previouslyUpdatedEntities: Set<EntityId>;
    deletedEntities: Set<E>;
};

export type SerializableState<
    ComponentTypes,
    ExactComponentTypes extends defaultComponentTypes,
    SerializableEntity
> = Omit<
    EntityAdminState<ComponentTypes, ExactComponentTypes, SerializableEntity>,
    'queries' | 'stagedUpdates'
> & {
    stagedUpdates: Map<EntityId, Set<Keys<ComponentTypes>>>;
};

export type defaultComponentTypes = {
    ownerId: EntityId;
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
    readonly ComponentTypes!: Partial<ExactComponentTypes>;
    readonly State!: EntityAdminState<
        typeof this.ComponentTypes,
        ExactComponentTypes
    >;
    readonly Entity!: Entity<typeof this.ComponentTypes>;
    componentTypesSet: Readonly<Set<keyof ExactComponentTypes>>;
    componentNames: readonly Keys<ExactComponentTypes>[];
    componentAnnotations: Record<keyof ExactComponentTypes, Set<Annotations>>;

    state: EntityAdminState<typeof this.ComponentTypes, ExactComponentTypes>;
    plugins: Map<string, any> = new Map();

    componentsReflection: ReflectionClass<ExactComponentTypes>;

    genId: () => EntityId = uuid;

    // Global registry for pointer serialization/deserialization
    private static globalPointerRegistry = new Map<
        string,
        {
            forward: Map<any, any>;
            reverse: Map<any, any>;
        }
    >();

    private static instanceCounter = 0;
    private instanceId: string;

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

        // Initialize instance ID for pointer registry
        this.instanceId = `manager-${Manager.instanceCounter++}`;

        const type = resolveReceiveType(componentNames);

        const reflection = (this.componentsReflection =
            ReflectionClass.from(type));

        const extractedComponentNames = reflection
            .getProperties()
            .map((p) => p.name) as readonly Keys<ExactComponentTypes>[];

        const componentAnnotations = reflection
            .getProperties()
            .reduce((result, p) => {
                result[p.name] = new Set(
                    groupAnnotation.getAnnotations(p.type)
                );
                return result;
            }, {}) as Record<keyof ExactComponentTypes, Set<Annotations>>;

        this.componentNames = extractedComponentNames;
        this.componentTypesSet = new Set(extractedComponentNames);
        this.componentAnnotations = componentAnnotations;

        this.state = this.createInitialState();
    }

    patchHandlers?: {
        register?: (entity: Entity<Partial<ExactComponentTypes>>) => void;
        components?: (
            id: EntityId,
            components: Partial<ExactComponentTypes>
        ) => void;
        removeComponent?: (
            id: EntityId,
            component: keyof ExactComponentTypes
        ) => void;
        deregister?: (entity: Entity<Partial<ExactComponentTypes>>) => void;
    };

    /**
     * Register pointer data sources that can be referenced by Pointer<T, name> types.
     * @param dataSources Object mapping data source names to their source maps/records
     */
    registerPointers(
        dataSources: Record<string, Record<string, any> | Map<unknown, any>>
    ) {
        for (const [dataSourceName, source] of Object.entries(dataSources)) {
            const forward = new Map<any, any>();
            const reverse = new Map<any, any>();

            if (source instanceof Map) {
                for (const [key, value] of source.entries()) {
                    forward.set(key, value);
                    reverse.set(value, key);
                }
            } else {
                for (const [key, value] of Object.entries(source)) {
                    forward.set(key, value);
                    reverse.set(value, key);
                }
            }

            // Store in global registry for serializers
            const registryKey = `${this.instanceId}:${dataSourceName}`;
            Manager.globalPointerRegistry.set(registryKey, {
                forward,
                reverse,
            });
            console.log('register data pointer:', registryKey);
        }
    }

    /**
     * Get pointer registry for serialization - used by BSON serializers
     * @internal
     */
    static getPointerRegistry(managerId: string, dataSourceName: string) {
        return Manager.globalPointerRegistry.get(
            `${managerId}:${dataSourceName}`
        );
    }

    /**
     * Create a serializer function that handles pointer components
     */
    createSerializer<T>(type?: ReceiveType<T>) {
        const managerId = this.instanceId;
        setSerializationManagerContext(managerId);
        const serializer = getBSONSerializer<T>();

        return serializer;
    }

    /**
     * Create a deserializer function that handles pointer components
     */
    createDeserializer<T>(type?: ReceiveType<T>) {
        const managerId = this.instanceId;
        setSerializationManagerContext(managerId);
        const deserializer = getBSONDeserializer<T>();

        return deserializer;
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

    createInitialState(
        importableState?: SerializableState<
            Partial<ExactComponentTypes>,
            ExactComponentTypes,
            SerializableEntity<Partial<ExactComponentTypes>>
        >
    ) {
        const newState: EntityAdminState<
            typeof this.ComponentTypes,
            ExactComponentTypes
        > = {
            entities: new Map(),
            entityMap: importableState?.entityMap || new Map(),
            componentMap: importableState?.componentMap || new Map(),
            queryMap: importableState?.queryMap || new Map(),

            queries: this.state?.queries || new Map(),
            queryStates: importableState?.queryStates || new Map(),

            stagedUpdates:
                this.state?.stagedUpdates ||
                new PooledMap(
                    () => new Set(),
                    (s) => s.clear()
                ),

            newEntities: importableState?.newEntities || new Set(),
            previouslyUpdatedEntities:
                importableState?.previouslyUpdatedEntities || new Set(),
            updatedEntities: importableState?.updatedEntities || new Set(),
            deletedEntities: new Set(),
        };

        if (importableState) {
            for (let importableEntity of importableState.entities.values()) {
                newState.entities.set(
                    importableEntity.id,
                    this.createEntity(importableEntity)
                );
            }
        }

        newState.stagedUpdates.clear();

        this.state?.queries.forEach((query) => {
            if (newState.queryStates.has(query.queryName)) return;
            newState.queryStates.set(
                query.queryName,
                query.createInitialState()
            );
        });

        return newState;
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

    protected flagUpdate(
        entity: Entity<Partial<ExactComponentTypes>>,
        componentType: keyof ExactComponentTypes
    ) {
        this.state.stagedUpdates.getOrCreate(entity.id).add(componentType);

        const value = entity.components[componentType];
        if (value && (value instanceof Vector2 || value instanceof Vector3)) {
            if (!entity.previousComponents[componentType]) {
                // @ts-ignore
                entity.previousComponents[componentType] = value.clone();
            } else {
                // @ts-ignore
                entity.previousComponents[componentType].copy(value);
            }
        }
    }

    protected wrapNested<
        T extends typeof this.Entity,
        K extends Keys<typeof this.ComponentTypes>,
        V extends Object | Array<unknown>
    >(entity: T, componentType: K, value: V): V {
        // @ts-ignore
        if (value.__isSprixleNestedProxy) return value;
        if (typeof value !== 'object') {
            console.warn(
                `[Manager.wrapNested] ${componentType.toString()} isn't proxyable so it cannot be nested`
            );
            return value;
        }

        const manager = this;

        for (let [key, v] of Object.entries(value)) {
            if (typeof v === 'object') {
                value[key] = this.wrapNested(entity, componentType, v);
            }
        }

        // TODO nesting
        return new Proxy(value, {
            get(target, prop, receiver) {
                if (prop === '__isSprixleNestedProxy') {
                    return true;
                }
                return Reflect.get(target, prop, receiver);
            },
            set(target, prop, newValue, receiver) {
                entity.willUpdate(componentType);

                // TODO maybe make it so deep keys have to also be annotated to avoid unintended overhead?
                if (typeof newValue === 'object') {
                    newValue = manager.wrapNested(
                        entity,
                        componentType,
                        newValue
                    );
                }

                // target[prop] = newValue;
                return Reflect.set(target, prop, newValue, receiver);
            },
        }) as V;
    }

    createEntity(
        deserialized: SerializableEntity<Partial<ExactComponentTypes>>
    ): typeof this.Entity;
    createEntity(id?: EntityId): typeof this.Entity;
    createEntity(
        idOrDeserialized:
            | EntityId
            | SerializableEntity<Partial<ExactComponentTypes>> = this.genId()
    ): typeof this.Entity {
        const timestamp = now();

        const isFromDeserialized = typeof idOrDeserialized === 'object';
        const id = !isFromDeserialized ? idOrDeserialized : idOrDeserialized.id;

        const manager = this;

        // TODO ensure Nested deserializes properly
        const components = isFromDeserialized
            ? idOrDeserialized.components
            : ({
                  createdAt: timestamp,
                  updatedAt: timestamp,
              } as typeof this.ComponentTypes);

        const entity = {
            id,
            previousComponents: {},
            components: new Proxy(components, {
                set(target, componentType, value = null) {
                    // TODO handle setting undefined (should removeComponent)
                    // if (value === undefined) {
                    //     delete entity.components[componentType];
                    //     return;
                    // }

                    // TODO add nested handler
                    const componentAnnotations = manager.componentAnnotations[
                        componentType
                    ] as Set<Annotations>;

                    if (componentAnnotations) {
                        if (
                            componentAnnotations.has('SingletonComponent') &&
                            manager.state.entityMap.get(componentType as any)
                                ?.size &&
                            manager.state.entityMap
                                .get(componentType as any)
                                .first() !== entity.id
                        ) {
                            throw new Error(
                                `[Entity.components.${
                                    componentType as string
                                }] singleton component being used more than once.`
                            );
                        }

                        if (componentAnnotations.has('Nested')) {
                            value = manager.wrapNested(
                                entity,
                                componentType as any,
                                value
                            );
                        }
                    }

                    const entityIsRegistered = manager.state.entities.has(id);

                    // TODO figure out how Nested components handle previousComponents?
                    if (
                        componentType !== 'updatedAt' &&
                        entityIsRegistered &&
                        target[componentType] !== value
                    ) {
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

                            manager.flagUpdate(
                                entity,
                                componentType as keyof ExactComponentTypes
                            );
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
                    manager.patchHandlers?.removeComponent?.(
                        entity.id,
                        p as keyof ExactComponentTypes
                    );
                    return true;
                },
            }),
            /** @deprecated use `willUpdate` instead. */
            flagUpdate: (componentType: keyof ExactComponentTypes) =>
                manager.flagUpdate(entity, componentType),
            willUpdate: (componentType: keyof ExactComponentTypes) =>
                manager.flagUpdate(entity, componentType),
            quietSet(componentType, value) {
                components[componentType] = value;
            },
        } as typeof this.Entity;

        return entity;
    }

    /** Creates or gets entity, add components and registers it immediately */
    quickEntity<Components extends Partial<ExactComponentTypes>>(
        components: Components,
        id = this.genId()
    ) {
        const entity = this.getEntity(id) || this.createEntity(id);
        this.addComponents(entity, components);
        this.registerEntity(entity);

        return entity as EntityWithComponents<
            ExactComponentTypes,
            typeof this,
            //@ts-ignore
            Keys<Components>
        >;
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
        const { state, patchHandlers } = this;

        state.stagedUpdates.forEach((componentTypes, entityId) => {
            const patches: Partial<ExactComponentTypes> = {};

            componentTypes.forEach((componentType) => {
                const entity = this.getEntity(entityId);
                if (!entity) return;

                if (patchHandlers?.components) {
                    patches[componentType] = entity.components[componentType];
                }

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
                    } else if (query?.queryParameters.index === componentType) {
                        query.indexEntity(entity);
                    }
                });
            });

            patchHandlers?.components?.(entityId, patches);
        });

        state.stagedUpdates.clear();
        endPerformanceMeasure(this);
    }

    // TODO evaluate and remove?
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
        if (this.entityExists(entity.id)) {
            if (this.getEntity(entity.id) !== entity) {
                console.warn(
                    '[registerEntity] two entity objects exist with id',
                    entity.id
                );
            }
            return;
        }
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

        this.patchHandlers?.register?.(entity);

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

        this.patchHandlers?.deregister?.(entity);
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

    getEntity(id: EntityId) {
        return this.state.entities.get(id);
    }

    entityExists(id: EntityId) {
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

    deleteSingletonEntity<
        K extends Keys<typeof this.ComponentTypes>,
        E = EntityWithComponents<
            ExactComponentTypes,
            Manager<ExactComponentTypes>,
            K
        >
    >(componentType: K) {
        if (!this.entityExists(componentType as string)) return;

        return this.deregisterEntity(this.getSingletonEntity(componentType));
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

    getEntityIds(
        componentType: Keys<typeof this.ComponentTypes>
    ): Set<EntityId> {
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

    getEntityIdsOf(
        types: Set<Keys<typeof this.ComponentTypes>>
    ): Set<EntityId> {
        return types.reduce(
            (entities, type) => entities.union(this.getEntityIds(type)),
            new Set<EntityId>()
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
