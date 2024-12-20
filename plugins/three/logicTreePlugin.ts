import {
    ReceiveType,
    ReflectionClass,
    resolveReceiveType,
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

export type LogicTreeComponentTypes<ComponentTypes> = {
    mesh: Object3D;
    logicTree: NodeTree;
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

    const reflection = ReflectionClass.from(methodsType);
    // TODO should be improved with abstraction of createCompiler
    for (let transpilerMethod in transpilerMethods) {
        // @ts-ignore
        methods[transpilerMethod] = transpilerMethods[transpilerMethod];
    }

    const logicTreeQuery = em.createQuery({
        includes: ['logicTree'],
        excludes: ['compiledLogicTree'],
    });

    const compiledLogicTreeQuery = em.createQuery({
        includes: ['compiledLogicTree'],
    });

    const dependencies = { em, Vector3 };

    function compiledTreeToFn(
        transpiled: string[],
        compilationCache: CompilationCache
    ) {
        return Function(
            ...Object.keys(dependencies),
            'delta',
            'methods',
            'entity',
            'groupInput',
            `
const { ${Array.from(compilationCache.defines).join(', ')} } = methods;
${Object.keys(compilationCache.compiledInputs).reduce((r, key) => {
    const compiledInput = compilationCache.compiledInputs[key];

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
            const { logicTree, mesh } = entity.components;

            const compiledLogicTree = compileLogicTree(logicTree);
            console.log('[transpiledLogicNode]', compiledLogicTree);

            entity.components.logicTreeCache = {};
            // if (compiledLogicTree.initFn) {
            //     compiledLogicTree.initFn.call(entity.components.logicTreeCache, delta, methods, entity, {
            //         Geometry: mesh
            //     })
            // }
            // entity.components.compiledLogicTree = compiledLogicTree.fn;
            // console.log(entity.components.compiledLogicTree);
        },
    });

    const compiledLogicTreeSystem = em.createSystem(compiledLogicTreeQuery, {
        interval: interval(1000 / 30),
        all(entity, delta) {
            const { compiledLogicTree, logicTreeCache, mesh } =
                entity.components;

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
        compiledLogicTreeSystem
    );

    // TODO
    blenderEvents.addEventListener('logicTree', (event) => {
        const { tree, name } = event.detail;

        console.log('[LogicTreeBlenderConnection] received nodeTree data', {
            name,
            tree,
        });

        const existingEntity = em.getEntity(name);

        const compiledLogicTree = compileLogicTree(tree);

        console.log(
            `[LogicTreeBlenderConnection] compiled from Blender`,
            compiledLogicTree.fn,
            compiledLogicTree.transpiled
        );

        if (existingEntity) {
            console.log(
                '[LogicTreeBlenderConnection] applied compiled logicTree to existing entity'
            );

            if (compiledLogicTree.initFn) {
                console.log(
                    '[LogicTreeBlenderConnection] calling initFn',
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
            existingEntity.components.compiledLogicTree = compiledLogicTree.fn;
        } else {
            console.warn(
                '[LogicTreeBlenderConnection] compiled logicTree does not map to an existing entity'
            );
        }
    });

    return { logicTreePipeline };
}
