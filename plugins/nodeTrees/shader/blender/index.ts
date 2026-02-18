import {
    addContextualShaderInclude,
    CompilationCache,
} from '../../createCompiler';
import prepBlenderGLSL from './prepBlenderGLSL';
import gpu_shader_common_color_utils from './gpu_shader_common_color_utils';
import gpu_shader_common_hash from './gpu_shader_common_hash';
import gpu_shader_common_mix_rgb from './gpu_shader_common_mix_rgb';
import gpu_shader_material_fresnel from './gpu_shader_material_fresnel';
import gpu_shader_material_layer_weight from './gpu_shader_material_layer_weight';
import gpu_shader_material_tex_white_noise from './gpu_shader_material_tex_white_noise';
import gpu_shader_compositor_texture_utilities from './gpu_shader_compositor_texture_utilities';
import gpu_shader_material_voronoi from './gpu_shader_material_voronoi';
import gpu_shader_material_fractal_voronoi from './gpu_shader_material_fractal_voronoi';
import gpu_shader_utildefines_lib from './gpu_shader_utildefines_lib';
import hue_sat_val from './hue_sat_val';
import noise from './noise';

const all = {
    gpu_shader_common_color_utils,
    gpu_shader_common_mix_rgb,
    gpu_shader_common_hash,
    gpu_shader_material_fresnel,
    gpu_shader_material_layer_weight,
    hue_sat_val,
    gpu_shader_material_tex_white_noise,
    gpu_shader_compositor_texture_utilities,
    gpu_shader_material_voronoi,
    gpu_shader_material_fractal_voronoi,
    gpu_shader_utildefines_lib,
    noise,
};

export default all;

export const includesRegex = /^\#include "(.*?)\.glsl"/gm;
export function addBlenderDependency(
    shader: string,
    compilationCache: CompilationCache
) {
    const includes = shader.matchAll(includesRegex);

    for (let include of includes) {
        const dependencyName = include[1];

        if (!(dependencyName in all) || all[dependencyName] === shader)
            continue;

        console.log(
            '[addBlenderDependency] included blender dependency',
            dependencyName
        );

        addBlenderDependency(all[dependencyName], compilationCache);
    }

    addContextualShaderInclude(
        compilationCache,
        prepBlenderGLSL(shader.replace(includesRegex, ''))
    );
}
