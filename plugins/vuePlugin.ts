import { onUnmounted, ShallowRef, shallowRef, watch } from 'vue';
import {
    defaultComponentTypes,
    EntityId,
    EntityWithComponents,
    Keys,
    Manager,
} from '../ecs/manager';
import { Query } from '../ecs/query';
import { Pipeline } from '../ecs/system';

export function applyVuePlugin<
    C extends defaultComponentTypes,
    M extends Manager<C> = Manager<C>
>(manager: M) {
    const vuePipeline = new Pipeline(manager);

    // Track component watchers: EntityId -> ComponentKey -> Set of refs
    const componentWatchers = new Map<
        EntityId,
        Map<Keys<C>, Set<ShallowRef<any>>>
    >();

    // Track entity watchers: EntityId -> Set of refs (for whole entity updates)
    const entityWatchers = new Map<EntityId, Set<ShallowRef<any>>>();

    // Set up patchHandlers to intercept component changes
    const existingHandlers = manager.patchHandlers || {};
    manager.patchHandlers = {
        ...existingHandlers,

        components(id, patches) {
            // Call existing handler if present
            existingHandlers.components?.(id, patches);

            // Update component-specific watchers
            const entityComponentWatchers = componentWatchers.get(id);
            if (entityComponentWatchers) {
                for (let component in patches) {
                    const refs = entityComponentWatchers.get(
                        component as Keys<C>
                    );
                    if (refs) {
                        const newValue = patches[component as Keys<C>];
                        for (let ref of refs) {
                            ref.value = newValue;
                        }
                    }
                }
            }

            // Update entity watchers (for useEntity) - only fetch entity if needed
            const entityRefs = entityWatchers.get(id);
            if (entityRefs?.size) {
                const entity = manager.getEntity(id);
                for (let ref of entityRefs) {
                    ref.value = entity;
                }
            }
        },

        register(entity) {
            existingHandlers.register?.(entity);

            const entityComponentWatchers = componentWatchers.get(entity.id);
            if (entityComponentWatchers) {
                for (let [component, refs] of entityComponentWatchers) {
                    if (refs) {
                        const newValue =
                            entity.components[component as Keys<C>];
                        for (let ref of refs) {
                            ref.value = newValue;
                        }
                    }
                }
            }

            const entityRefs = entityWatchers.get(entity.id);
            if (entityRefs?.size) {
                for (let ref of entityRefs) {
                    ref.value = entity;
                }
            }
        },

        deregister(entity) {
            existingHandlers.deregister?.(entity);
            // Clean up watchers
            componentWatchers.delete(entity.id);
            entityWatchers.delete(entity.id);
        },

        removeComponent(id, component) {
            existingHandlers.removeComponent?.(id, component);
            // Trigger component watchers with undefined
            const entityComponentWatchers = componentWatchers.get(id);
            if (entityComponentWatchers) {
                const refs = entityComponentWatchers.get(component);
                if (refs) {
                    for (let ref of refs) {
                        ref.value = undefined;
                    }
                }
            }
        },
    };

    /**
     * Watch a specific component value on a specific entity.
     * Most efficient way to track individual values.
     *
     * @example
     * const playerId = useSingletonEntityComponent('selfPlayerId');
     * const health = useComponent(playerId, 'health');
     * const mana = useComponent(playerId, 'mana');
     */
    function useComponent<K extends Keys<C>>(
        entityOrId: EntityId | { value: EntityId } | typeof manager.Entity,
        component: K,
        placeholder?: C[K]
    ): ShallowRef<C[K] | undefined> {
        // TODO updating the ref wont actually change the component on the ECS side of things.. fix that
        // Extract ID from various input types
        const getId = (input = entityOrId): EntityId | undefined => {
            if (typeof input === 'string' || typeof input === 'bigint') {
                return input;
            }
            if ('value' in input) {
                return input.value;
            }
            return input.id;
        };

        const initialId = getId();
        const initialEntity = initialId
            ? manager.getEntity(initialId)
            : undefined;
        const ref = shallowRef<C[K] | undefined>(
            initialEntity?.components[component] || placeholder
        );

        let currentId = initialId;
        let entityComponentWatchers:
            | Map<Keys<C>, Set<ShallowRef<any>>>
            | undefined;

        const registerWatcher = (id: EntityId) => {
            if (!componentWatchers.has(id)) {
                componentWatchers.set(id, new Map());
            }
            const watchers = componentWatchers.get(id)!;
            if (!watchers.has(component)) {
                watchers.set(component, new Set());
            }
            watchers.get(component)!.add(ref);
            return watchers;
        };

        const unregisterWatcher = (
            id: EntityId,
            watchers: Map<Keys<C>, Set<ShallowRef<any>>>
        ) => {
            const refs = watchers.get(component);
            if (refs) {
                refs.delete(ref);
                if (refs.size === 0) {
                    watchers.delete(component);
                }
            }
            if (watchers.size === 0) {
                componentWatchers.delete(id);
            }
        };

        // Shared logic for handling ID changes
        const handleIdChange = (newId: EntityId | undefined) => {
            if (newId === currentId) return;

            // Unregister from old ID
            if (currentId && entityComponentWatchers) {
                unregisterWatcher(currentId, entityComponentWatchers);
            }

            // Register for new ID and update value
            currentId = newId;
            if (newId) {
                entityComponentWatchers = registerWatcher(newId);
                const entity = manager.getEntity(newId);
                ref.value = entity?.components[component] || placeholder;
            } else {
                entityComponentWatchers = undefined;
                ref.value = undefined;
            }
        };

        // Register initial watcher if we have an ID
        if (currentId) {
            entityComponentWatchers = registerWatcher(currentId);
        }

        // If entityOrId is a ref, watch for ID changes
        if (typeof entityOrId === 'object' && 'value' in entityOrId) {
            watch(entityOrId, (entityOrId) => {
                handleIdChange(getId(entityOrId));
            });

            onUnmounted(() => {
                if (currentId && entityComponentWatchers) {
                    unregisterWatcher(currentId, entityComponentWatchers);
                }
            });
        } else {
            // Cleanup on unmount for static IDs
            onUnmounted(() => {
                if (currentId && entityComponentWatchers) {
                    unregisterWatcher(currentId, entityComponentWatchers);
                }
            });
        }

        return ref;
    }

    /**
     * Watch an entire entity by ID.
     * Updates when any component on the entity changes.
     *
     * @example
     * const playerId = useSingletonEntityComponent('selfPlayerId');
     * const player = useEntity(playerId);
     */
    function useEntity(
        entityOrId: EntityId | { value: EntityId }
    ): ShallowRef<typeof manager.Entity | undefined> {
        const initialId =
            typeof entityOrId === 'object' ? entityOrId.value : entityOrId;
        const ref = shallowRef(
            initialId ? manager.getEntity(initialId) : undefined
        );

        let currentId = initialId;

        const registerWatcher = (id: EntityId) => {
            if (!entityWatchers.has(id)) {
                entityWatchers.set(id, new Set());
            }
            entityWatchers.get(id)!.add(ref);
        };

        const unregisterWatcher = (id: EntityId) => {
            const watchers = entityWatchers.get(id);
            if (watchers) {
                watchers.delete(ref);
                if (watchers.size === 0) {
                    entityWatchers.delete(id);
                }
            }
        };

        const handleIdChange = (newId: EntityId | undefined) => {
            if (newId === currentId) return;

            // Unregister from old ID
            if (currentId) {
                unregisterWatcher(currentId);
            }

            // Register for new ID and update value
            currentId = newId;
            if (newId) {
                registerWatcher(newId);
                ref.value = manager.getEntity(newId);
            } else {
                ref.value = undefined;
            }
        };

        // Register initial watcher if we have an ID
        if (currentId) {
            registerWatcher(currentId);
        }

        // If entityOrId is a ref, watch for ID changes
        if (typeof entityOrId === 'object') {
            watch(entityOrId, (entityOrId) => {
                handleIdChange(entityOrId.value);
            });

            onUnmounted(() => {
                if (currentId) {
                    unregisterWatcher(currentId);
                }
            });
        } else {
            // Cleanup on unmount for static IDs
            onUnmounted(() => {
                if (currentId) {
                    unregisterWatcher(currentId);
                }
            });
        }

        return ref;
    }

    /**
     * Watch a singleton component value.
     * Singleton components are stored on entities with IDs matching the component name.
     *
     * @example
     * const playerId = useSingletonEntityComponent('selfPlayerId');
     */
    function useSingletonEntityComponent<K extends Keys<C>>(component: K) {
        // Singleton entity ID is the component name itself
        return useComponent(component as string as EntityId, component);
    }

    /**
     * Watch a query for a list of entities.
     * Returns a reactive array of entity refs that updates when entities are added/removed.
     * Individual entity refs update via patchHandlers when their components change.
     *
     * @example
     * const enemyQuery = em.createQuery({ includes: ['isEnemy', 'health'] });
     * const enemies = useQuery(enemyQuery);
     * // enemies.value is an array of entity refs
     */
    function useQuery<
        Includes extends Keys<C>[],
        IndexedComponent extends Keys<C>,
        E extends EntityWithComponents<C, M, Includes[number]>
    >(query: Query<C, Includes, M, IndexedComponent, E>) {
        const cache = new Map<string, ShallowRef<typeof manager.Entity>>();

        const ref = shallowRef(query.entities.map((id) => getEntityRef<E>(id)));

        function getEntityRef<E = typeof manager.Entity>(id: string) {
            if (!cache.has(id)) {
                const entityRef = shallowRef(
                    manager.getEntity(id)
                ) as ShallowRef<E>;
                cache.set(id, entityRef);

                // Register this ref with entityWatchers so patchHandlers updates it
                if (!entityWatchers.has(id)) {
                    entityWatchers.set(id, new Set());
                }
                entityWatchers.get(id)!.add(entityRef);
            }
            return cache.get(id) as ShallowRef<E>;
        }

        // Consumer and System work to track entity list changes
        const consumer = query.createConsumer();
        const system = manager.createSystem(consumer, {
            tick() {
                // Only rebuild array when entities are added/removed
                if (
                    consumer.newEntities.size ||
                    consumer.deletedEntities.size
                ) {
                    ref.value = query.entities.map((id) => getEntityRef<E>(id));
                }
                // Individual entity updates handled by patchHandlers
            },
        });

        vuePipeline.systems.add(system);

        // Cleanup cached refs on unmount
        onUnmounted(() => {
            for (let [id, entityRef] of cache) {
                const watchers = entityWatchers.get(id);
                if (watchers) {
                    watchers.delete(entityRef);
                    if (watchers.size === 0) {
                        entityWatchers.delete(id);
                    }
                }
            }
            cache.clear();
        });

        return ref;
    }

    return {
        vuePipeline,
        useEntity,
        useComponent,
        useSingletonEntityComponent,
        useQuery,
    };
}
