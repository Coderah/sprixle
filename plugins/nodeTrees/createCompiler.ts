import {
    ReflectionClass,
    ReflectionKind,
    ReflectionMethod,
    ReflectionParameter,
    Type,
    TypeMethod,
    typeOf,
} from '@deepkit/type';
import { find } from 'lodash';
import { Mesh } from 'three';

import staticLogicNodeTranspilers from './logic/staticNodeTranspilers';
import { transpilerMethods as logicTranspilerMethods } from './logic/transpilerMethods';

import { uniformTime } from '../../render/const';
import { glsl } from '../../shader/util';
import { ColorStop } from './shader/colorRamp';
import {
    combineFragmentShader,
    combineVertexShader,
} from './shader/combineCode';
import GLSL, { convertVecSize, dynamicNodeToType } from './shader/GLSL';
import staticShaderNodeTranspilers from './shader/staticNodeTranspilers';
import { transpilerMethods as shaderTranspilerMethods } from './shader/transpilerMethods';
import {
    getParameterReference,
    getReference,
    getReturnType,
    getStructReference,
} from './util';
import { TypeParameter } from 'typescript';

export interface CompilationCache {
    defines: Set<string>;
    compiledInputs: Record<string, string>;
    inputTypes: Record<string, Type>;
    uniforms?: Record<string, { value: any }>;
    features?: Set<string>;
    shader?: {
        vertex: string[];
        vertexIncludes: Set<string>;
        fragmentIncludes: Set<string>;
    };
}

export type InputType =
    | 'OBJECT'
    | 'GEOMETRY'
    | 'VECTOR'
    | 'STRING'
    | 'FLOAT'
    | 'INTEGER'
    | 'INT'
    | 'VALUE'
    | 'CUSTOM'
    | 'RGBA'
    | 'SHADER';

// TODO handle multiple links
export interface LinkedSocket {
    type: 'linked';
    intended_type: InputType;
    links: {
        node: string;
        socket: string;
    }[];
}

export interface NodeSocket {
    value: string | boolean | number | string[] | number[];
    input_hidden?: boolean;
    type: InputType;
}

