import { glsl } from '../../../shader/util';
import { CompilationCache } from '../createCompiler';

export function addDiffuseBSDF(compilationCache: CompilationCache) {
    compilationCache.defines.add('USE_UV');
    // compilationCache.defines.add('RE_Direct');
    // compilationCache.defines.add('RE_IndirectDiffuse');
    // TODO
    // compilationCache.defines.add('TONE_MAPPING');
    compilationCache.features.add('diffuseBSDF');
    compilationCache.features.add('lights');
}

export const diffuseBSDF = glsl`
vec3 DiffuseBSDF(vec3 diffuse, float roughness, vec3 normal) {
	float specularStrength = 0.;
	float totalEmissiveRadiance = 0.;
	
	vec4 diffuseColor = vec4( diffuse, 1. );
	
	ReflectedLight reflectedLight = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );
	
	// #include <logdepthbuf_fragment>
	// #include <map_fragment>
	// #include <color_fragment>
	
	// TODO handle flat shading
	// normal = normalize(normal);
	// float faceDirection = gl_FrontFacing ? -1.0 : 1.0;
	// #ifdef DOUBLE_SIDED

	// 	normal *= faceDirection;

	// #endif
	// return normal;
	// TODO tangentspace and such?
	// #include <normal_fragment_begin>
	// #include <normal_fragment_maps>
	// #include <emissivemap_fragment>

	// accumulation
	#include <lights_lambert_fragment>
	#include <lights_fragment_begin>
	// TODO for envmaps
	// #include <lights_fragment_maps>
	#include <lights_fragment_end>

	// TODO ?
	// #include <aomap_fragment>

	vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;

	return outgoingLight;

}`;
