import uuid from 'uuid-random';
import { each } from 'lodash';
import { keys, keySet } from './dict';
import './object.extensions.ts';

//   ^?
type Keys<T> = keyof T;
export type EntityID = string;

export type Entity<ComponentTypes> = {
    id: EntityID;
    components: ComponentTypes;
};

type EntitiesByID<ComponentTypes> = Map<EntityID, Entity<ComponentTypes>>; //{ [id: string]: Entity<ComponentTypes> };
type EntityMap<ComponentTypes> = Map<Keys<ComponentTypes>, Set<EntityID>>; //{ [type in Keys<ComponentTypes>]?: Set<string> };
type ComponentMap<ComponentTypes> = Map<EntityID, Set<Keys<ComponentTypes>>>; //{ [id: string]: Set<Keys<ComponentTypes>> }; // TODO do we actually need ComponentMap for anything?

export type EntityAdminState<ComponentTypes> = {
    entities: EntitiesByID<ComponentTypes>;
    /** Maps entity type to set of Entity IDs */
    entityMap: EntityMap<ComponentTypes>;
    /** Maps entity ID to set of ComponentTypes */
    componentMap: ComponentMap<ComponentTypes>;

    updatedEntities: Set<EntityID>;
    previouslyUpdatedEntities: Set<EntityID>;
};

export type defaultComponentTypes = {
    ownerID: string;
    createdAt: number;
    updatedAt: number;
};

export const DEFAULT_COMPONENT_DEFAULTS: defaultComponentTypes = {
    ownerID: 'default_id',
    createdAt: 0,
    updatedAt: 0,
};

export class Manager<ExactComponentTypes extends defaultComponentTypes> {
    readonly ComponentTypes: Partial<ExactComponentTypes>;
    readonly State: EntityAdminState<typeof this.ComponentTypes>;
    readonly Entity: Entity<typeof this.ComponentTypes>;
    COMPONENT_DEFAULTS: ExactComponentTypes;
    componentTypesSet: Set<keyof ExactComponentTypes>;

    // TODO just store state here, its mutable so the whole and set thing is annoying
    // we already have tickstate for previous and such
    state = this.createInitialState();

    constructor(componentDefaults: ExactComponentTypes) {
        this.COMPONENT_DEFAULTS = {
            ...DEFAULT_COMPONENT_DEFAULTS,
            ...componentDefaults,
        };
        this.componentTypesSet = new Set(
            Object.keys(this.COMPONENT_DEFAULTS) as Array<
                keyof ExactComponentTypes
            >
        );
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
        return {
            entities: new Map(),
            entityMap: new Map(),
            componentMap: new Map(),

            updatedEntities: new Set(),
        } as EntityAdminState<typeof this.ComponentTypes>;
    }

    createEntity(id = uuid()): typeof this.Entity {
        const timestamp = Date.now();

        return {
            id,
            components: {
                createdAt: timestamp,
                updatedAt: timestamp,
            } as typeof this.ComponentTypes,
        };
    }

    private updatedEntity(entity: typeof this.Entity) {
        entity.components.updatedAt = Date.now();
        this.state.updatedEntities.add(entity.id);
    }

    /** to be called after each set of systems (end of a frame) */
    tick() {
        const { state } = this;
        state.previouslyUpdatedEntities = state.updatedEntities;
        state.updatedEntities = new Set();
    }

    updateEntity(entity: typeof this.Entity) {
        const { state } = this;
        if (
            // TODO optimize, this is maybe not good?
            // this doesn't even work with mutable...
            !state.entities.has(entity.id) ||
            !keySet(this.getEntity(entity.id).components).equals(
                keySet(entity.components)
            ) ||
            !state.entities.has(entity.id)
        ) {
            return this.registerEntity(entity);
        } else {
            this.updatedEntity(entity);
        }

        state.entities.set(entity.id, entity);
    }

    registerEntity(entity: typeof this.Entity) {
        const { state } = this;
        state.entities.set(entity.id, entity);
        this.updatedEntity(entity);

        keys(entity.components).forEach((key) => {
            this.addEntityMapping(entity, key);
        });
    }

