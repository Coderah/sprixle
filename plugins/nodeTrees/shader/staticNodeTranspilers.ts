import { camelCase } from 'lodash';
import { CompilationCache, Node, NodeTree } from '../createCompiler';

const staticNodeTranspilers: {
    [key: string]: (
        tree: NodeTree,
        node: Node,
        compilationCache: CompilationCache
    ) => string[];
} = {
    INPUT_STRING(tree, node, compilationCache) {
        const reference = camelCase(node.id);
        compilationCache.compiledInputs[
            reference
        ] = `string ${reference} = "${node.properties.string}";`;

        return [];
    },

    VALUE(tree, node, compilationCache) {
        const reference = camelCase(node.id);
        compilationCache.compiledInputs[
            reference
        ] = `float ${reference} = ${node.properties.value.toFixed(4)};`;

        return [];
    },
    delta: () => [],
};

export default staticNodeTranspilers;
