import {
    ReceiveType,
    ReflectionClass,
    resolveReceiveType,
    typeOf,
} from '@deepkit/type';
import { Object3D, Vector3 } from 'three';
import { defaultComponentTypes, Entity, Manager } from '../../ecs/manager';
import { Pipeline } from '../../ecs/system';
import { interval } from '../../util/timing';
import { transpilerMethods } from '../nodeTrees/logic/transpilerMethods';
import {
    CompilationCache,
    createNodeTreeCompiler,
    LogicTreeMethods,
    NodeTree,
} from '../nodeTrees/createCompiler';
import { blenderEvents } from '../../blender/realtime';
import { UnionOrIntersectionType } from 'typescript';

export type LogicTreeComponentTypes<ComponentTypes> = {
    mesh: Object3D;
    logicTree: NodeTree;
    logicTreeName: string;
    compiledLogicTree: (
        delta: number,
        methods: LogicTreeMethods,
        entity: Entity<ComponentTypes>,
        groupInput: { Geometry: Object3D }
    ) => void;
    logicTreeCache: {};
};

// TODO dedupe, if two objects utilize the same logicTree it should be the same function reference
// TODO add minification to compilation in production
export function applyLogicTreePlugin<
    C extends defaultComponentTypes & LogicTreeComponentTypes<C>,
    M extends LogicTreeMethods
>(em: Manager<C>, methods: M, methodsType?: ReceiveType<M>) {
    methodsType = resolveReceiveType(methodsType);

    // const reflection = ReflectionClass.from(methodsType);
    const reflection = ReflectionClass.from(methodsType)
        .type as unknown as UnionOrIntersectionType;

    // TODO should be improved with abstraction of createCompiler
    for (let transpilerMethod in transpilerMethods) {
        // @ts-ignore
        methods[transpilerMethod] = transpilerMethods[transpilerMethod];
    }

    const logicTreeQuery = em.createQuery({
        includes: ['logicTree', 'logicTreeName'],
        excludes: ['compiledLogicTree'],
    });

    const compiledLogicTreeQuery = em.createQuery({
        includes: ['compiledLogicTree'],
    });

    const logicTreeRunnersQuery = em.createQuery({
        includes: ['mesh', 'logicTreeName'],
        excludes: ['logicTree', 'compiledLogicTree'],
    });

    const dependencies = { em, Vector3 };

    function compiledTreeToFn(
        transpiled: string[],
        compilationCache: CompilationCache
    ) {
        const compiledInputs = compilationCache.compiledInputs.compiled[0];
        return Function(
            ...Object.keys(dependencies),
            'delta',
            'methods',
            'entity',
            'groupInput',
            `
const { ${Array.from(compilationCache.defines).join(', ')} } = methods;
${Object.keys(compiledInputs).reduce((r, key) => {
    const compiledInput = compiledInputs[key];

    if (compiledInput) {
        r = r + '\n' + compiledInput;
    }

    return r;
}, '')}
${transpiled.reduce((r, c) => (c ? r + '\n' + c : r), '')}
`
        ).bind(
            undefined,
            ...Object.values(dependencies)
        ) as C['compiledLogicTree'];
    }

    // TODO allow logicTree re-use when arguments passed in are all that is dynamic
    const compileLogicTree = createNodeTreeCompiler({
        type: 'LogicTree',
        methods,
        reflection,
        compiledTreeToFn,
    });

    const logicTreeSystem = em.createSystem(logicTreeQuery.createConsumer(), {
        forNew(entity, delta) {
            // TODO add loading manager
            const { logicTree, logicTreeName } = entity.components;
            if (
                logicTreeQuery.find(
                    (e) =>
                        e.components.logicTreeName === logicTreeName &&
                        e !== entity
                ) ||
                compiledLogicTreeQuery.find(
                    (e) => e.components.logicTreeName === logicTreeName
                )
            ) {
                console.warn(
                    '[LogicTree] found duplicate logicTree skipping compilation',
                    entity
                );
                em.deregisterEntity(entity);
                return;
            }

            console.log('[logicTree] compiling', logicTreeName);
            const compiledLogicTree = compileLogicTree(logicTree);
            console.log('[transpiledLogicNode]', compiledLogicTree);

            // entity.components.logicTreeCache = {};
            // TODO init on each relevant entity in forNew of runners
            // if (compiledLogicTree.initFn) {
            //     compiledLogicTree.initFn.call(entity.components.logicTreeCache, delta, methods, entity, {
            //         Geometry: mesh
            //     })
            // }

            em.removeComponent(entity, 'logicTree');
            entity.components.compiledLogicTree = compiledLogicTree.fn;
            // console.log(entity.components.compiledLogicTree);
        },
    });

    const logicTreeRunnerSystem = em.createSystem(logicTreeRunnersQuery, {
        // TODO remove in favor of interval node within logicTrees
        interval: interval(1000 / 30),
        all(entity, delta) {
            let { logicTreeName, logicTreeCache, mesh } = entity.components;

            if (!logicTreeCache) {
                logicTreeCache = entity.components.logicTreeCache = {};
            }

            const compiledLogicTree = compiledLogicTreeQuery.find(
                (e) => e.components.logicTreeName === logicTreeName
            )?.components.compiledLogicTree;

            if (!compiledLogicTree) return;

            // //@ts-ignore
            // with (compiler) {
            compiledLogicTree.call(logicTreeCache, delta, methods, entity, {
                Geometry: mesh,
            });
            // }
        },
    });

    const logicTreePipeline = new Pipeline(
        em,
        logicTreeSystem,
        logicTreeRunnerSystem
    );

    // TODO
    blenderEvents.addEventListener('logicTree', (event) => {
        const { tree, name } = event.detail;

        console.log('[LogicTreeBlenderConnection] received nodeTree data', {
            name,
            tree,
        });

        const existingUncompiledEntity = logicTreeQuery.find(
            (e) => e.components.logicTreeName === name
        );

        if (existingUncompiledEntity) {
            existingUncompiledEntity.components.logicTree = tree;
            console.log(
                '[LogicTree realtime] logicTree intercepted uncompiled',
                name
            );
            return;
        }

        const existingEntity = compiledLogicTreeQuery.find(
            (e) => e.components.logicTreeName === name
        );

        const compiledLogicTree = compileLogicTree(tree);

        console.log(
            `[LogicTree realtime] compiled from Blender`,
            compiledLogicTree.fn,
            compiledLogicTree.transpiled
        );

        if (existingEntity) {
            console.log(
                '[LogicTree realtime] applied compiled logicTree to existing entity'
            );

            if (compiledLogicTree.initFn) {
                console.log(
                    '[LogicTree realtime] calling initFn',
                    compiledLogicTree.initFn
                );
                compiledLogicTree.initFn.call(
                    existingEntity.components.logicTreeCache,
                    0,
                    methods,
                    existingEntity,
                    {
                        Geometry: existingEntity.components.mesh,
                    }
                );
            }
            //@ts-ignore
            existingEntity.components.compiledLogicTree = compiledLogicTree.fn;
        } else {
            //@ts-ignore
            em.quickEntity({
                compiledLogicTree: compiledLogicTree.fn,
                logicTreeName: name,
            });
            // console.warn(
            //     '[LogicTree realtime] compiled logicTree does not map to an existing entity',
            //     name
            // );
        }
    });

    return { logicTreePipeline };
}
