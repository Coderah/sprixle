import { Set } from 'immutable';
import uuid from 'uuid-random';

import imm, { Immutable } from "./imm";

type Keys<T> = T extends Partial<infer O> ? keyof O : keyof T;
export type EntityID = string;

export type Entity<ComponentTypes> = {
	id: EntityID,
	components: Immutable<ComponentTypes>,
}

type EntitiesByID<ComponentTypes> = { [id: string]: Immutable<Entity<ComponentTypes>> };
type EntityMap<ComponentTypes> = { [type in Keys<ComponentTypes>]?: Set<string> };
type ComponentMap<ComponentTypes> = { [id: string]: Set<Keys<ComponentTypes>> }; // TODO do we actually need ComponentMap for anything?

export type EntityAdminState<ComponentTypes> = {
    entities: Immutable<EntitiesByID<ComponentTypes>>;
    /** Maps entity type to set of Entity IDs */
    entityMap: Immutable<EntityMap<ComponentTypes>>;
    /** Maps entity ID to set of ComponentTypes */
    componentMap: Immutable<ComponentMap<ComponentTypes>>;
};

type defaultComponentTypes = {
    ownerID: string
}

export class Manager<ExactComponentTypes = defaultComponentTypes, ComponentTypes = Partial<ExactComponentTypes>> {
    readonly State: Immutable<EntityAdminState<ComponentTypes>>
    readonly Entity: Immutable<Entity<ComponentTypes>>
    COMPONENT_DEFAULTS: ExactComponentTypes;
    
    constructor(componentDefaults: ExactComponentTypes) {
        this.COMPONENT_DEFAULTS = componentDefaults;
    }

    createInitialState() {
        return imm<EntityAdminState<ComponentTypes>>({
            entities: imm({}),
            entityMap: imm({}),
            componentMap: imm({}),
        });
    }

    createEntity(id = uuid()): typeof this['Entity'] {
        return imm<Entity<ComponentTypes>>({
            id,
            components: imm<ComponentTypes>({} as ComponentTypes)
        });
    }

    updateEntity(
        state: typeof this['State'],
        entity: typeof this['Entity']
    ) {
        if (
            // TODO optimize, this is maybe not good?
            !this.getEntity(state, entity.get('id'))
                .get('components')
                .keySeq()
                .equals(entity.get('components').keySeq()) ||
            !state.hasIn(['entities', entity.get('id')])
        ) {
            return this.registerEntity(state, entity);
        }
    
        return state.setIn(['entities', entity.get('id')], entity);
    }

    registerEntity(
        state: typeof this['State'],
        entity: typeof this['Entity']
    ) {
        state = state.setIn(['entities', entity.get('id')], entity);
    
        entity.get('components').forEach((_, key) => {
            state = this.addEntityMapping(state, entity, key);
        });
    
        return state;
    }

    deregisterEntity(
        state: typeof this['State'],
        entity: typeof this['Entity']
    ) {
        state = state.deleteIn(['entities', entity.get('id')]);
        state = state.deleteIn(['componentMap', entity.get('id')]);
    
        entity.get('components').forEach((_, key) => {
            state = this.removeEntityMapping(state, entity, key);
        });
    
        return state;
    }

    addEntityMapping(
        state: typeof this['State'],
        entity: typeof this['Entity'],
        componentType: Keys<ComponentTypes>
    ) {
        state = state.updateIn(['entityMap', componentType], Set(), (set) =>
            set.add(entity.get('id'))
        );
        state = state.updateIn(['componentMap', entity.get('id')], Set<Keys<ComponentTypes>>(), (set) =>
            set.add(componentType)
        );
    
        return state;
    }

    removeEntityMapping(
        state: typeof this['State'],
        entity: typeof this['Entity'],
        componentType: Keys<ComponentTypes>
    ) {
        state = state.updateIn(['entityMap', componentType], (set) =>
            set?.remove(entity.get('id'))
        );
        state = state.updateIn(['componentMap', entity.get('id')], (set) =>
            set?.remove(componentType)
        );
    
        return state;
    }

