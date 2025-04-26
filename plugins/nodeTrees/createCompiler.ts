import {
    metaAnnotation,
    ReflectionClass,
    ReflectionKind,
    ReflectionMethod,
    ReflectionParameter,
    Type,
    TypeMethod,
    typeOf,
    TypePropertySignature,
} from '@deepkit/type';
import { find } from 'lodash';
import {
    Camera,
    Group,
    InstancedMesh,
    Material,
    Mesh,
    Object3D,
    Scene,
    ShaderMaterial,
    WebGLRenderer,
} from 'three';

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
    getConditionalType,
    getParameterReference,
    getReference,
    getReturnType,
    getStructReference,
} from './util';
import {
    LiteralType,
    ObjectType,
    TypeParameter,
    UnionOrIntersectionType,
} from 'typescript';
import { BatchedMesh, Geometry } from 'three-stdlib';
import { CompositeTexture } from './shader/compositeTexture';

export interface CompilationCache {
    defines: Set<string>;
    compiledInputs: {
        current: number;
        compiled: Record<string, string>[];
    };
    inputTypes: Record<string, Type>;
    uniforms?: Record<string, { value: any }>;
    features?: Set<string>;
    shader?: {
        vertex: string[];
        displace: string[];
        vertexIncludes: Set<string>;
        vertexFunctionStubs: Set<string>;
        fragmentIncludes: Set<string>;
        fragmentFunctionStubs: Set<string>;
        currentVectorSpace: VectorSpace;
        onBeforeRender: Set<
            (
                this: ShaderMaterial,
                renderer: WebGLRenderer,
                scene: Scene,
                camera: Camera,
                geometry: Geometry,
                object: Object3D,
                group: Group
            ) => void
        >;
        onMaterialApplied: Set<
            (mesh: Mesh | InstancedMesh | BatchedMesh) => void
        >;
        compositeTextures: {
            [key: string]: CompositeTexture;
        };
    };
}

export enum shaderTargetInputs {
    Vertex,
    Displacement,
    Fragment,
}

export type InputType =
    | 'OBJECT'
    | 'GEOMETRY'
    | 'VECTOR'
    | 'STRING'
    | 'FLOAT'
    | 'BOOLEAN'
    | 'BOOL'
    | 'INTEGER'
    | 'INT'
    | 'VALUE'
    | 'CUSTOM'
    | 'RGBA'
    | 'SHADER';

export type GenericNodeSocket = { input_hidden?: boolean };

// TODO handle multiple links
export type GenericLinkedSocket = GenericNodeSocket & {
    type: 'linked';
    intended_type: InputType;
    links: {
        node: string;
        socket: string;
    }[];
};

export type VectorSpace =
    | 'UV'
    | 'OBJECT'
    | 'CAMERA'
    | 'SCREEN'
    | 'OBJECT_NORMAL'
    | 'WORLD_REFLECTION'
    | 'OBJECT_GENERATED'
    | 'TANGENT'
    | 'PRESERVE'
    | 'INSTANCE'
    | 'WORLD';

export type LinkedSocket =
    | GenericLinkedSocket
    | (GenericLinkedSocket & {
          intended_type: 'VECTOR';
          vector_space: VectorSpace;
      });

type GenericValuedNodeSocket = GenericNodeSocket & {
    value: string | boolean | number | string[] | number[];
    type: InputType;
};
export type NodeSocket =
    | GenericValuedNodeSocket
    | (GenericValuedNodeSocket & {
          type: 'VECTOR';
          vector_space: VectorSpace;
          incoming_vector_space?: VectorSpace;
      });

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
        vector_space?: VectorSpace;
    };
    internalNodeTree?: string;
}

export type NodeTree = {
    [key: string]: Node;
} & {
    $internalTrees: {
        [key: string]: NodeTree;
    };
};

export interface LogicTreeMethods {
    [key: string]: Function;
}

export interface ShaderTreeMethods {
    [key: string]: Function;
}

interface LogicTreeCompilerParameters<M extends LogicTreeMethods> {
    type: 'LogicTree';
    methods: M;
    reflection: UnionOrIntersectionType;
    compiledTreeToFn: (
        transpiled: string[],
        compilationCache: CompilationCache
    ) => Function;
    currentInternalTrees?: {
        [key: string]: NodeTree;
    };
    compiledInternalTrees?: Set<string>;
}

