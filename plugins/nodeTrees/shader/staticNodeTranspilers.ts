import { camelCase } from 'lodash';
import {
    addCompiledInput,
    CompilationCache,
    Node,
    NodeTree,
} from '../createCompiler';
import GLSL from './GLSL';
import { typeOf } from '@deepkit/type';

const staticNodeTranspilers: {
    [key: string]: (
        tree: NodeTree,
        node: Node,
        compilationCache: CompilationCache
    ) => string[];
} = {
    INPUT_STRING(tree, node, compilationCache) {
        const reference = camelCase(node.id);
        addCompiledInput(
            reference,
            `string ${reference} = "${node.properties.string}";`,
            compilationCache
        );

        return [];
    },

    VALUE(tree, node, compilationCache) {
        const reference = camelCase(node.id);
        addCompiledInput(
            reference,
            `float ${reference} = ${node.properties.value.toFixed(4)};`,
            compilationCache
        );

        return [];
    },

    RGB(tree, node, compilationCache) {
        const reference = camelCase(node.id);
        compilationCache.inputTypes[reference] = typeOf<GLSL['vec3']>();
        addCompiledInput(
            reference,
            `vec3 ${reference} = vec3(${node.properties.color.join(', ')});`,
            compilationCache
        );

        return [];
    },
    delta: () => [],
};

export default staticNodeTranspilers;