    deregisterEntity(entity: typeof this.Entity) {
        const { state } = this;
        keys(entity.components).forEach((key) => {
            this.removeEntityMapping(entity, key);
        });

        state.entities.delete(entity.id);
        state.componentMap.delete(entity.id);

        this.updatedEntity(entity);
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

    removeEntityMapping(
        entity: typeof this.Entity,
        componentType: Keys<typeof this.ComponentTypes>
    ) {
        const { state } = this;
        state.entityMap.get(componentType)?.delete(entity.id);
        state.componentMap.get(entity.id)?.delete(componentType);
    }

    getEntity(id: string) {
        return this.state.entities.get(id) || this.createEntity(id);
    }

    getSingletonEntity(
        componentType: Keys<typeof this.ComponentTypes>
    ): Entity<typeof this.ComponentTypes> {
        // TODO: should we share all singleton under one roof?
        return (
            this.getEntities(componentType)?.first() ||
            this.createEntity(componentType as string)
        );
    }

    getSingletonEntityComponent<K extends Keys<typeof this.ComponentTypes>>(
        componentType: K
    ): typeof this.ComponentTypes[K] {
        return this.getComponent(
            this.getSingletonEntity(componentType),
            componentType
        );
    }

    /**
     * Get all Entities that have a component of type
     */
    getEntities(
        componentType: Keys<typeof this.ComponentTypes>
    ): Set<Entity<typeof this.ComponentTypes>> {
        // TODO: optimize?
        const { state } = this;
        const entityMap = state.entityMap.get(componentType);
        if (!entityMap) {
            return new Set();
        } else {
            return entityMap.map((id) => this.getEntity(id));
        }
    }

    /** Get Entities that have these specific component types (intersection) */
    getEntitiesWith(
        types: Set<Keys<typeof this.ComponentTypes>>
    ): Set<Entity<typeof this.ComponentTypes>> {
        const { state } = this;
        const entityMaps = types.map(
            (type) => state.entityMap.get(type) || new Set<string>()
        );

        const intersectedEntities = (
            entityMaps.first() || new Set<string>()
        ).intersect(...entityMaps);

        return intersectedEntities.map((id) => this.getEntity(id));
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
        K extends Keys<typeof this.ComponentTypes>
    >(
        entity: T,
        type: K,
        value: typeof this.ComponentTypes[K] = this.COMPONENT_DEFAULTS[type]
    ) {
        // Weird fix for typescript issue (can't use K here), and cant cast as const even with type as...
        // const path = ['components', type] as const;

        // if (entity.hasIn(path)) {
        //     console.warn('entity cannot have more than one of component type', type);
        //     return entity;
        // }

        entity.components[type] = value;
        return entity;
    }

    addComponents(
        entity: typeof this.Entity,
        components: typeof this.ComponentTypes
    ) {
        each(components, (value, type) => {
            if (this.componentTypesSet.has(type as keyof ExactComponentTypes)) {
                entity = this.addComponent(
                    entity,
                    type as keyof ExactComponentTypes,
                    value
                );
            }
        });

        return entity;
    }

    updateComponent<
        T extends typeof this.Entity,
        K extends Keys<typeof this.ComponentTypes>
    >(
        entity: T,
        type: K,
        modifier:
            | typeof this.ComponentTypes[K]
            | ((
                  currentValue: typeof this.ComponentTypes[K]
              ) => typeof this.ComponentTypes[K])
    ) {
        // Weird fix for typescript issue (can't use K here), and cant cast as const even with type as...
        const path = ['components', type] as const;

        const currentValue =
            entity.components[type] || this.COMPONENT_DEFAULTS[type];

        entity.components[type] =
            modifier instanceof Function ? modifier(currentValue) : modifier;

        return entity;
    }

    getComponent<K extends Keys<typeof this.ComponentTypes>>(
        entity: typeof this.Entity,
        type: K
    ): typeof this.ComponentTypes[K] {
        return entity.components[type];
    }
}
