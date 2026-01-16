import { LoadingManager } from 'three';
import { sprixlePlugin } from '../ecs/plugin';
import { defaultComponentTypes, Manager } from '../ecs/manager';

const testPlugin = sprixlePlugin(function TestPlugin(manager) {
    return { test: true };
});
const loaderPlugin = sprixlePlugin(function LoaderPlugin(manager) {
    return { loadingManager: new LoadingManager() };
});

const blenderLoaderPlugin = sprixlePlugin(
    function BlenderLoaderPlugin(manager, config: { test: true }) {
        const { loaderPlugin, testPlugin } = this.dependencies;

        console.log({ loaderPlugin, testPlugin });

        return { loadBlenderExport: function () {} };
    },
    { loaderPlugin, testPlugin }
);

type ComponentTypes = defaultComponentTypes;

const em = new Manager<ComponentTypes>();

testPlugin(em);
loaderPlugin(em);
blenderLoaderPlugin(em, { test: true });

console.log(em.plugins);
