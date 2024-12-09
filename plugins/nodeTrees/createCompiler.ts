import {
    ReceiveType,
    ReflectionClass,
    ReflectionKind,
    ReflectionParameter,
    resolveReceiveType,
    Type,
    typeOf,
} from '@deepkit/type';
import { camelCase, find } from 'lodash';
import { Mesh, Uniform } from 'three';

import staticLogicNodeTranspilers from './logic/staticNodeTranspilers';
import { transpilerMethods as logicTranspilerMethods } from './logic/transpilerMethods';

import staticShaderNodeTranspilers from './shader/staticNodeTranspilers';
import { transpilerMethods as shaderTranspilerMethods } from './shader/transpilerMethods';
import { ColorStop } from './shader/colorRamp';
import GLSL, { convertVecSize } from './shader/GLSL';
import { getReference, getReturnType } from './util';
import { glsl } from '../../shader/util';

export interface CompilationCache {
    defines: Set<string>;
    compiledInputs: Record<string, string>;
    inputTypes: Record<string, Type>;
    uniforms?: Record<string, { value: any }>;
    vertexDependencies?: Set<string>;
    shaderIncludes?: {
        vertex: Set<string>;
        fragment: Set<string>;
    };
}

// TODO handle multiple links
export interface LinkedSocket {
    type: 'linked';
    links: {
        node: string;
        socket: string;
    }[];
}

export interface NodeInput {
    value: string | boolean | number | string[] | number[];
    type:
        | 'OBJECT'
        | 'GEOMETRY'
        | 'VECTOR'
        | 'STRING'
        | 'FLOAT'
        | 'INTEGER'
        | 'VALUE'
        | 'CUSTOM'
        | 'RGBA'
        | 'SHADER';
}

export interface Node {
    id: string;
    name: string;
    type: string;
    inputs: {
        [key: string]:
            | NodeInput
            | LinkedSocket
            | Array<NodeInput | LinkedSocket>;
    };
    outputs: {
        [key: string]: number | number[] | LinkedSocket;
    };
    properties: {
        containsLogicTree?: boolean;
        elements?: ColorStop[];
        color_mode?: 'RGB' | string;
        interpolation?: 'EASE' | 'LINEAR' | 'B_SPLINE' | 'CONSTANT';
        hue_interpolation?: string;
    };
    internalLogicTree?: NodeTree;
}

export interface NodeTree {
    [key: string]: Node;
}

// TODO how does this change for shader trees?
export interface LogicTreeMethods {
    [key: string]: Function;
}

interface LogicTreeCompilerParameters<M extends LogicTreeMethods> {
    type: 'LogicTree';
    methods: M;
    reflection: ReflectionClass<M>;
    compiledTreeToFn: (
        transpiled: string[],
        compilationCache: CompilationCache
    ) => Function;
}

interface ShaderTreeCompilerParameters {
    type: 'ShaderTree';
}

function getNext(tree: NodeTree, n: NodeTree[keyof NodeTree]) {
    const field =
        n.outputs.Next ||
        n.outputs.Geometry ||
        n.outputs.Trigger ||
        n.outputs.Output;

    if (!field) return [];

    return field.links
        ?.filter((l) => l.socket === 'Trigger' || l.socket === 'Input')
        ?.map((l) => tree[l.node]);
}

