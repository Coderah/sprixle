import { BindingApi, TabPageApi } from '@tweakpane/core';
import { BindingParams, FolderApi, Pane } from 'tweakpane';
import { defaultComponentTypes, Manager } from '../ecs/manager';
import { Query } from '../ecs/query';
import { AnySystem, Pipeline } from '../ecs/system';
import { interval } from '../util/timing';

export function applyEditorUIPlugin<
    ComponentTypes extends defaultComponentTypes
>(manager: Manager<ComponentTypes>) {
    const primaryPane = new Pane({
        title: 'Sprixle',
        expanded: true,
    });
    const pipeline = new Pipeline(manager);

    const folders: { [id: string]: FolderApi } = {};

    type Binding = {
        system: AnySystem<ComponentTypes>;
        blades: { [id: string]: BindingApi | FolderApi };
    };

    const bindings: {
        [key: string]: Binding;
    } = {};

    return {
        pipeline,
        tweakpane: primaryPane,
        addDeltaGraph() {
            const folder = (folders.stats =
                folders.stats ||
                primaryPane.addFolder({
                    title: 'Stats',
                    expanded: true,
                }));

            const state = { delta: 0 };

            const blade = folder.addBinding(state, 'delta', {
                readonly: true,
                view: 'graph',
                rows: 2,
                interval: 60,
            });

            const binding = (bindings['delta'] = {
                system: manager.createSystem({
                    tick(delta) {
                        state.delta = delta;
                    },
                }),
                blades: { delta: blade },
            });

            pipeline.systems.add(binding.system);

            return binding;
        },
        addComponentBinding<Component extends keyof ComponentTypes>(
            component: Component,
            options: Partial<BindingParams> = {},
            query: Query<ComponentTypes, any> = manager.createQuery({
                includes: [component],
            }),
            parent?: Pane | FolderApi | TabPageApi,
            topLevel = primaryPane
        ) {
            const system = manager.createSystem(query.createConsumer(), {
                forNew(entity) {
                    const folder =
                        parent ||
                        (folders[entity.id] =
                            folders[entity.id] ||
                            topLevel.addFolder({
                                title: 'Entity: ' + entity.id,
                                expanded: true,
                            }));

                    if (!parent) {
                        folder.hidden = false;
                    }

                    const value = entity.components[component];
                    if (value.constructor === Object || Array.isArray(value)) {
                        const subFolder = (binding.blades[entity.id] =
                            folder.addFolder({
                                title: component as string,
                                expanded: false,
                            }));
                        for (let key in value) {
                            subFolder.addBinding(value, key, options);
                        }
                    } else {
                        binding.blades[entity.id] = folder.addBinding(
                            entity.components,
                            component,
                            options
                        );
                    }

                    // blade.on('change', (event) => {
                    // console.log('change', entity.id, component, event);
                    // entity.components[component] = event.value;
                    // });
                },
                updated(entity) {
                    // binding.blades[entity.id]?.refresh();
                    const folder = parent || folders[entity.id];
                    if (folder) folder.refresh();
                },
                removed(entity) {
                    const folder = folders[entity.id];
                    if (!folder) return;
                    const blade = binding.blades[entity.id];

                    if (blade) {
                        folder.remove(blade);
                        if (!folder.children.length) {
                            folder.dispose();
                            delete folders[entity.id];
                        }
                    }
                },
            });

            const binding: Binding = {
                system,
                blades: {},
            };

            pipeline.systems.add(system);

            bindings[component as string] = binding;
        },
        addQueryStats(
            query: Query<ComponentTypes, any>,
            options: Partial<BindingParams> = { interval: 0 },
            folderTitle = query.queryName,
            include = [
                'count',
                'updated',
                'removed',
                'indexKeys',
                'indexValues',
            ],
            parent: Pane | FolderApi | TabPageApi = primaryPane
        ) {
            options.readonly = true;

            const consumer = query.createConsumer();

            const folder = (folders[folderTitle] =
                folders[folderTitle] ||
                parent.addFolder({
                    title: 'Query: ' + folderTitle,
                    expanded: true,
                }));

            const state = {
                count: 0,
                updated: 0,
                removed: 0,
                indexKeys: 0,
                indexValues: 0,
            };

            if (!query.queryParameters.index) {
                include = include.filter((n) => !n.startsWith('index'));
            }

            const updateInterval = interval(1000 / (options.interval || 50));
            updateInterval.accumulative = false;

            options.interval = 0;

            function updateIndex() {
                state.indexKeys = query.indexed.size;
                state.indexValues = 0;
                query.indexed.forEach((ids) => {
                    state.indexValues += ids.size;
                });
            }

            const system = manager.createSystem(consumer, {
                forNew(entity, delta) {
                    state.count = query.entities.size;
                    updateIndex();
                    if (options.interval === 0 || updateInterval(delta))
                        folder.refresh();
                },
                updated(entity, delta) {
                    state.updated = consumer.updatedEntities.size;
                    updateIndex();
                    if (options.interval === 0 || updateInterval(delta))
                        folder.refresh();
                },
                removed(entity, delta) {
                    state.count = query.entities.size;
                    state.removed = consumer.deletedEntities.size;
                    updateIndex();
                    if (options.interval === 0 || updateInterval(delta))
                        folder.refresh();
                },
            });

            const binding: Binding = {
                system,
                blades: {},
            };

            Object.keys(state).forEach((key) => {
                if (!include.includes(key)) return;
                binding.blades[key] = folder.addBinding(
                    state,
                    //@ts-ignore
                    key,
                    options
                );
            });

            pipeline.systems.add(system);

            bindings[folderTitle] = binding;
        },
    };
}
