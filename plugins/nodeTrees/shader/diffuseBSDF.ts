import { glsl } from '../../../shader/util';
import { CompilationCache } from '../createCompiler';

export function addDiffuseBSDF(compilationCache: CompilationCache) {
    compilationCache.defines.add('USE_UV');
    // compilationCache.defines.add('RE_Direct');
    // compilationCache.defines.add('RE_IndirectDiffuse');
    // TODO
    // compilationCache.defines.add('TONE_MAPPING');
    compilationCache.defines.add('STANDARD');
    compilationCache.defines.add('USE_SPECULAR');
    compilationCache.defines.add('USE_ENVMAP');
    compilationCache.defines.add('USE_SHADOWMAP');
    // compilationCache.defines.add('ENVMAP_TYPE_CUBE_UV');
    // compilationCache.defines.add('IOR');
    compilationCache.features.add('diffuseBSDF');
    compilationCache.features.add('lights');
}

export const diffuseBSDF = glsl`
vec3 DiffuseBSDF(vec3 diffuse, vec3 normal, float roughness, float metalness, vec3 specularColor, float emissiveIntensity, vec3 emissiveColor) {

	#define STANDARD
	#define USE_SPECULAR

	#ifdef PHYSICAL
		#define IOR
		#define USE_SPECULAR
	#endif


	float specularIntensity = 1.0;

	#ifdef USE_CLEARCOAT
		uniform float clearcoat;
		uniform float clearcoatRoughness;
	#endif

	#ifdef USE_DISPERSION
		uniform float dispersion;
	#endif

	#ifdef USE_IRIDESCENCE
		uniform float iridescence;
		uniform float iridescenceIOR;
		uniform float iridescenceThicknessMinimum;
		uniform float iridescenceThicknessMaximum;
	#endif

	#ifdef USE_SHEEN
		uniform vec3 sheenColor;
		uniform float sheenRoughness;

		#ifdef USE_SHEEN_COLORMAP
			uniform sampler2D sheenColorMap;
		#endif

		#ifdef USE_SHEEN_ROUGHNESSMAP
			uniform sampler2D sheenRoughnessMap;
		#endif
	#endif

	#ifdef USE_ANISOTROPY
		uniform vec2 anisotropyVector;

		#ifdef USE_ANISOTROPYMAP
			uniform sampler2D anisotropyMap;
		#endif
	#endif

	vec3 totalEmissiveRadiance = emissiveColor * emissiveIntensity;
	vec4 diffuseColor = vec4( diffuse, 1. );
	
	ReflectedLight reflectedLight = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );

	
	
	
	// TODO handle flat shading
	// float faceDirection = gl_FrontFacing ? -1.0 : 1.0;
	// #ifdef DOUBLE_SIDED
	
	// 	normal *= faceDirection;
	
	// #endif
	// TODO remove unnecessary map support
	#include <roughnessmap_fragment>
	#include <metalnessmap_fragment>
	// #include <normal_fragment_begin>
	normal = normalize(normal);
	vec3 nonPerturbedNormal = normal;

	#include <normal_fragment_maps>
	#include <clearcoat_normal_fragment_begin>
	// #include <clearcoat_normal_fragment_maps>
	// #include <emissivemap_fragment>

	// accumulation
	#include <lights_physical_fragment>
	#include <lights_fragment_begin>
	#include <lights_fragment_maps>
	#include <lights_fragment_end>

	#include <aomap_fragment>

	vec3 totalDiffuse = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse;
	vec3 totalSpecular = reflectedLight.directSpecular + reflectedLight.indirectSpecular;

	#include <transmission_fragment>

	vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;

	#ifdef USE_SHEEN

		// Sheen energy compensation approximation calculation can be found at the end of
		// https://drive.google.com/file/d/1T0D1VSyR4AllqIJTQAraEIzjlb5h4FKH/view?usp=sharing
		float sheenEnergyComp = 1.0 - 0.157 * max3( material.sheenColor );

		outgoingLight = outgoingLight * sheenEnergyComp + sheenSpecularDirect + sheenSpecularIndirect;

	#endif

	#ifdef USE_CLEARCOAT

		float dotNVcc = saturate( dot( geometryClearcoatNormal, geometryViewDir ) );

		vec3 Fcc = F_Schlick( material.clearcoatF0, material.clearcoatF90, dotNVcc );

		outgoingLight = outgoingLight * ( 1.0 - material.clearcoat * Fcc ) + ( clearcoatSpecularDirect + clearcoatSpecularIndirect ) * material.clearcoat;

	#endif

	return outgoingLight;

}`;
