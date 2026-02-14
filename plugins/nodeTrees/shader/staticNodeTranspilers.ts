import { camelCase } from 'lodash';
import {
    addCompiledInput,
    CompilationCache,
    Node,
    NodeTree,
} from '../createCompiler';
import GLSL from './GLSL';
import { typeOf } from '@deepkit/type';
import { getReference } from '../util';

const staticNodeTranspilers: {
    [key: string]: (
        tree: NodeTree,
        node: Node,
        compilationCache: CompilationCache
    ) => string[];
} = {
    INPUT_STRING(tree, node, compilationCache) {
        const reference = getReference(node);
        addCompiledInput(
            reference,
            `string ${reference} = "${node.properties.string}";`,
            compilationCache
        );

        return [];
    },

    RGB(tree, node, compilationCache) {
        const reference = getReference(node);
        compilationCache.inputTypes[reference] = typeOf<GLSL['vec3']>();
        addCompiledInput(
            reference,
            `vec3 ${reference} = vec3(${node.properties.color
                .slice(0, 3)
                .join(', ')});`,
            compilationCache
        );

        return [];
    },
    delta: () => [],
};

export default staticNodeTranspilers;
