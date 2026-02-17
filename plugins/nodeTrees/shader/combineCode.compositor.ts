import { UniformsLib } from 'three';
import { glsl } from '../../../shader/util';
import { CompilationCache, shaderTargetInputs } from '../createCompiler';
import { DEFAULT_PASS_TARGETS } from './blender/viewLayer';

function makeF(compilationCache: CompilationCache) {
    return function f(feature: string, code: string) {
        if (compilationCache.features.has(feature)) {
            return code;
        }

        return '';
    };
}
function makeNF(compilationCache: CompilationCache) {
    return function f(feature: string, code: string) {
        if (!compilationCache.features.has(feature)) {
            return code;
        }

        return '';
    };
}

export function combineCompositorVertexShader(
    transpiled: string[],
    compilationCache: CompilationCache
) {
    const f = makeF(compilationCache);

    if (compilationCache.features.has('lights')) {
        compilationCache.uniforms = {
            ...compilationCache.uniforms,
            ...UniformsLib.lights,
        };
    }

    return glsl`
    varying vec2 vUv; 

    ${Array.from(compilationCache.shader.vertexFunctionStubs).join('\n')}

    ${Array.from(compilationCache.shader.vertexIncludes).join('\n')}

    void main(){
    
        vUv = uv;

        gl_Position = vec4(position, 1.0);

        ${Object.values(
            compilationCache.compiledInputs.compiled[shaderTargetInputs.Vertex]
        ).join('\n')}

        ${compilationCache.shader.vertex.join('\n')}

    }`;
}

export function combineCompositorFragmentShader(
    transpiled: string[],
    compilationCache: CompilationCache
) {
    const validTargets = (
        compilationCache.shader?.rPassTargets || DEFAULT_PASS_TARGETS
    ).filter((t) => t.internalShaderLogic !== 'Depth');

    return glsl`
        layout(location = 0) out vec4 ${validTargets[0].name};
        ${validTargets.map((t) => `uniform sampler2D u${t.name};`).join('\n')}
        uniform float opacity;
        
        varying vec2 vUv;  

        ${Array.from(compilationCache.shader.fragmentIncludes)
            .filter((a) => a.trimStart().startsWith('struct'))
            .join('\n')}

        ${Array.from(compilationCache.shader.fragmentFunctionStubs).join('\n')}

        ${Array.from(compilationCache.shader.fragmentIncludes)
            .filter((a) => !a.trimStart().startsWith('struct'))
            .join('\n')}

        void main() {

            ${Object.values(
                compilationCache.compiledInputs.compiled[
                    shaderTargetInputs.Fragment
                ]
            ).join('\n')}
            ${transpiled.join('\n')}

        }
    `;
}
