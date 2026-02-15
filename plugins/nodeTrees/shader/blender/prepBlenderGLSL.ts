type Replacement = [pattern: RegExp, replacement: string];

/**
 * Each entry: [regex, replacement string].
 * Add new conversions here as they come up.
 */
const replacements: Replacement[] = [
    // --- Strip directives ---
    [/#pragma once/g, ''],
    [/#include "gpu_shader_compat\.hh"/g, ''],

    // --- Strip Metal backend guards ---
    [/GPU_METAL_FRAGMENT_SHADER_BEGIN.*$/gm, ''],
    [/GPU_METAL_FRAGMENT_SHADER_END.*$/gm, ''],

    // --- Float literal 'f' suffix (not valid in GLSL ES 300) ---
    [/(\d+\.\d*)f\b/g, '$1'],

    // --- Blender type aliases → GLSL ES 300 native types ---
    [/\bfloat2\b/g, 'vec2'],
    [/\bfloat3\b/g, 'vec3'],
    [/\bfloat4\b/g, 'vec4'],
    [/\bint2\b/g, 'ivec2'],
    [/\bint3\b/g, 'ivec3'],
    [/\bint4\b/g, 'ivec4'],
    [/\buint2\b/g, 'uvec2'],
    [/\buint3\b/g, 'uvec3'],
    [/\buint4\b/g, 'uvec4'],
    [/\bbool2\b/g, 'bvec2'],
    [/\bbool3\b/g, 'bvec3'],
    [/\bbool4\b/g, 'bvec4'],
];

export default function prepBlenderGLSL(source: string): string {
    for (const [pattern, replacement] of replacements) {
        source = source.replace(pattern, replacement);
    }
    return source;
}
