import { ReflectionClass } from '@deepkit/type';
import { Mesh, ShaderMaterial } from 'three';
import { GLTFLoader } from 'three-stdlib';
import { UnionOrIntersectionType } from 'typescript';
import {
    blenderEvents,
    enableNodeTreeBlenderConnection,
} from '../blender/realtime';
import {
    createNodeTreeCompiler,
    NodeTree,
} from '../plugins/nodeTrees/createCompiler';
import blenderShaders, {
    includesRegex,
} from '../plugins/nodeTrees/shader/blender';

const compileShaderTree = createNodeTreeCompiler({
    type: 'ShaderTree',
    methods: {},
    reflection: ReflectionClass.from<{}>()
        .type as unknown as UnionOrIntersectionType,
});

function compile(tree: NodeTree, name: string) {
    const compiledShaderTree = compileShaderTree(tree);

    console.log(compiledShaderTree);

    let fragmentLog = compiledShaderTree.fragmentShader;
    for (let shaderName in blenderShaders) {
        const replaceableShaderCode = blenderShaders[shaderName].replace(
            includesRegex,
            ''
        );
        fragmentLog = fragmentLog.replace(
            replaceableShaderCode,
            `#include <${shaderName}>`
        );
    }

    let vertexLog = compiledShaderTree.vertexShader;
    for (let shaderName in blenderShaders) {
        const replaceableShaderCode = blenderShaders[shaderName].replace(
            includesRegex,
            ''
        );
        vertexLog = vertexLog.replace(
            replaceableShaderCode,
            `#include <${shaderName}>`
        );
    }

    console.groupCollapsed('[transpiledShaderTree] logs');
    console.log(compiledShaderTree.compilationCache);
    console.log('vertex', vertexLog);
    console.log('fragment', fragmentLog);
    console.groupEnd();
}

new GLTFLoader().load('assets/vector-space.glb', (gltf) => {
    console.log(gltf.scene);
    gltf.scene.traverse((o) => {
        console.log(o);
    });
    enableNodeTreeBlenderConnection();
});

blenderEvents.addEventListener('shaderTree', (e) => {
    const { name, tree } = e.detail;
    const newMaterial = compile(tree, name);
});