type ShaderTreeCompilerParameters = {
    type: 'ShaderTree';
    methods: ShaderTreeMethods;
    reflection: UnionOrIntersectionType;
    currentInternalTrees?: {
        [key: string]: NodeTree;
    };
    compiledInternalTrees?: Set<string>;
};

function getNext(tree: NodeTree, n: NodeTree[keyof NodeTree]) {
    const field =
        n.outputs.Next ||
        n.outputs.Geometry ||
        n.outputs.Trigger ||
        n.outputs.Output;

    if (!field || field.type !== 'linked') return [];

    return field.links
        ?.filter((l) => l.socket === 'Trigger' || l.socket === 'Input')
        ?.map((l) => tree[l.node]);
}

export function addCompiledInput(
    reference: string,
    compiled: string,
    compilationCache: CompilationCache
) {
    const { compiledInputs } = compilationCache;
    if (
        compiledInputs.current === shaderTargetInputs.Vertex &&
        compiledInputs.compiled[shaderTargetInputs.Displacement] &&
        reference in compiledInputs.compiled[shaderTargetInputs.Displacement]
    ) {
        return;
    }
    compiledInputs.compiled[compiledInputs.current][reference] = compiled;
}

export function enterVectorSpace(
    vectorSpace: VectorSpace,
    compilationCache: CompilationCache
) {
    if (!compilationCache.shader) return;
    if (vectorSpace === 'PRESERVE') return;

    compilationCache.shader.currentVectorSpace = vectorSpace;
}

export function addContextualShaderInclude(
    compilationCache: CompilationCache,
    include: string
) {
    // TODO compcache should probably have includes and body as an array unbounding from vertex / fragment

    // TODO compiledInputs.current should be lifted; maybe `currentTarget`?
    const current = compilationCache.compiledInputs.current;

    if (current === shaderTargetInputs.Fragment) {
        compilationCache.shader.fragmentIncludes.add(include);
    } else {
        compilationCache.shader.vertexIncludes.add(include);
    }
}

export function addContextualShaderFunctionStub(
    compilationCache: CompilationCache,
    functionStub: string
) {
    // TODO compcache should probably have includes and body as an array unbounding from vertex / fragment

    // TODO compiledInputs.current should be lifted; maybe `currentTarget`?
    const current = compilationCache.compiledInputs.current;

    if (current === shaderTargetInputs.Fragment) {
        compilationCache.shader.fragmentFunctionStubs.add(functionStub);
    } else {
        compilationCache.shader.vertexFunctionStubs.add(functionStub);
    }
}