    getEntity(state: typeof this['State'], id: string) {
        return state.getIn(['entities', id]);
    }

    getSingletonEntity(
        state: typeof this['State'],
        componentType: Keys<ComponentTypes>
    ): Immutable<Entity<ComponentTypes>> {
        return this.getEntities(state, componentType).first(this.createEntity(componentType as string));
    }

    getSingletonEntityComponent<K extends Keys<ComponentTypes>>(
        state: typeof this['State'],
        componentType: K
    ): ComponentTypes[K] {
        return this.getComponent(
            this.getEntities(state, componentType).first(this.createEntity(componentType as string)),
            componentType
        );
    }

    getEntities(
        state: typeof this['State'],
        componentType: Keys<ComponentTypes>
    ): Set<Immutable<Entity<ComponentTypes>>> {
        return state
            .getIn(['entityMap', componentType], Set<string>())
            .map((id) => this.getEntity(state, id));
    }

    getEntitiesWith(
        state: typeof this['State'],
        types: Set<Keys<ComponentTypes>>
    ): Set<Immutable<Entity<ComponentTypes>>> {
        const entityMaps = types.map((type) =>
            state.getIn(['entityMap', type], Set())
        );
    
        const intersectedEntities = entityMaps
            .first(Set<string>())
            .intersect(...entityMaps.toArray());
    
        return intersectedEntities.map((id) => this.getEntity(state, id));
    }

    getEntitiesOf(
        state: typeof this['State'],
        types: Set<Keys<ComponentTypes>>
    ): Set<Immutable<Entity<ComponentTypes>>> {
        return types.reduce((entities, type) => {
            return entities.union(this.getEntities(state, type));
        }, Set<Immutable<Entity<ComponentTypes>>>());
    }


    addComponent<
        T extends typeof this['Entity'],
        K extends Keys<ExactComponentTypes>,
    >(entity: T, type: K, value: ExactComponentTypes[K] = this.COMPONENT_DEFAULTS[type]) {
        // Weird fix for typescript issue (can't use K here), and cant cast as const even with type as...
        const path = ['components', type] as const;

        // if (entity.hasIn(path)) {
    //     console.warn('entity cannot have more than one of component type', type);
        //     return entity;
        // }

        return entity.setIn(path, value);
    }

    // TODO: revisit this, make a "component transformers" map?
    // addComponents(entity: typeof this['Entity'], components: {[key: string]: any} & ComponentTypes) {
    //     each(components, (value, type) => {
    //         if (type in this.COMPONENT_DEFAULTS) {
    //             switch (type) {
    //                 case 'damageDescriptor':
    //                     // TODO: this doesn't work cause the input type will mismatch, shouldn't do this here anyway,
    //                     // parsing of a const to an appropriate component should be a util
    //                     value = parseDamageDescriptor(value);
    //                     break;
    //                 case 'health':
    //                     entity = addComponent(entity, 'maxHealth', value);
    //                     break;
    //                 default:
    //                     value = value;
    //             }
    //             entity = addComponent(entity, type as Keys<ComponentTypes>, value);
    //         }
    //     });
    
    //     return entity;
    // }

    updateComponent<
        T extends Immutable<Entity<ComponentTypes>>,
        K extends Keys<ComponentTypes>,
    >(entity: T, type: K, modifier: (currentValue: ComponentTypes[K]) => ComponentTypes[K]) {
        // Weird fix for typescript issue (can't use K here), and cant cast as const even with type as...
        const path = ['components', type] as const;

        const currentValue = entity.getIn(path, this.COMPONENT_DEFAULTS[type]);

        return entity.setIn(path, modifier(currentValue));
    }

    getComponent<K extends Keys<ComponentTypes>>(entity: typeof this['Entity'], type: K): ComponentTypes[K] {
        return entity.getIn(['components', type] as const);
    }
}