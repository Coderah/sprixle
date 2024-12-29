import { CompilationCache } from '../../createCompiler';
import gpu_shader_common_color_utils from './gpu_shader_common_color_utils';
import gpu_shader_common_hash from './gpu_shader_common_hash';
import hue_sat_val from './hue_sat_val';
import noise from './noise';

const all = {
    gpu_shader_common_color_utils,
    gpu_shader_common_hash,
    hue_sat_val,
    noise,
};

export default all;

const includesRegex = /^\#include "(.*?)\.glsl"/gm;
export function addBlenderDependency(
    shader: string,
    compilationCache: CompilationCache
) {
    const includes = shader.matchAll(includesRegex);

    for (let include of includes) {
        const dependencyName = include[1];

        if (!(dependencyName in all)) continue;

        console.log(
            '[addBlenderDependency] included blender dependency',
            dependencyName
        );

        compilationCache.shader?.fragmentIncludes.add(all[dependencyName]);
    }

    compilationCache.shader?.fragmentIncludes.add(
        shader.replace(includesRegex, '')
    );
}