export interface Node {
    id: string;
    name: string;
    type: string;
    inputs: {
        [key: string]:
            | NodeSocket
            | LinkedSocket
            | Array<NodeSocket | LinkedSocket>;
    };
    outputs: {
        [key: string]: NodeSocket | LinkedSocket;
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
    const transpilerReflection = typeOf<typeof transpilerMethods>();

    console.log(transpilerReflection);

    // TODO warn
    if (transpilerReflection.kind !== ReflectionKind.objectLiteral) return;

    function compileNodeSocket(
        tree: NodeTree,
        n: Node,
        parameterReflection: TypeParameter,
        socket: Node['inputs'][number],
        compilationCache: CompilationCache,
        type: 'output'
    ): { compiled: string[]; value: string }[];
    function compileNodeSocket(
        tree: NodeTree,
        n: Node,
        parameterReflection: TypeParameter,
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
        parameterReflection: TypeParameter,
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
                        compiled: compileNode(
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
            let socketReference = getParameterReference(socket.links[0].socket);

            // TODO standardize readers that don't need to be compiled?
            if (inputNode.name === 'entity' || inputNode.name === 'delta') {
                value = inputNode.name;
            } else if (
                inputNode.type === 'SIMULATION_INPUT' &&
                socketReference === 'DeltaTime'
            ) {
                value = 'delta';
            } else if (
                inputNode.type === 'GROUP' &&
                inputNode.name === 'Time'
            ) {
                value = 'time';
                // TODO handle high-level re-use of uniforms
                compilationCache.uniforms.time = uniformTime;
                compilationCache.shader.fragmentIncludes.add(
                    'uniform float time;'
                );
            } else {
                reference = getReference(inputNodeId);
                value =
                    parameters.type !== 'LogicTree' &&
                    inputNode.type === 'GROUP_INPUT'
                        ? socketReference
                        : reference + '.' + socketReference;
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
                    // if (parameters.type === 'LogicTree') {
                    //     socketReference =
                    //         socketReference === 'y'
                    //             ? 'z'
                    //             : socketReference === 'z'
                    //             ? 'y'
                    //             : socketReference;
                    // }

                    passthroughCompile.value += '.' + socketReference;
                    return passthroughCompile;
                    // return {value: '', compiled: null, reference: null};
                }
                // TODO generalize passthrough nodes
                if (
                    inputNode.type === 'SIMULATION_INPUT' ||
                    inputNode.type === 'REROUTE'
                    // inputNode.type === 'SHADERTORGB'
                ) {
                    return compileNodeSocket(
                        tree,
                        inputNode,
                        parameterReflection,
                        inputNode.inputs[
                            inputNode.type === 'SHADERTORGB'
                                ? 'Shader'
                                : inputNode.type === 'REROUTE'
                                ? 'Input'
                                : socketReference
                        ],
                        compilationCache,
                        'input'
                    );
                }

                if (inputNode && !getNext(tree, inputNode).length) {
                    const intermediateCompiled = compileNode(
                        tree,
                        inputNode,
                        compilationCache,
                        false
                    );

                    let inputType = compilationCache.inputTypes[reference];
                    console.log('input', reference, socketReference, inputType);
                    let inputNotLiteralOrMissingKey =
                        inputType?.kind !== ReflectionKind.objectLiteral ||
                        !inputType?.types.find(
                            (t) => t.name === socketReference
                        );
                    if (
                        inputNotLiteralOrMissingKey &&
                        inputType?.typeName === 'GLSL'
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
                                // TODO handle rewrite types?
                                if (constType === 'imageTex') {
                                    constType = 'vec4';
                                }
                            } else if (
                                inputType.typeName === 'GLSL' &&
                                inputType.typeArguments[0].kind ===
                                    ReflectionKind.objectLiteral
                            ) {
                                const structReference = getStructReference(
                                    inputNode.type === 'GROUP'
                                        ? inputNode.name
                                        : inputNode.type
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
            parameters.type === 'LogicTree' &&
            parameterReflection &&
            // TODO can be more specific (destructure the rest type)
            parameterReflection.type.kind !== ReflectionKind.rest &&
            socket.type !== 'VECTOR' &&
            socket.type !== 'RGBA' &&
            // TODO make sure this is safe (hack to solve next TODO temporarily)
            socket.type !== 'VALUE' &&
            // TODO destructure if Array and see if matches
            ReflectionKind[parameterReflection.type.kind] !==
                typeof socket.value
        ) {
            if (socket.type === 'OBJECT' && typeof socket.value === 'string') {
                reference = getReference(socket.value + 'Entity');

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
                value =
                    socket.type === 'INT' ? value.toString() : value.toFixed(4);
            } else if (socket.type === 'VECTOR' || socket.type === 'RGBA') {
                if (parameters.type === 'LogicTree') {
                    value = `new Vector${
                        socket.type === 'VECTOR' ? '3' : '4'
                    }(${value.join(', ')})`;
                } else {
                    value = `vec${socket.type === 'VECTOR' ? '3' : '4'}(${value
                        .map((v) => v.toFixed(4))
                        .join(', ')})`;
                    value = convertVecSize(
                        value,
                        socket.type === 'VECTOR'
                            ? typeOf<GLSL['vec3']>()
                            : typeOf<GLSL['vec4']>(),
                        parameterReflection.type
                    );
                }
                // TODO logicTree hold onto a static vector?
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

    function compileNode(
        tree: NodeTree,
        n: Node,
        compilationCache: CompilationCache,
        walk = true
    ): string[] {
        if (!n) return [];

        if (n.name in staticLogicNodeTranspilers) {
            return (
                parameters.type === 'LogicTree'
                    ? staticLogicNodeTranspilers
                    : staticShaderNodeTranspilers
            )[n.name](tree, n, compilationCache);
        }

        const method = methods[n.name];

        let isMethodTranspiler =
            parameters.type === 'LogicTree'
                ? !parameters.reflection.hasMethod(n.name)
                : true;
        let methodReflection: TypeMethod = null;

        if (method) {
            methodReflection =
                parameters.type === 'LogicTree' && !isMethodTranspiler
                    ? parameters.reflection?.getMethod(n.name)
                    : transpilerReflection.types.find((t) => t.name === n.name);
        } else if (n.type === 'GROUP_OUTPUT' || n.type === 'GROUP') {
            methodReflection = dynamicNodeToType(n) as TypeMethod;
            isMethodTranspiler = true;
            // debugger;
        }

        function handleInternalTree() {
            // TODO rename internalLogicTree to internalNodeTree
            if (n.internalLogicTree) {
                if (method) {
                    console.warn(
                        '[compileNode] internalNodeTree being ignore in favor of code implementation.',
                        n
                    );
                    return;
                }

                // TODO implement prefix or nesting for cache stuff
                const compiledInternalNodeTree = compileLogicTree(
                    n.internalLogicTree,
                    true
                );
                console.log(
                    '[compiledInternalNodeTree]',
                    n,
                    compiledInternalNodeTree
                );

                compilationCache.defines = compilationCache.defines.union(
                    compiledInternalNodeTree.compilationCache.defines
                );

                const reference = getReference(n.id);

                if (parameters.type !== 'LogicTree') {
                    console.log(
                        '[compiledInternalNodeTree] compilation cache',
                        compiledInternalNodeTree.compilationCache
                    );
                    // TODO if return is a single type, bypass struct business

                    const { groupInput } =
                        compiledInternalNodeTree.compilationCache.inputTypes;

                    const structReference = getStructReference(n.name);
                    const functionReference = getReference(n.name);

                    // inference
                    let functionArguments: string[] = [];
                    if (
                        groupInput &&
                        groupInput.typeArguments?.[0]?.kind ===
                            ReflectionKind.objectLiteral
                    ) {
                        functionArguments =
                            groupInput.typeArguments[0].types.map((t) => {
                                if (
                                    t.kind === ReflectionKind.propertySignature
                                ) {
                                    const typeName =
                                        t.type.indexAccessOrigin?.container
                                            .typeName === 'GLSL'
                                            ? t.type.indexAccessOrigin.index
                                                  .literal
                                            : t.name;

                                    return (
                                        typeName +
                                        ' ' +
                                        getParameterReference(t.name)
                                    );
                                }

                                return 'COMPILATION_ERROR';
                            });
                    }

                    compilationCache.shader.fragmentIncludes.add(`
                        ${structReference} ${functionReference}(${functionArguments}) {
                            ${compiledInternalNodeTree.fragmentShader.replace(
                                '$structReference',
                                structReference
                            )}
                        }
                    `);

                    compilationCache.uniforms = {
                        ...compiledInternalNodeTree.compilationCache.uniforms,
                        ...compilationCache.uniforms,
                    };

                    compilationCache.shader.fragmentIncludes =
                        compiledInternalNodeTree.compilationCache.shader.fragmentIncludes.union(
                            compilationCache.shader.fragmentIncludes
                        );
                    compilationCache.shader.vertexIncludes =
                        compiledInternalNodeTree.compilationCache.shader.vertexIncludes.union(
                            compilationCache.shader.vertexIncludes
                        );

                    compilationCache.features = compilationCache.features.union(
                        compiledInternalNodeTree.compilationCache.features
                    );
                } else {
                    compilationCache.compiledInputs = {
                        ...compilationCache.compiledInputs,
                        ...compiledInternalNodeTree.compilationCache
                            .compiledInputs,
                    };
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

                    return compiledInternalNodeTree.transpiled.map((s) =>
                        !s ? '' : s.replace(/groupInput/g, reference)
                    );
                }
            }
        }

        if (methodReflection) {
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

            methodReflection.parameters.forEach((p) => {
                const input = find(
                    n.inputs,
                    (value, key) =>
                        getParameterReference(key) ===
                        getParameterReference(p.name)
                );
                const output = find(
                    n.outputs,
                    (value, key) =>
                        getParameterReference(key) ===
                        getParameterReference(p.name)
                );
                const property = find(
                    n.properties,
                    (value, key) =>
                        getParameterReference(key) ===
                        getParameterReference(p.name)
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
                    if (
                        !Array.isArray(input) &&
                        input.type !== 'linked' &&
                        input.input_hidden &&
                        p.default
                    ) {
                        // TODO check in logic trees
                        compiledParameters.push(undefined);
                        return;
                    }

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
                                const itemReference = getReference(
                                    compiledInput.reference + p.name
                                );
                                // TODO handle looped inputs and their dependency graph
                                result.unshift(
                                    `for (let ${itemReference} of ${compiledInput.value.toString()}) {`
                                );
                                result.push('}');

                                compiledInput.value = itemReference;
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
                        compiled: ReturnType<typeof compileNode>;
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
                    } else {
                        // TODO should we even be here? MAP_RANGE for FLOAT triggered
                        compiledParameters.push(undefined);
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
                if (method) result = method.apply({}, compiledParameters);

                if (parameters.type !== 'LogicTree' && n.type === 'GROUP') {
                    // Handle constructed GLSL function call
                    result = [
                        `${getReference(n.name)}(${compiledParameters.join(
                            ', '
                        )})`,
                    ];
                }

                if (
                    parameters.type !== 'LogicTree' &&
                    n.type === 'GROUP_OUTPUT'
                ) {
                    result = [
                        `return $structReference(${compiledParameters.join(
                            ', '
                        )})`,
                    ];
                } else if (
                    returnType.typeName === 'GLSL' &&
                    returnType.typeArguments[0].kind ===
                        ReflectionKind.objectLiteral
                ) {
                    const structReference = getStructReference(
                        n.type === 'GROUP' ? n.name : n.type
                    );
                    console.log(
                        '[STRUCT REFERENCE]',
                        structReference,
                        returnType
                    );
                    compilationCache.shader.fragmentIncludes.add(glsl`
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

                    if (n.type !== 'GROUP' && result.length) {
                        result[result.length - 1] = `${structReference}(${
                            result[result.length - 1]
                        })`;
                    }
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

            handleInternalTree();

            return walk
                ? getNext(tree, n).reduce(
                      (acc, next) => [
                          ...acc,
                          ...compileNode(tree, next, compilationCache),
                      ],
                      result
                  )
                : result;
        } else {
            handleInternalTree();

            if (
                n.type !== 'GROUP_INPUT' &&
                n.type !== 'SIMULATION_INPUT' &&
                n.type !== 'REROUTE' &&
                n.type !== 'GROUP_OUTPUT'
            ) {
                console.warn(
                    '[compileNode] skipping node without implementation',
                    n
                );
            }
            if (parameters.type !== 'LogicTree' && n.type === 'GROUP_INPUT') {
                compilationCache.inputTypes[getReference(n)] = getReturnType(
                    dynamicNodeToType(n)
                );
            }
            return getNext(tree, n).reduce(
                (acc, next) => [
                    ...acc,
                    ...compileNode(tree, next, compilationCache),
                ],
                []
            );
        }
    }

    function compileLogicTree(nodeTree: NodeTree, internal = false) {
        const startingNodes = Object.values(nodeTree).filter((n) => {
            if (parameters.type === 'LogicTree') {
                return n.type === 'SIMULATION_INPUT';
            } else {
                return (
                    n.type === 'OUTPUT_MATERIAL' || n.type === 'GROUP_OUTPUT'
                );
            }
        });

        console.log('[STARTING NODES]', startingNodes);

        let initFn: undefined | Function;

        if (parameters.type === 'LogicTree') {
            const initializationNodes = Object.values(nodeTree).filter(
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
                    .map((n) => compileNode(nodeTree, n, initCache))
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
            delete compilationCache.inputTypes['groupInput'];
            compilationCache.inputTypes['vUv'] = typeOf<GLSL['vec2']>();
            compilationCache.shader = {
                vertex: [],
                vertexIncludes: new Set(),
                fragmentIncludes: new Set(),
            };
            compilationCache.uniforms = {};
            compilationCache.features = new Set();
        }

        const transpiled = startingNodes.reduce((r, startingNode) => {
            r.push(...compileNode(nodeTree, startingNode, compilationCache));

            return r;
        }, new Array<string>());

        if (parameters.type === 'ShaderTree') {
            let vertexShader = '';
            let fragmentShader = '';

            if (!internal) {
                vertexShader = combineVertexShader(
                    transpiled,
                    compilationCache
                );
                fragmentShader = combineFragmentShader(
                    transpiled,
                    compilationCache
                );
            } else {
                fragmentShader = `${Object.values(
                    compilationCache.compiledInputs
                ).join('\n')}
${transpiled.join('\n')}`;
            }

            return {
                vertexShader,
                fragmentShader,
                transpiled,
                compilationCache,
            };
        }

        let fn: undefined | Function;
        if (parameters.type === 'LogicTree') {
            fn = parameters.compiledTreeToFn(transpiled, compilationCache);
        }

        return { transpiled, fn, initFn, compilationCache };
    }

    return compileLogicTree;
}
