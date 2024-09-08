import { BindingParams, BladeApi, FolderApi, Pane } from 'tweakpane';
import { defaultComponentTypes, Manager } from '../ecs/manager';
import { AnySystem, Pipeline, System } from '../ecs/system';
import { Query } from '../ecs/query';
import { interval } from '../util/timing';
import { throttleLog } from '../util/log';
import { BindingApi } from '@tweakpane/core';

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
            // TODO allow overriding folder? how to handle different entities having component in same folder?
            folder?: string
        ) {
            const system = manager.createSystem(query.createConsumer(), {
                new(entity) {
                    const folder = (folders[entity.id] =
                        folders[entity.id] ||
                        primaryPane.addFolder({
                            title: '[Entity] ' + entity.id,
                            expanded: true,
                        }));

                    folder.hidden = false;

                    const value = entity.components[component];
                    if (value.constructor === Object) {
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
                    const folder = folders[entity.id];
                    if (folder) folder.refresh();
                },
                removed(entity) {
                    const folder = folders[entity.id];
                    if (!folder) return;
                    const blade = binding.blades[entity.id];

                    if (blade) {
                        folder.remove(blade);
                        if (!folder.children.length) {
                            folder.hidden = true;
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
            include = ['count', 'updated', 'removed']
        ) {
            options.readonly = true;

            const consumer = query.createConsumer();

            const folder = (folders[folderTitle] =
                folders[folderTitle] ||
                primaryPane.addFolder({
                    title: '[Query] ' + folderTitle,
                    expanded: true,
                }));

            const state = {
                count: 0,
                updated: 0,
                removed: 0,
            };

            const updateInterval = interval(1000 / (options.interval || 50));
            updateInterval.accumulative = false;

            options.interval = 0;

            const system = manager.createSystem(consumer, {
                new(entity, delta) {
                    state.count = query.entities.size;
                    if (options.interval === 0 || updateInterval(delta))
                        folder.refresh();
                },
                updated(entity, delta) {
                    state.updated = consumer.updatedEntities.size;
                    if (options.interval === 0 || updateInterval(delta))
                        folder.refresh();
                },
                removed(entity, delta) {
                    state.count = query.entities.size;
                    state.removed = consumer.deletedEntities.size;
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