export function createNodeTreeCompiler<M extends LogicTreeMethods>(
    parameters: LogicTreeCompilerParameters<M> | ShaderTreeCompilerParameters
) {
    const transpilerMethods =
        parameters.type === 'LogicTree'
            ? logicTranspilerMethods
            : shaderTranspilerMethods;
    const methods =
        'methods' in parameters ? parameters.methods : transpilerMethods;
    const transpilerReflection = typeOf<
        typeof transpilerMethods
    >() as unknown as UnionOrIntersectionType;

    // console.log(transpilerReflection);

    // TODO warn
    if (transpilerReflection.kind !== ReflectionKind.objectLiteral) return;

    function compileNodeSocket(
        tree: NodeTree,
        n: Node,
        parameterReflection: TypeParameter,
        socket: Node['inputs'][number],
        compilationCache: CompilationCache,
        type: 'output',
        parameterType?: Type
    ): { compiled: string[]; value: string }[];
    function compileNodeSocket(
        tree: NodeTree,
        n: Node,
        parameterReflection: TypeParameter,
        socket: Node['inputs'][number],
        compilationCache: CompilationCache,
        type: 'input',
        parameterType?: Type
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
        socket: Node['inputs'][string],
        compilationCache: CompilationCache,
        type: 'input' | 'output' = 'input',
        parameterType: Type = parameterReflection.type
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
            if (socket?.type === 'linked') {
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
            return {
                compiled: null,
                reference: null,
                value: null,
            };
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
            if (parameterType.kind === ReflectionKind.rest) {
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

        let incomingVectorSpace: VectorSpace = 'PRESERVE';
        let vectorSpace: VectorSpace = 'PRESERVE';

        if (socket.type === 'linked') {
            // TODO handle multiple inputs?
            // TODO convert to variable name
            const inputNodeId = socket.links[0].node;
            const inputNode = tree[inputNodeId];
            let socketReference = getParameterReference(socket.links[0].socket);
            const inputSocketName = socket.links[0].socket;
            const inputSocket = inputNode.outputs[inputSocketName];

            if ('vector_space' in inputSocket || 'vector_space' in socket) {
                incomingVectorSpace =
                    'vector_space' in inputSocket
                        ? inputSocket.vector_space
                        : 'PRESERVE';
                vectorSpace =
                    'vector_space' in socket ? socket.vector_space : 'PRESERVE';

                console.log(
                    '[VECTOR_SPACE] L',
                    `${getReference(inputNodeId)}.${socketReference} ->`,
                    `${getReference(n)}.${parameterReflection.name}`,
                    {
                        incomingVectorSpace,
                        vectorSpace,
                        currentVectorSpace:
                            compilationCache.shader.currentVectorSpace,
                    }
                );
            }

            enterVectorSpace(incomingVectorSpace, compilationCache);

            // TODO standardize readers that don't need to be compiled?
            if (inputNode.name === 'entity' || inputNode.name === 'delta') {
                value = inputNode.name;
            } else if (
                inputNode.type === 'SIMULATION_INPUT' &&
                socketReference === 'DeltaTime'
            ) {
                value = 'delta';
            } else if (
                parameters.type !== 'LogicTree' &&
                inputNode.type === 'GROUP' &&
                inputNode.name === 'Time'
            ) {
                value = 'time';
                // TODO handle high-level re-use of uniforms
                compilationCache.uniforms.time = uniformTime;

                addContextualShaderInclude(
                    compilationCache,
                    'uniform float time;'
                );
            } else {
                reference = getReference(inputNodeId);
                value =
                    parameters.type !== 'LogicTree' &&
                    inputNode.type === 'GROUP_INPUT'
                        ? socketReference
                        : reference + '.' + socketReference;

                if (
                    inputNode.type === 'GROUP_INPUT' &&
                    inputSocket.type === 'VECTOR' &&
                    incomingVectorSpace === 'PRESERVE' &&
                    compilationCache.shader.currentVectorSpace !== 'UV' &&
                    compilationCache.shader.currentVectorSpace !== 'PRESERVE'
                ) {
                    value = `${value}.xzy`;
                }

                if (inputNode.type === 'SEPXYZ') {
                    const passthroughCompile = compileNodeSocket(
                        tree,
                        inputNode,
                        { type: typeOf<any>() },
                        inputNode.inputs['Vector'],
                        compilationCache,
                        'input'
                    );

                    socketReference = socketReference.toLowerCase();
                    const { currentVectorSpace } = compilationCache.shader;
                    if (
                        currentVectorSpace !== 'UV' &&
                        currentVectorSpace !== 'PRESERVE'
                    ) {
                        socketReference =
                            socketReference === 'y'
                                ? 'z'
                                : socketReference === 'z'
                                ? 'y'
                                : socketReference;
                    }
                    //  else {
                    //     if (socketReference === 'y') {
                    //         passthroughCompile.value =
                    //             '1.0 + ' + passthroughCompile.value;
                    //     }
                    // }
                    passthroughCompile.value += '.' + socketReference;

                    if (parameters.type === 'ShaderTree') {
                        passthroughCompile.value = convertVecSize(
                            passthroughCompile.value.toString(),
                            typeOf<GLSL['float']>(),
                            parameterType
                        );
                    }
                    return passthroughCompile;
                    // return {value: '', compiled: null, reference: null};
                }
                // TODO generalize passthrough nodes
                if (
                    inputNode.type === 'SIMULATION_INPUT' ||
                    inputNode.type === 'REROUTE'
                    // inputNode.type === 'SHADERTORGB'
                ) {
                    // TODO reroute does not properly convert vec size...
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
                    // console.log('input', reference, socketReference, inputType);
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
                                parameterType
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
                                    parameterType
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
                        // compilationCache.compiledInputs[reference] = compiled;
                        addCompiledInput(reference, compiled, compilationCache);
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
            parameterType.kind !== ReflectionKind.rest &&
            socket.type !== 'VECTOR' &&
            socket.type !== 'RGBA' &&
            // TODO make sure this is safe (hack to solve next TODO temporarily)
            socket.type !== 'VALUE' &&
            // TODO destructure if Array and see if matches
            ReflectionKind[parameterType.kind] !== typeof socket.value
        ) {
            if (socket.type === 'OBJECT' && typeof socket.value === 'string') {
                reference = getReference(socket.value + 'Entity');

                value = reference;

                compiled = `const ${reference} = em.getEntity("${socket.value}");\nif (!${reference}) return`;

                addCompiledInput(reference, compiled, compilationCache);
            } else {
                console.warn(
                    '[compileNodeSocket] unable to convert',
                    socket,
                    'to',
                    ReflectionKind[parameterType.kind]
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
                if ('vector_space' in socket) {
                    vectorSpace =
                        'vector_space' in socket
                            ? socket.vector_space
                            : 'PRESERVE';

                    // TODO for vec math (or similar) check if the other input is linked / has a vector_space of OBJECT and use it for incomingVectorSpace

                    console.log(
                        '[VECTOR_SPACE] ',
                        `${getReference(n)}.${parameterReflection.name}`,
                        {
                            incomingVectorSpace,
                            vectorSpace,
                            currentVectorSpace:
                                compilationCache.shader.currentVectorSpace,
                        }
                    );
                }
                if (parameters.type === 'LogicTree') {
                    value = `new Vector${
                        socket.type === 'VECTOR' ? '3' : '4'
                    }(${value.join(', ')})`;
                } else {
                    // TODO if input is less than 3/4 just create and directly input the correct vector rather than converting in glsl
                    // TODO leverage vectorSpace
                    let values = value as any as Array<number>;

                    const { currentVectorSpace } = compilationCache.shader;

                    if (
                        currentVectorSpace !== 'UV' &&
                        currentVectorSpace !== 'PRESERVE' &&
                        !n.internalNodeTree
                    ) {
                        values = [values[0], values[2], values[1]];
                    }

                    value = `vec3(${values
                        .slice(0, 3)
                        .map((v) => v.toFixed(4))
                        .join(', ')})`;
                    value = convertVecSize(
                        value,
                        typeOf<GLSL['vec3']>(),
                        parameterType
                    );
                }
                // TODO logicTree hold onto a static vector?
            } else {
                value = value.toString();
            }
        }
        // console.log('[compileNodeSocket]', n, p, ReflectionKind[p.type.kind]);

        if (
            parameterReflection &&
            parameterType.kind === ReflectionKind.array
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

        const staticNodeTranspilers =
            parameters.type === 'LogicTree'
                ? staticLogicNodeTranspilers
                : staticShaderNodeTranspilers;

        if (n.name in staticNodeTranspilers) {
            return staticNodeTranspilers[n.name](tree, n, compilationCache);
        }

        const method = methods[n.name] || transpilerMethods[n.name];

        let isMethodTranspiler =
            parameters.type === 'LogicTree'
                ? !parameters.reflection.types.find((t) => t.name === n.name)
                : true;
        let methodReflection: TypeMethod | TypePropertySignature = null;

        if (method) {
            methodReflection = (parameters.reflection.types.find(
                (t) => t.name === n.name
            ) ||
                transpilerReflection.types.find(
                    (t) => t.name === n.name
                )) as unknown as TypeMethod | TypePropertySignature;
        } else if (
            parameters.type !== 'LogicTree' &&
            (n.type === 'GROUP_OUTPUT' || n.type === 'GROUP')
        ) {
            methodReflection = dynamicNodeToType(n) as
                | TypeMethod
                | TypePropertySignature;
            isMethodTranspiler = true;
            // debugger;
        }

        if (
            !(method instanceof Function) &&
            methodReflection?.kind === ReflectionKind.propertySignature
        ) {
            return Object.values(method).flatMap((exactMethod: Function, i) => {
                const exactMethodReflection = methodReflection.type.types[i];
                exactMethodReflection.name += methodReflection.name;

                return compileUsingMethod(
                    exactMethod,
                    isMethodTranspiler,
                    exactMethodReflection
                );
            });
        } else {
            return compileUsingMethod(
                method,
                isMethodTranspiler,
                methodReflection
            );
        }

        function compileUsingMethod(
            method: Function,
            isMethodTranspiler: boolean,
            methodReflection: TypeMethod
        ) {
            function handleInternalTree() {
                if (n.internalNodeTree) {
                    const internalNodeTree =
                        parameters.currentInternalTrees?.[n.internalNodeTree];

                    if (!internalNodeTree) {
                        console.error(n);
                        throw Error(
                            'unable to locate internalNodeTree, likely an export issue.'
                        );
                    }
                    if (
                        parameters.compiledInternalTrees?.has(
                            n.internalNodeTree
                        )
                    ) {
                        console.warn(
                            'skipping recompile of internal tree',
                            n.internalNodeTree
                        );
                        return;
                    }
                    if (method) {
                        console.warn(
                            '[compileNode] internalNodeTree being ignored in favor of code implementation.',
                            n
                        );
                        return;
                    }
                    parameters.compiledInternalTrees.add(n.internalNodeTree);

                    // TODO implement prefix or nesting for cache stuff
                    const compiledInternalNodeTree = compileNodeTree(
                        internalNodeTree,
                        true,
                        compilationCache.compiledInputs.current,
                        compilationCache
                    );
                    // console.log(
                    //     '[compiledInternalNodeTree]',
                    //     n,
                    //     compiledInternalNodeTree
                    // );

                    compilationCache.defines = compilationCache.defines.union(
                        compiledInternalNodeTree.compilationCache.defines
                    );

                    const reference = getReference(n.id);

                    if (parameters.type !== 'LogicTree') {
                        console.log(
                            '[compiledInternalNodeTree] compilation cache',
                            n.name,
                            compiledInternalNodeTree.compilationCache
                        );
                        // TODO if return is a single type, bypass struct business

                        const { groupInput } =
                            compiledInternalNodeTree.compilationCache
                                .inputTypes;

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
                                        t.kind ===
                                        ReflectionKind.propertySignature
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

                        // TODO handle vertex and fragment shader of internal nodes better?
                        const structDefinition = `
                        ${structReference} ${functionReference}(${functionArguments}) {
                            ${compiledInternalNodeTree.vertexShader.replace(
                                '$structReference',
                                structReference
                            )}
                            ${compiledInternalNodeTree.fragmentShader.replace(
                                '$structReference',
                                structReference
                            )}
                        }`;
                        addContextualShaderFunctionStub(
                            compilationCache,
                            `${structReference} ${functionReference}(${functionArguments});`
                        );
                        addContextualShaderInclude(
                            compilationCache,
                            structDefinition
                        );

                        compilationCache.uniforms = {
                            ...compiledInternalNodeTree.compilationCache
                                .uniforms,
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

                        compilationCache.features =
                            compilationCache.features.union(
                                compiledInternalNodeTree.compilationCache
                                    .features
                            );
                    } else {
                        // compilationCache.compiledInputs = {
                        //     compiled:
                        //     ...compilationCache.compiledInputs,
                        //     ...compiledInternalNodeTree.compilationCache
                        //         .compiledInputs,
                        // };
                        // TODO instead of inlining, create and re-use a function like we do in shaders

                        compiledInternalNodeTree.compilationCache.compiledInputs.compiled.forEach(
                            (compiledInputs, index) => {
                                compilationCache.compiledInputs.compiled[
                                    index
                                ] = {
                                    ...compilationCache.compiledInputs.compiled[
                                        index
                                    ],
                                    ...compiledInputs,
                                };
                            }
                        );

                        addCompiledInput(
                            reference,
                            `const ${reference} = {${Object.keys(
                                n.inputs
                            ).reduce((o, k) => {
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
                                    compiledSocket.reference ||
                                    compiledSocket.value
                                }, `;

                                return o;
                            }, '')}}`,
                            compilationCache
                        );

                        return compiledInternalNodeTree.transpiled.map((s) =>
                            !s ? '' : s.replace(/groupInput/g, reference)
                        );
                    }
                }
            }

            let result = [];

            if (methodReflection) {
                const compiledParameters: any[] = [];

                const { defines, compiledInputs } = compilationCache;

                if (!isMethodTranspiler) defines.add(n.name);

                const vertexShaderTargetInfo = metaAnnotation.getForName(
                    methodReflection.return,
                    'VertexShader'
                );

                // console.log(
                //     n.name,
                //     'target type',
                //     vertexShaderTargetInfo
                //         ? `VertexShader<${vertexShaderTargetInfo[0].literal}>`
                //         : 'FragmentShader<default>'
                // );

                if (parameters.type === 'ShaderTree') {
                    if (vertexShaderTargetInfo) {
                        console.log('entering vertex context');
                        compilationCache.compiledInputs.current =
                            vertexShaderTargetInfo[0].literal === 'displacement'
                                ? shaderTargetInputs.Displacement
                                : shaderTargetInputs.Vertex;
                    } else {
                    }
                    console.groupCollapsed(
                        n.name +
                            ' ' +
                            shaderTargetInputs[
                                compilationCache.compiledInputs.current
                            ]
                    );
                }

                // console.log(
                //     n.name,
                //     methodReflection,
                //     methodReflection.getReturnType()
                // );

                // TODO implement handling of array inputs to a non array parameter

                result = ['$1'];

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

                    if (parameters.type === 'ShaderTree') {
                        console.log(p, { input, output, property });
                    }

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

                    if (isMethodTranspiler && p.name === 'linkedOutput') {
                        const firstLinkedOutput = Object.keys(n.outputs).find(
                            (o) => n.outputs[o].type === 'linked'
                        );

                        if (firstLinkedOutput) {
                            compiledParameters.push(firstLinkedOutput);
                        }
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

                        const parameterType = getConditionalType(
                            methodReflection,
                            p.type,
                            compiledParameters
                        );

                        if (parameterType.typeName === 'Node') {
                            if ('type' in input && input.type === 'linked') {
                                const inputNodeId = input.links[0].node;
                                const inputNode = tree[inputNodeId];
                                compiledParameters.push(inputNode);
                                return;
                            } else {
                                compiledParameters.push(undefined);
                                return;
                            }
                        }

                        // console.log('input', n.type, p.name, {
                        //     input,
                        //     p,
                        //     parameterType,
                        // });

                        const compiledInput = compileNodeSocket(
                            tree,
                            n,
                            p,
                            input,
                            compilationCache,
                            'input',
                            parameterType
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
                            compiledParameters.push(
                                compiledInput.internalValue
                            );
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
                            compiledParameters.push(
                                isMethodTranspiler ? undefined : 'undefined'
                            );
                        }
                    } else if (p.name === 'delta') {
                        compiledParameters.push('delta');
                    } else if (property !== undefined) {
                        if (isMethodTranspiler) {
                            // TODO genericize this concept
                            compiledParameters.push(property);

                            if (p.type.kind === ReflectionKind.enum) {
                                // console.log(p);
                            }
                        } else {
                            compiledParameters.push(
                                typeof property === 'string'
                                    ? `"${property}"`
                                    : property.toString()
                            );
                        }
                    } else {
                        compiledParameters.push(
                            isMethodTranspiler ? undefined : 'undefined'
                        );
                    }
                });

                if (parameters.type === 'ShaderTree') {
                    console.groupEnd();
                }

                const returnType = getReturnType(
                    methodReflection,
                    compiledParameters
                );
                compilationCache.inputTypes[getReference(n.id)] = returnType;

                if (isMethodTranspiler) {
                    if (method) result = method.apply({}, compiledParameters);

                    if (
                        parameters.type !== 'LogicTree' &&
                        n.type === 'GROUP' &&
                        !method
                    ) {
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
                        // console.log(
                        //     '[STRUCT REFERENCE]',
                        //     structReference,
                        //     returnType
                        // );
                        addContextualShaderInclude(
                            compilationCache,
                            glsl`
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
                    `
                        );

                        if ((n.type !== 'GROUP' || method) && result.length) {
                            result[result.length - 1] = `${structReference}(${
                                result[result.length - 1]
                            })`;
                        }
                    }

                    if (result.length) result[result.length - 1] += ';';
                    // console.log(
                    //     '[nodeTree.isMethodTranspiler]',
                    //     result,
                    //     compiledParameters
                    // );
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

                result = walk
                    ? getNext(tree, n).reduce(
                          (acc, next) => [
                              ...acc,
                              ...compileNode(tree, next, compilationCache),
                          ],
                          result
                      )
                    : result;

                if (vertexShaderTargetInfo) {
                    const target =
                        vertexShaderTargetInfo[0].literal || 'default';

                    let shaderDestination: string[] | null = null;

                    if (target === 'displacement') {
                        shaderDestination = compilationCache.shader.displace;
                    } else if (target === 'default') {
                        shaderDestination = compilationCache.shader.vertex;
                    }

                    if (shaderDestination) {
                        shaderDestination.push(result.join('\n'));
                        result = [];
                    } else {
                        console.warn(
                            '[compileNode] unsupported VertexShader target',
                            target,
                            'for',
                            n.name,
                            n.type
                        );
                    }

                    // naive attempt to return to relevant context
                    // TODO won't handled nested vertex shader targets
                    console.log('returning to fragment context');
                    compilationCache.compiledInputs.current =
                        shaderTargetInputs.Fragment;
                }
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
                if (
                    parameters.type !== 'LogicTree' &&
                    n.type === 'GROUP_INPUT'
                ) {
                    compilationCache.inputTypes[getReference(n)] =
                        getReturnType(dynamicNodeToType(n));
                }
                result = getNext(tree, n).reduce(
                    (acc, next) => [
                        ...acc,
                        ...compileNode(tree, next, compilationCache),
                    ],
                    []
                );
            }

            return result;
        }
    }

    function compileNodeTree(
        nodeTree: NodeTree,
        internal = false,
        currentTarget = parameters.type === 'LogicTree'
            ? 0
            : shaderTargetInputs.Fragment,
        parentCompilationCache?: CompilationCache
    ) {
        // Handle root-level stuff
        if (nodeTree.$internalTrees) {
            parameters.currentInternalTrees = nodeTree.$internalTrees;
            parameters.compiledInternalTrees = new Set();
        }

        const startingNodes = Object.values(nodeTree).filter((n) => {
            if (parameters.type === 'LogicTree') {
                return n.type === 'SIMULATION_INPUT';
            } else {
                return (
                    n.type === 'OUTPUT_MATERIAL' || n.type === 'GROUP_OUTPUT'
                );
            }
        });

        // console.log('[STARTING NODES]', startingNodes);

        let initFn: undefined | Function;

        if (parameters.type === 'LogicTree') {
            const initializationNodes = Object.values(nodeTree).filter(
                (n) => n.type === 'GROUP_INPUT'
            );

            const initCache: CompilationCache = {
                defines: new Set(),
                compiledInputs: {
                    current: currentTarget,
                    compiled: [{}],
                },
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
            compiledInputs: {
                current: currentTarget,
                compiled: [{}],
            },
            inputTypes: {
                groupInput: ReflectionClass.from<{ Geometry: Mesh }>().type,
            },
        };

        if (parameters.type === 'ShaderTree') {
            compilationCache.compiledInputs.compiled.push({}, {}); // TODO use length of shaderTargetInputs?
            delete compilationCache.inputTypes['groupInput'];
            compilationCache.inputTypes['vUv'] = typeOf<GLSL['vec2']>();
            compilationCache.shader = {
                currentVectorSpace:
                    parentCompilationCache?.shader.currentVectorSpace ||
                    'PRESERVE',

                vertex: [],
                displace: [],
                vertexIncludes: new Set(),
                vertexFunctionStubs: new Set(),
                fragmentIncludes: new Set(),
                fragmentFunctionStubs: new Set(),
                compositeTextures: {},

                onBeforeRender: new Set(),
                onMaterialApplied: new Set(),
            };
            if (parentCompilationCache) {
                compilationCache.shader.compositeTextures =
                    parentCompilationCache.shader.compositeTextures;
            }
            compilationCache.uniforms = {};
            compilationCache.features = new Set();
        }

        console.log(
            '[compileNodeTree] compiling',
            parameters.type,
            'starting context',
            shaderTargetInputs[compilationCache.compiledInputs.current]
        );

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
                vertexShader = Object.values(
                    compilationCache.compiledInputs.compiled[
                        shaderTargetInputs.Vertex
                    ]
                ).join('\n');
                fragmentShader = `${Object.values(
                    compilationCache.compiledInputs.compiled[
                        shaderTargetInputs.Fragment
                    ]
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

    return compileNodeTree;
}
