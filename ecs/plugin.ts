import { forwardTypeArguments } from '@deepkit/core';
import { ReceiveType, resolveReceiveType } from '@deepkit/type';
import { Manager } from './manager';
import { mapValues } from 'lodash';

export function sprixlePlugin<
    Deps extends {
        [key: string]: ((...args: any[]) => any) & { pluginName: string };
    },
    T extends (
        this: { dependencies: { [K in keyof Deps]: ReturnType<Deps[K]> } },
        manager: Manager<any>,
        ...args: any[]
    ) => any,
>(
    func: T,
    dependencies: Deps = {} as Deps,
    options: { optionalDependencies?: Set<keyof Deps> } = {},
    dependencyTypes?: ReceiveType<Deps>
) {
    dependencyTypes = Object.values(dependencies).map((t) =>
        //@ts-ignore
        resolveReceiveType(t)
    );

    //@ts-ignore
    const type = resolveReceiveType(func);

    if (!('name' in type) || !type.name || typeof type.name !== 'string') {
        console.warn('hint for error', func);
        throw new Error('[Sprixle.Plugin] unable to determine name of plugin');
    }

    const name = type.name;

    const applicator = ((...args: Parameters<T>) => {
        const [manager] = args;

        const resolvedDependencies = mapValues(dependencies, (pf) => {
            const dep = manager.plugins.get(pf.pluginName);

            if (!dep) {
                if (options?.optionalDependencies?.has(pf.pluginName))
                    return null;
                throw new Error(
                    `[Sprixle] Plugin dependency missing for ${applicator.pluginName}: ${pf.pluginName}.`
                );
            }

            return dep;
        });

        forwardTypeArguments(applicator, func);
        const result = func.call(
            { dependencies: resolvedDependencies },
            ...args
        );

        if (manager.plugins.has(name)) {
            console.warn(
                'Multi-use plugin might not be registered properly for internal use.'
            );
        }
        manager.plugins.set(name, result);

        return result;
    }) as ((...args: Parameters<T>) => ReturnType<T>) &
        T & { pluginName: string };

    applicator.pluginName = name;

    return applicator;
}
