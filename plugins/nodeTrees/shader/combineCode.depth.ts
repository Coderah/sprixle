import { UniformsLib } from 'three';
import { glsl } from '../../../shader/util';
import { CompilationCache, shaderTargetInputs } from '../createCompiler';
import { diffuseBSDF } from './diffuseBSDF';

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

export function combineDepthVertexShader(
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
    // TODO reverse engineer
    // #define STANDARD
    // #define LAMBERT

    varying vec3 vViewPosition;

    #include <common>

    #ifndef USE_POINTS
        #include <uv_pars_vertex>
        #include <batching_pars_vertex>
        #include <displacementmap_pars_vertex>
        #include <skinning_pars_vertex>
    #endif

    #ifdef USE_POINTS
        uniform float size;
        uniform float scale;
    #endif

    #include <morphtarget_pars_vertex>
    #include <logdepthbuf_pars_vertex>
    #include <clipping_planes_pars_vertex>

    #ifdef USE_OBJECT_INFO

    uniform vec3 objectLocation;

    varying vec3 vObjectLocation;

    #endif

    // This is used for computing an equivalent of gl_FragCoord.z that is as high precision as possible.
    // Some platforms compute gl_FragCoord at a lower precision which makes the manually computed value better for
    // depth-based postprocessing effects. Reproduced on iPad with A10 processor / iPadOS 13.3.1.
    varying vec2 vHighPrecisionZW;

    #ifdef USE_GEOMETRY

        varying vec3 vWorldPosition;
        varying vec3 vWorldNormal;

    #endif

    #ifdef USE_OBJECT_NORMAL

        varying vec3 vObjectNormal;

    #endif

    ${Array.from(compilationCache.shader.vertexFunctionStubs).join('\n')}

    ${Array.from(compilationCache.shader.vertexIncludes).join('\n')}

    void main() {

        #include <uv_vertex>

        #include <batching_vertex>
        #include <skinbase_vertex>

        #include <morphinstance_vertex>

        #ifdef USE_DISPLACEMENTMAP

            #include <beginnormal_vertex>
            #include <morphnormal_vertex>
            #include <skinnormal_vertex>

        #endif

        #include <begin_vertex>
        #include <morphtarget_vertex>
        #include <skinning_vertex>
        #include <displacementmap_vertex>

        ${Object.values(
            compilationCache.compiledInputs.compiled[
                shaderTargetInputs.Displacement
            ]
        ).join('\n')}
        ${compilationCache.shader.displace.join('\n')}

        #include <project_vertex>
        #include <logdepthbuf_vertex>
        #include <clipping_planes_vertex>

        vViewPosition = - mvPosition.xyz;

        #ifdef USE_OBJECT_INFO
            vObjectLocation = objectLocation;
        
            #ifdef USE_INSTANCING
            
            vObjectLocation = (instanceMatrix * vec4(vObjectLocation, 1.)).xyz;
            
            #endif

            #ifdef USE_POINTS
            vObjectLocation = position;
            #endif

            vObjectLocation = (modelMatrix * vec4(vObjectLocation, 1.)).xyz;


        #endif

        vHighPrecisionZW = gl_Position.zw;

        ${Object.values(
            compilationCache.compiledInputs.compiled[shaderTargetInputs.Vertex]
        ).join('\n')}

        ${compilationCache.shader.vertex.join('\n')}

    }`;
}

export function combineDepthFragmentShader(
    transpiled: string[],
    compilationCache: CompilationCache
) {
    const f = makeF(compilationCache);
    const nF = makeNF(compilationCache);
    return glsl`
    #if DEPTH_PACKING == 3200

    uniform float opacity;

    #endif

    #include <common>
    #include <packing>
    #include <uv_pars_fragment>
    #include <map_pars_fragment>
    #include <alphamap_pars_fragment>
    #include <alphatest_pars_fragment>
    #include <alphahash_pars_fragment>
    #include <logdepthbuf_pars_fragment>
    #include <clipping_planes_pars_fragment>

    #ifdef USE_OBJECT_INFO

    varying vec3 vObjectLocation;

    #endif

    varying vec2 vHighPrecisionZW;

    ${Array.from(compilationCache.shader.fragmentIncludes)
        .filter((a) => a.trimStart().startsWith('struct'))
        .join('\n')}

    ${Array.from(compilationCache.shader.fragmentFunctionStubs).join('\n')}

    ${Array.from(compilationCache.shader.fragmentIncludes)
        .filter((a) => !a.trimStart().startsWith('struct'))
        .join('\n')}

    void main() {

        vec4 diffuseColor = vec4( 1.0 );
        #include <clipping_planes_fragment>

        #if DEPTH_PACKING == 3200

            diffuseColor.a = opacity;

        #endif

        #include <map_fragment>
        #include <alphamap_fragment>
        #include <alphatest_fragment>
        #include <alphahash_fragment>

        #include <logdepthbuf_fragment>

        // Higher precision equivalent of gl_FragCoord.z. This assumes depthRange has been left to its default values.
        float fragCoordZ = 0.5 * vHighPrecisionZW[0] / vHighPrecisionZW[1] + 0.5;

        ${Object.values(
            compilationCache.compiledInputs.compiled[
                shaderTargetInputs.Fragment
            ]
        ).join('\n')}
        ${transpiled.join('\n')}

        // gl_FragColor = packDepthToRGBA( fragCoordZ );

        #if DEPTH_PACKING == 3200

            gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );

        #elif DEPTH_PACKING == 3201

            gl_FragColor = packDepthToRGBA( fragCoordZ );

        #elif DEPTH_PACKING == 3202

            gl_FragColor = vec4( packDepthToRGB( fragCoordZ ), 1.0 );

        #elif DEPTH_PACKING == 3203

            gl_FragColor = vec4( packDepthToRG( fragCoordZ ), 0.0, 1.0 );

        #endif

    }
    `;
}