export function createNodeTreeCompiler<M extends LogicTreeMethods>(
    parameters: LogicTreeCompilerParameters<M> | ShaderTreeCompilerParameters
) {
    const transpilerMethods =
        parameters.type === 'LogicTree'
            ? logicTranspilerMethods
            : shaderTranspilerMethods;
    const methods =
        parameters.type === 'LogicTree'
            ? parameters.methods
            : transpilerMethods;
    const transpilerReflection =
        ReflectionClass.from<typeof transpilerMethods>();

    function compileNodeSocket(
        tree: NodeTree,
        n: Node,
        parameterReflection: ReflectionParameter,
        socket: Node['inputs'][number],
        compilationCache: CompilationCache,
        type: 'output'
    ): { compiled: string[]; value: string }[];
    function compileNodeSocket(
        tree: NodeTree,
        n: Node,
        parameterReflection: ReflectionParameter,
        socket: Node['inputs'][number],
        compilationCache: CompilationCache,
        type: 'input'
    ): {
        compiled: string;
        reference: string | null;
        value: string | number | boolean;
        internalValue?: any;
    };
    function compileNodeSocket(
        tree: NodeTree,
        n: Node,
        parameterReflection: ReflectionParameter | null,
        socket: Node['inputs'][number],
        compilationCache: CompilationCache,
        type: 'input' | 'output' = 'input'
    ):
        | {
              compiled: string[];
              value: string;
          }[]
        | {
              compiled: string;
              reference: string | null;
              value: string | number | boolean;
              internalValue?: any;
          } {
        if (type === 'output') {
            if (socket instanceof Array) {
                return;
            }
            if (socket.type === 'linked') {
                const outputLinks = socket.links.filter(
                    (l) =>
                        l.socket === 'Trigger' ||
                        tree[l.node].type === 'REROUTE'
                );

                if (outputLinks) {
                    // TODO handle reroutessss
                    return outputLinks.map((l) => ({
                        compiled: compileLogicNode(
                            tree,
                            tree[l.node],
                            compilationCache
                        ),
                        value: l.socket,
                    }));
                }
            }

            console.warn('[compileNodeSocket] failed to compile input');
            return { compiled: null, reference: null, value: null };
        }

        let internalValue: any = null;

        if (socket instanceof Array) {
            const restCompiled = socket.map((arraySocket) =>
                compileNodeSocket(
                    tree,
                    n,
                    parameterReflection,
                    arraySocket,
                    compilationCache,
                    'input'
                )
            );
            internalValue = restCompiled.map((c) => c.value);
            if (parameterReflection.type.kind === ReflectionKind.rest) {
                return {
                    compiled: null,
                    reference: null,
                    value: internalValue.join(', '),
                    internalValue,
                };
                // console.log(
                //     '[logicTree compile rest input]',
                //     socket,
                //     socket.map((arraySocket) =>
                //         compileNodeSocket(
                //             tree,
                //             n,
                //             parameterReflection,
                //             arraySocket,
                //             compilationCache,
                //             'input'
                //         )
                //     )
                // );
            }
            return {
                compiled: null,
                reference: null,
                value: `[${internalValue.join(', ')}]`,
                internalValue,
            };
        }

        let value: string | number | boolean = null;

        let compiled: string | null = null;

        let reference: string | null = null;

        if (socket.type === 'linked') {
            // TODO handle multiple inputs?
            // TODO convert to variable name
            const inputNodeId = socket.links[0].node;
            const inputNode = tree[inputNodeId];
            let socketReference = socket.links[0].socket;

            // TODO standardize readers that don't need to be compiled?
            if (inputNode.name === 'entity' || inputNode.name === 'delta') {
                value = inputNode.name;
            } else if (
                inputNode.type === 'SIMULATION_INPUT' &&
                socketReference === 'Delta Time'
            ) {
                value = 'delta';
            } else if (
                inputNode.type === 'GROUP' &&
                inputNode.name === 'Time'
            ) {
                value = 'time';
                // TODO handle high-level re-use of uniforms
                compilationCache.uniforms.time = {
                    value: 0.0,
                };
                compilationCache.defines.add('uniform float time;');
            } else if (inputNode.type === 'TEX_COORD') {
                if (socketReference === 'UV') {
                    compilationCache.vertexDependencies?.add('uv');
                    value = 'vUv';

                    console.log(parameterReflection);
                    value = convertVecSize(
                        value,
                        compilationCache.inputTypes['vUv'],
                        parameterReflection.type
                    );
                }
            } else {
                reference = getReference(inputNodeId);
                value = reference + '.' + socketReference;
                // console.log('check input', inputNode);

                if (inputNode.type === 'SEPXYZ') {
                    const passthroughCompile = compileNodeSocket(
                        tree,
                        inputNode,
                        parameterReflection,
                        inputNode.inputs['Vector'],
                        compilationCache,
                        'input'
                    );

                    socketReference = socketReference.toLowerCase();
                    // TODO get more refined? based on vector type?
                    if (parameters.type === 'LogicTree') {
                        socketReference =
                            socketReference === 'y'
                                ? 'z'
                                : socketReference === 'z'
                                ? 'y'
                                : socketReference;
                    }

                    passthroughCompile.value += '.' + socketReference;
                    return passthroughCompile;
                    // return {value: '', compiled: null, reference: null};
                }
                // TODO generalize passthrough nodes
                if (
                    inputNode.type === 'SIMULATION_INPUT' ||
                    inputNode.type === 'REROUTE'
                ) {
                    return compileNodeSocket(
                        tree,
                        inputNode,
                        parameterReflection,
                        inputNode.inputs[
                            inputNode.type === 'REROUTE'
                                ? 'Input'
                                : socketReference
                        ],
                        compilationCache,
                        'input'
                    );
                }

                if (inputNode && !getNext(tree, inputNode).length) {
                    const intermediateCompiled = compileLogicNode(
                        tree,
                        inputNode,
                        compilationCache,
                        false
                    );

                    let inputType = compilationCache.inputTypes[reference];
                    console.log('input', inputNode.id, inputType);
                    let inputNotLiteralOrMissingKey =
                        inputType?.kind !== ReflectionKind.objectLiteral ||
                        !inputType?.types.find(
                            (t) => t.name === socketReference
                        );
                    if (
                        inputNotLiteralOrMissingKey &&
                        inputType.typeName === 'GLSL'
                    ) {
                        inputNotLiteralOrMissingKey =
                            inputType.typeArguments[0].kind ===
                                ReflectionKind.objectLiteral &&
                            !inputType.typeArguments[0].types.find(
                                (t) => t.name === socketReference
                            );
                    }

                    if (inputNotLiteralOrMissingKey) {
                        value = reference;
                        if (parameters.type !== 'LogicTree') {
                            value = convertVecSize(
                                value,
                                inputType,
                                parameterReflection.type
                            );
                        }
                    } else {
                        let referenceType: Type = null;
                        if (
                            inputType.typeName === 'GLSL' &&
                            inputType.typeArguments[0].kind ===
                                ReflectionKind.objectLiteral
                        ) {
                            referenceType =
                                inputType.typeArguments[0].types.find(
                                    (t) => t.name === socketReference
                                )?.type;
                        } else if (
                            inputType.kind === ReflectionKind.objectLiteral
                        ) {
                            referenceType = inputType.types?.find(
                                (t) => t.name === socketReference
                            )?.type;
                        }
                        if (referenceType) {
                            if (parameters.type !== 'LogicTree') {
                                value = convertVecSize(
                                    value,
                                    referenceType,
                                    parameterReflection.type
                                );
                            }
                        }
                    }
                    if (intermediateCompiled.length) {
                        const lastCompiledIndex =
                            intermediateCompiled.length - 1;
                        intermediateCompiled[lastCompiledIndex] =
                            reference +
                            ' = ' +
                            intermediateCompiled[lastCompiledIndex];

                        let constType =
                            parameters.type === 'LogicTree'
                                ? 'const'
                                : 'unknown';
                        if (parameters.type !== 'LogicTree') {
                            if (
                                inputType.indexAccessOrigin?.container
                                    .typeName === 'GLSL'
                            ) {
                                constType =
                                    inputType.indexAccessOrigin.index?.literal;
                            } else if (
                                inputType.typeName === 'GLSL' &&
                                inputType.typeArguments[0].kind ===
                                    ReflectionKind.objectLiteral
                            ) {
                                const structReference = camelCase(
                                    inputNode.type
                                );
                                constType = structReference;
                            } else {
                                constType = 'unknown';
                            }
                        } else {
                            // TODO improve accuracy of this
                        }
                        intermediateCompiled[lastCompiledIndex] =
                            constType +
                            ' ' +
                            intermediateCompiled[lastCompiledIndex];

                        compiled = intermediateCompiled.join('\n');

                        // TODO if input is a float we should reduce precision for performance?
                        compilationCache.compiledInputs[reference] = compiled;
                    } else if (!inputType) {
                        // TODO we should store inputType for static transpilers and instead include a warning in the compiled code here?
                        // value = reference;
                    }
                    // console.log('compiled input logicNode', inputNode, compiled);
                }
            }
        } else if (
            parameterReflection &&
            // TODO can be more specific (destructure the rest type)
            parameterReflection.type.kind !== ReflectionKind.rest &&
            socket.type !== 'VECTOR' &&
            // TODO make sure this is safe (hack to solve next TODO temporarily)
            socket.type !== 'VALUE' &&
            // TODO destructure if Array and see if matches
            ReflectionKind[parameterReflection.type.kind] !==
                typeof socket.value
        ) {
            if (socket.type === 'OBJECT' && typeof socket.value === 'string') {
                reference = camelCase(socket.value + 'Entity');

                value = reference;

                compiled = `const ${reference} = em.getEntity("${socket.value}");\nif (!${reference}) return`;

                compilationCache.compiledInputs[reference] = compiled;
            } else {
                console.warn(
                    '[compileNodeSocket] unable to convert',
                    socket,
                    'to',
                    ReflectionKind[parameterReflection.type.kind]
                );
            }
            // value = name;
        } else {
            value = socket.value;

            if (typeof value === 'string') {
                value = `"${value}"`;
            } else if (typeof value === 'number') {
                // TODO deal with precision errors?
                value = value.toFixed(4);
            } else if (socket.type === 'VECTOR') {
                if (parameters.type === 'LogicTree') {
                    value = `new Vector3(${value.join(', ')})`;
                } else {
                    value = `vec3(${value.join(', ')})`;
                }
                // TODO hold onto a static vector?
            }
        }
        // console.log('[compileNodeSocket]', n, p, ReflectionKind[p.type.kind]);

        if (
            parameterReflection &&
            parameterReflection.type.kind === ReflectionKind.array
        ) {
            // value = `[${value}]`;
            // TODO replace hack for when using transpilerMethod and there was only 1 value from node
            internalValue = [value];
        }

        return {
            compiled,
            reference,
            value: value as string | number | boolean,
            internalValue,
        };
    }

    function compileLogicNode(
        tree: NodeTree,
        n: Node,
        compilationCache: CompilationCache,
        walk = true
    ): string[] {
        if (!n) return [];

        // TODO handle constants and internal nodes

        if (n.name in staticLogicNodeTranspilers) {
            return staticLogicNodeTranspilers[n.name](
                tree,
                n,
                compilationCache
            );
        }

        const method = methods[n.name];

        if (n.internalLogicTree) {
            if (method) {
                console.warn(
                    '[compileLogicNode] potentially conflicting internalLogicTree and code implementation, internal logic tree will be used.',
                    n
                );
            }

            // TODO implement prefix or nesting for cache stuff
            const compiledInternalLogicTree = compileLogicTree(
                n.internalLogicTree
            );
            console.log(
                '[compiledInternalLogicTree]',
                n,
                compiledInternalLogicTree
            );

            compilationCache.compiledInputs = {
                ...compilationCache.compiledInputs,
                ...compiledInternalLogicTree.compilationCache.compiledInputs,
            };
            compilationCache.defines = compilationCache.defines.union(
                compiledInternalLogicTree.compilationCache.defines
            );

            const reference = getReference(n.id);

            compilationCache.compiledInputs[
                reference
            ] = `const ${reference} = {${Object.keys(n.inputs).reduce(
                (o, k) => {
                    const socket = n.inputs[k];
                    const compiledSocket = compileNodeSocket(
                        tree,
                        n,
                        null,
                        socket,
                        compilationCache,
                        'input'
                    );

                    o += `${k}: ${
                        compiledSocket.reference || compiledSocket.value
                    }, `;

                    return o;
                },
                ''
            )}}`;

            return compiledInternalLogicTree.transpiled.map((s) =>
                !s ? '' : s.replace(/groupInput/g, reference)
            );
        }

        if (method) {
            const isMethodTranspiler =
                parameters.type === 'LogicTree'
                    ? !parameters.reflection.hasMethod(n.name)
                    : true;
            const methodReflection =
                parameters.type === 'LogicTree' && !isMethodTranspiler
                    ? parameters.reflection?.getMethod(n.name)
                    : transpilerReflection.getMethod(n.name);

            const compiledParameters: any[] = [];

            const { defines, compiledInputs } = compilationCache;

            if (!isMethodTranspiler) defines.add(n.name);

            // console.log(
            //     n.name,
            //     methodReflection,
            //     methodReflection.getReturnType()
            // );

            // TODO implement handling of array inputs to a non array parameter

            let result = ['$1'];

            methodReflection.getParameters().forEach((p) => {
                const input = find(
                    n.inputs,
                    (value, key) => key.replace(/\ /g, '') === p.name
                );
                const output = find(
                    n.outputs,
                    (value, key) => key.replace(/\ /g, '') === p.name
                );
                const property = find(
                    n.properties,
                    (value, key) => key.replace(/\ /g, '') === p.name
                );

                // TODO refactor this and handle things like enum or and isMethodTranspiler more gracefully

                if (
                    isMethodTranspiler &&
                    // TODO figure out why type doesn't have typeName here
                    p.name === 'compilationCache'
                ) {
                    compiledParameters.push(compilationCache);
                    return;
                }

                // TODO figure out why type doesn't have typeName here
                if (isMethodTranspiler && p.name === 'node') {
                    compiledParameters.push(n);
                    return;
                }

                if (input !== undefined) {
                    const compiledInput = compileNodeSocket(
                        tree,
                        n,
                        p,
                        input,
                        compilationCache,
                        'input'
                    );

                    if (compiledInput.reference) {
                        const inputType =
                            compilationCache.inputTypes[
                                compiledInput.reference
                            ];

                        if (
                            inputType &&
                            inputType.kind === ReflectionKind.objectLiteral
                        ) {
                            const keyReference = compiledInput.value
                                .toString()
                                .split('.')[1];

                            if (
                                keyReference &&
                                inputType.types.find(
                                    (t) => t.name === keyReference
                                )?.type.typeName === 'Iterable'
                            ) {
                                const itemReference = camelCase(
                                    compiledInput.reference + p.name
                                );
                                // TODO handle looped inputs and their dependency graph
                                result.unshift(
                                    `for (let ${itemReference} of ${compiledInput.value.toString()}) {`
                                );
                                result.push('}');

                                compiledInput.value = itemReference;
                                // console.log(
                                //     'input is iterable',
                                //     n,
                                //     compiledInput
                                // );
                            }
                        }
                    }

                    // if (
                    //     isMethodTranspiler &&
                    //     p.type.kind == ReflectionKind.rest
                    // ) {
                    //     compiledParameters.push(
                    //         ...compiledInput.value.toString().split(', ')
                    //     );
                    // } else
                    if (isMethodTranspiler && compiledInput.internalValue) {
                        compiledParameters.push(compiledInput.internalValue);
                    } else {
                        compiledParameters.push(
                            compiledInput.value?.toString()
                        );
                    }
                } else if (output !== undefined) {
                    const compiledOutput = compileNodeSocket(
                        tree,
                        n,
                        p,
                        output,
                        compilationCache,
                        'output'
                    );

                    function handleOutput(compiledOutput: {
                        compiled: ReturnType<typeof compileLogicNode>;
                        value: string;
                    }) {
                        compiledParameters.push(
                            '() => { \n' +
                                compiledOutput.compiled.reduce(
                                    (o, c) =>
                                        o
                                            ? o +
                                              '\n' +
                                              c.replace(/^/gm, '    ')
                                            : c.replace(/^/gm, '    '),
                                    ''
                                ) +
                                '\n}'
                        );
                    }

                    if (Array.isArray(compiledOutput)) {
                        compiledOutput.forEach(handleOutput);
                    }
                } else if (p.name === 'delta') {
                    compiledParameters.push('delta');
                } else if (property !== undefined) {
                    if (isMethodTranspiler) {
                        // TODO genericize this concept
                        compiledParameters.push(property);

                        if (p.type.kind === ReflectionKind.enum) {
                            console.log(p);
                        }
                    } else {
                        compiledParameters.push(
                            typeof property === 'string'
                                ? `"${property}"`
                                : property.toString()
                        );
                    }
                } else {
                    compiledParameters.push(undefined);
                }
            });

            const returnType = getReturnType(
                methodReflection,
                compiledParameters
            );
            compilationCache.inputTypes[getReference(n.id)] = returnType;

            if (isMethodTranspiler) {
                result = method.apply({}, compiledParameters);

                if (
                    returnType.typeName === 'GLSL' &&
                    returnType.typeArguments[0].kind ===
                        ReflectionKind.objectLiteral
                ) {
                    const structReference = camelCase(n.type);
                    compilationCache.defines.add(glsl`
                        struct ${structReference} {
                        ${returnType.typeArguments[0].types
                            .map(
                                (t) =>
                                    '    ' +
                                    t.type.indexAccessOrigin.index.literal +
                                    ' ' +
                                    t.name +
                                    ';'
                            )
                            .join('\n')}
                        };
                    `);

                    result[result.length - 1] = `${structReference}(${
                        result[result.length - 1]
                    })`;
                }

                if (result.length) result[result.length - 1] += ';';
                console.log(
                    '[logicTree.isMethodTranspiler]',
                    result,
                    compiledParameters
                );
            } else {
                result = result.map((r) =>
                    r === '$1'
                        ? `${n.name}.call(this['${n.id}'] = this['${
                              n.id
                          }'] || {}, ${compiledParameters.join(', ')});`
                        : r
                );
            }

            return walk
                ? getNext(tree, n).reduce(
                      (acc, next) => [
                          ...acc,
                          ...compileLogicNode(tree, next, compilationCache),
                      ],
                      result
                  )
                : result;
        } else {
            if (
                n.type !== 'GROUP_INPUT' &&
                n.type !== 'SIMULATION_INPUT' &&
                n.type !== 'REROUTE'
            ) {
                console.warn(
                    '[compileLogicNode] skipping node without implementation',
                    n
                );
            }
            return getNext(tree, n).reduce(
                (acc, next) => [
                    ...acc,
                    ...compileLogicNode(tree, next, compilationCache),
                ],
                []
            );
        }
    }

    function compileLogicTree(logicTree: NodeTree) {
        const startingNodes = Object.values(logicTree).filter(
            (n) =>
                n.type ===
                (parameters.type === 'LogicTree'
                    ? 'SIMULATION_INPUT'
                    : 'OUTPUT_MATERIAL')
        );

        let initFn: undefined | Function;

        if (parameters.type === 'LogicTree') {
            const initializationNodes = Object.values(logicTree).filter(
                (n) => n.type === 'GROUP_INPUT'
            );

            const initCache: CompilationCache = {
                defines: new Set(),
                compiledInputs: {},
                inputTypes: {
                    groupInput: ReflectionClass.from<{
                        Geometry: Mesh;
                    }>().type,
                },
            };

            initFn = parameters.compiledTreeToFn(
                initializationNodes
                    .map((n) => compileLogicNode(logicTree, n, initCache))
                    .flat(2),
                initCache
            );
        }

        const compilationCache: CompilationCache = {
            defines: new Set(),
            compiledInputs: {},
            inputTypes: {
                groupInput: ReflectionClass.from<{ Geometry: Mesh }>().type,
            },
        };

        if (parameters.type === 'ShaderTree') {
            compilationCache.inputTypes['vUv'] = typeOf<GLSL['vec2']>();
            compilationCache.shaderIncludes = {
                vertex: new Set(),
                fragment: new Set(),
            };
            compilationCache.uniforms = {};
            compilationCache.vertexDependencies = new Set();
        }

        const transpiled = startingNodes.reduce((r, startingNode) => {
            r.push(
                ...compileLogicNode(logicTree, startingNode, compilationCache)
            );

            return r;
        }, new Array<string>());

        let fn: undefined | Function;
        if (parameters.type === 'LogicTree') {
            fn = parameters.compiledTreeToFn(transpiled, compilationCache);
        }

        return { transpiled, fn, initFn, compilationCache };
    }

    return compileLogicTree;
}
