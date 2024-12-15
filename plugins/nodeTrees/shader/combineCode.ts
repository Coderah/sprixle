import { UniformsLib } from 'three';
import { glsl } from '../../../shader/util';
import { CompilationCache } from '../createCompiler';
import { diffuseBSDF } from './diffuseBSDF';

function makeF(compilationCache: CompilationCache) {
    return function f(feature: string, code: string) {
        if (compilationCache.features.has(feature)) {
            return code;
        }

        return '';
    };
}

export function combineVertexShader(
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

// TODO
#ifdef USE_TRANSMISSION

	varying vec3 vWorldPosition;

#endif

#include <common>
#include <batching_pars_vertex>

#include <uv_pars_vertex>
#include <displacementmap_pars_vertex>
// TODO vertex colors defines
#include <color_pars_vertex>
#include <fog_pars_vertex>
#include <normal_pars_vertex>
#include <morphtarget_pars_vertex>
#include <skinning_pars_vertex>
#include <shadowmap_pars_vertex>
#include <logdepthbuf_pars_vertex>
#include <clipping_planes_pars_vertex>

#ifdef USE_OBJECT_INFO

uniform vec3 objectLocation;

varying vec3 vObjectLocation;

#endif

${Array.from(compilationCache.shader.vertexIncludes).join('\n')}

void main() {

	#include <uv_vertex>
	#include <color_vertex>
	#include <morphinstance_vertex>
	#include <morphcolor_vertex>
	#include <batching_vertex>

	#include <beginnormal_vertex>
	#include <morphnormal_vertex>
	#include <skinbase_vertex>
	#include <skinnormal_vertex>
	#include <defaultnormal_vertex>
	#include <normal_vertex>

	#include <begin_vertex>
	#include <morphtarget_vertex>
	#include <skinning_vertex>
	#include <displacementmap_vertex>
	#include <project_vertex>
	#include <logdepthbuf_vertex>
	#include <clipping_planes_vertex>

	vViewPosition = - mvPosition.xyz;

    #ifdef USE_OBJECT_INFO
        vObjectLocation = objectLocation;
    
        #ifdef USE_INSTANCING
        
        vObjectLocation = vObjectLocation + (instanceMatrix * vec4(1.)).xyz;
        
        #endif

        vObjectLocation = (modelMatrix * vec4(vObjectLocation, 1.)).xyz;
    #endif

	#include <worldpos_vertex>
	#include <shadowmap_vertex>
	#include <fog_vertex>

    ${compilationCache.shader.vertex.join('\n')}

    // TODO
#ifdef USE_TRANSMISSION

	vWorldPosition = worldPosition.xyz;

#endif
}`;
}

export function combineFragmentShader(
    transpiled: string[],
    compilationCache: CompilationCache
) {
    const f = makeF(compilationCache);
    return glsl`
    #include <common>
    #include <packing>
    #include <dithering_pars_fragment>
    #include <color_pars_fragment>
    #include <uv_pars_fragment>
    // #include <map_pars_fragment>
    #include <alphamap_pars_fragment>
    #include <alphatest_pars_fragment>
    #include <alphahash_pars_fragment>
    // #include <aomap_pars_fragment>
    // #include <lightmap_pars_fragment>
    // #include <emissivemap_pars_fragment>

    #ifdef USE_OBJECT_INFO

    varying vec3 vObjectLocation;

    #endif

    // TODO
    // #include <envmap_common_pars_fragment>
    // #include <envmap_pars_fragment>

    #include <fog_pars_fragment>
    ${f('bsdf', '#include <bsdfs>')}
    #include <lights_pars_begin>
    #include <normal_pars_fragment>
    // TODO dedupe varying vec3 vViewPosition
    ${f('diffuseBSDF', '#include <lights_lambert_pars_fragment>')}
    #include <shadowmap_pars_fragment>
    #include <bumpmap_pars_fragment>
    // #include <normalmap_pars_fragment>
    // #include <specularmap_pars_fragment>
    #include <logdepthbuf_pars_fragment>
    #include <clipping_planes_pars_fragment>

    #ifdef USE_TRANSMISSION

	varying vec3 vWorldPosition;

    #endif
    uniform mat3 normalMatrix;

    ${Array.from(compilationCache.shader.fragmentIncludes)
        .sort((a, b) =>
            a.trimStart().startsWith('struct')
                ? -1
                : b.trimStart().startsWith('struct')
                ? 1
                : 0
        )
        .join('\n')}

    ${f('diffuseBSDF', diffuseBSDF)}

    void main() {
        // TODO
        // #include <clipping_planes_fragment>
        #include <logdepthbuf_fragment>
        ${Object.values(compilationCache.compiledInputs).join('\n')}
        ${transpiled.join('\n')}

        // #include <alphatest_fragment>
        // TODO
        if (gl_FragColor.a < .3) discard;
        
        // TODO
        // #include <envmap_fragment>
        // #include <opaque_fragment>
        // #include <tonemapping_fragment>
        #include <colorspace_fragment>
        // TODO
        #include <fog_fragment>
        // TODO
        #include <premultiplied_alpha_fragment>
        // TODO
        #include <dithering_fragment>
    }`;
}
