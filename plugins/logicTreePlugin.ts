import {
    ReceiveType,
    ReflectionClass,
    resolveReceiveType,
} from '@deepkit/type';
import { defaultComponentTypes, Manager } from '../ecs/manager';
import { Pipeline } from '../ecs/system';
import { Object3D, Vector3 } from 'three';
import { Geometry } from 'three-stdlib';
import { interval } from '../util/timing';

// TODO handle multiple links
interface LinkedSocket {
    type: 'linked';
    links: {
        node: string;
        socket: string;
    }[];
}

export interface LogicNode {
    id: string;
    name: string;
    type: string;
    inputs: {
        [key: string]: string | number | LinkedSocket;
    };
    outputs: {
        [key: string]: LinkedSocket;
    };
    properties: {};
}

export interface LogicTree {
    [key: string]: LogicNode;
}

export type LogicTreeComponentTypes = {
    mesh: Object3D;
    logicTree: LogicTree;
    compiledLogicTree: (methods: LogicMethods, Geometry: Object3D) => void;
};

function getNext(tree: LogicTree, n: LogicTree[keyof LogicTree]) {
    const field = n.outputs.Next || n.outputs.Geometry;

    return field.links
        .filter((l) => l.socket === 'Trigger')
        .map((l) => tree[l.node]);
}

interface LogicMethods {
    [key: string]: Function;
}

export function applyLogicTreePlugin<
    C extends defaultComponentTypes & LogicTreeComponentTypes,
    M extends LogicMethods
>(em: Manager<C>, methods: M, methodsType?: ReceiveType<M>) {
    methodsType = resolveReceiveType(methodsType);

    const reflection = ReflectionClass.from(methodsType);

    const logicTreeQuery = em.createQuery({
        includes: ['logicTree'],
    });

    const compiledLogicTreeQuery = em.createQuery({
        includes: ['compiledLogicTree'],
    });

    function compileNodeSocket(
        tree: LogicTree,
        n: LogicNode,
        name: string,
        socket: string | number | LinkedSocket,
        type: 'input' | 'output' = 'input'
    ) {
        if (
            type === 'output' &&
            socket instanceof Object &&
            socket.links.find((l) => l.socket === 'Trigger')
        ) {
            return socket.links
                .filter((l) => l.socket === 'Trigger')
                .map((l) => ({
                    compiled: compileLogicNode(tree, tree[l.node]),
                    value: l.socket,
                }));
        }

        let value = socket;

        if (socket instanceof Object && socket.type === 'linked') {
            // TODO handle multiple inputs?
            value = socket.links[0].socket;
        } else if (typeof socket === 'string') {
            value = `"${value}"`;
        }

        let compiled = `const ${name} = ${value}`;

        return { compiled, value: value as string | number };
    }

    function compileLogicNode(
        tree: LogicTree,
        n: LogicNode
    ): { compiled: string; defines: string[] }[] {
        if (!n) return [{ compiled: '', defines: [] }];
        const method = methods[n.name];

        if (method) {
            const methodReflection = reflection.getMethod(n.name);

            // TODO handle whitespace better
            // const split = method
            //     .toString()
            //     .replace(/$    /m, '')
            //     .split(/\r?\n/);
            // split.pop();
            // split.shift();
            // let result = split.join('\n');

            // let result = `${n.name}(`;

            const compiledParameters: string[] = [];
            const defines: string[] = [n.name];

            // TODO replace function calls with compiled nodes

            methodReflection.getParameters().forEach((p) => {
                const input = n.inputs[p.name];
                const output = n.outputs[p.name];
                if (input) {
                    // console.log(
                    //     'compile input',
                    //     n.name,
                    //     p.name,
                    //     input,
                    //     compileNodeSocket(tree, n, p.name, input, 'input')
                    // );
                    // result =
                    //     compileNodeSocket(tree, n, p.name, input, 'input')
                    //         .compiled +
                    //     '\n\n' +
                    //     result;

                    const compiledInput = compileNodeSocket(
                        tree,
                        n,
                        p.name,
                        input,
                        'input'
                    );

                    compiledParameters.push(compiledInput.value.toString());
                } else if (output) {
                    const compiledOutput = compileNodeSocket(
                        tree,
                        n,
                        p.name,
                        output,
                        'output'
                    );

                    function handleOutput(compiledOutput: {
                        compiled: ReturnType<typeof compileLogicNode>;
                        value: string;
                    }) {
                        defines.push(
                            ...compiledOutput.compiled.reduce(
                                (d, c) => [...d, ...c.defines],
                                []
                            )
                        );
                        compiledParameters.push(
                            '() => { \n' +
                                compiledOutput.compiled.reduce(
                                    (o, c) =>
                                        o
                                            ? o + '; \n' + c.compiled
                                            : c.compiled,
                                    ''
                                ) +
                                '}'
                        );
                    }

                    if (Array.isArray(compiledOutput)) {
                        compiledOutput.forEach(handleOutput);
                    }

                    // result += '() => ' + compiledOutput.compiled;

                    // console.log('compile output', n.name, p.name, output);
                    // result = result.replace(
                    //     new RegExp(`( *?)${p.name}\\(\\);`, 'g'),

                    //     compileNodeSocket(
                    //         tree,
                    //         n,
                    //         p.name,
                    //         output,
                    //         'output'
                    //     ).compiled.replace(/$    /m, '    $1')
                    // );
                }
            });

            // TODO provide cache object to method calls
            return [
                {
                    compiled: `${n.name}.call(this, ${compiledParameters.join(
                        ', '
                    )})`,
                    defines,
                },
            ];
        } else {
            console.warn(
                '[compileLogicNode] skipping node without implementation',
                n
            );
            return getNext(tree, n).reduce(
                (acc, next) => [...acc, ...compileLogicNode(tree, next)],
                []
            );
        }
    }

    function compileLogicTree(logicTree: LogicTree) {
        const initialNode =
            logicTree['Group Input'] ||
            Object.values(logicTree).find((n) => n.type === 'GROUP_INPUT');
        return compileLogicNode(logicTree, initialNode);
    }

    const logicTreeSystem = em.createSystem(logicTreeQuery.createConsumer(), {
        forNew(entity, delta) {
            // TODO add loading manager
            const { logicTree } = entity.components;

            const compiledLogicTree = compileLogicTree(logicTree);
            const cache = {};
            console.log('[transpiledLogicNode]', compiledLogicTree);
            entity.components.compiledLogicTree = Function(
                'methods',
                'Geometry',
                `const { ${compiledLogicTree
                    .reduce((defines, c) => [...defines, c.defines], [])
                    .join(', ')} } = methods;\n${compiledLogicTree.reduce(
                    (r, c) => r + '\n' + c.compiled,
                    ''
                )}`
            ).bind(cache) as C['compiledLogicTree'];
            console.log(entity.components.compiledLogicTree);
        },
    });

    const compiledLogicTreeSystem = em.createSystem(compiledLogicTreeQuery, {
        interval: interval(1000 / 30),
        all(entity, delta) {
            const { compiledLogicTree, mesh } = entity.components;

            // //@ts-ignore
            // with (compiler) {
            compiledLogicTree(methods, mesh);
            // }
        },
    });

    const logicTreePipeline = new Pipeline(
        em,
        logicTreeSystem,
        compiledLogicTreeSystem
    );

    return { logicTreePipeline };
}
