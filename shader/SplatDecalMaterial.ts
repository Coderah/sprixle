import {
    Color,
    NearestFilter,
    MeshBasicMaterial,
    MeshBasicMaterialParameters,
    Texture,
    Vector2,
} from 'three';
import { glsl } from './util';
import { STAGED_NORMAL_TARGET, STAGED_RENDER_TARGET } from '../render/const';

export type SplatDecalMaterialParameters = MeshBasicMaterialParameters & {
    sizeVariance?: number;
    spriteSize: Vector2;
    spriteStartIndex: number;
    spriteFrameCount: number;
    depthBias: number;
    time: { value: number };
    randomizeInsteadOfAnimate?: boolean;
};

export class SplatDecalMaterial extends MeshBasicMaterial {
    constructor(parameters: SplatDecalMaterialParameters) {
        super(parameters);
        parameters.map.minFilter = parameters.map.magFilter = NearestFilter;
        // this.size = parameters.size;
        // this.sizeAttenuation = false;
        this.alphaTest = 0.1;
        this.transparent = true;
        this.color = parameters.color;
        this.userData.spriteSheetSize = new Vector2(
            parameters.map.image.width,
            parameters.map.image.height
        );
        this.userData.spriteSize = new Vector2(32, 32);
        this.userData.spriteIndex = parameters.spriteStartIndex;
        this.polygonOffset = true;
        this.polygonOffsetFactor = -0.1;


        this.onBeforeCompile = (shader) => {
            // console.log(shader.vertexShader);
            // console.log(shader.fragmentShader);
            shader.uniforms.color = { value: this.color };
            shader.uniforms.u_time = parameters.time;
            shader.uniforms.sizeVariance = { value: parameters.sizeVariance || 25 };
            shader.uniforms.spriteSheetSize = {
                value: this.userData.spriteSheetSize,
            };
            shader.uniforms.spriteSize = {
                value: this.userData.spriteSize,
            };
            shader.uniforms.spriteIndex = { value: this.userData.spriteIndex };
            shader.uniforms.spriteFrameCount = { value: parameters.spriteFrameCount };
            shader.uniforms.depthBias = { value: parameters.depthBias };
            shader.uniforms.renderTexture = {
                value: STAGED_RENDER_TARGET.texture,
            };
            shader.uniforms.tDepth = {
                value: STAGED_RENDER_TARGET.depthTexture,
            };
            // shader.uniforms.tNormal = {
            //     value: STAGED_NORMAL_TARGET.texture,
            // };
            shader.uniforms.randomizeInsteadOfAnimate = {
                value: parameters.randomizeInsteadOfAnimate || false,
            }
            shader.vertexShader =
                glsl`
                #include <common>
                #include <uv_pars_vertex>
                #include <uv2_pars_vertex>
                #include <envmap_pars_vertex>
                #include <color_pars_vertex>
                #include <fog_pars_vertex>
                #include <morphtarget_pars_vertex>
                #include <skinning_pars_vertex>
                #include <logdepthbuf_pars_vertex>
                #include <clipping_planes_pars_vertex>

                varying vec4 pos;
                varying vec3 worldPos;
                varying float depth;
                attribute vec3 iPosition;
                varying vec2 instanceId;

                uniform float sizeVariance;

                float loop_mod(float a, float b) {
                    float cycle = 2.0 * (b - 1.0);
                    float a_mod = mod(a, cycle);
                    if (a_mod >= b) {
                        return(cycle - a_mod);
                    }
                    return(a_mod);
                }

                float randTest(vec2 co){
                    return fract(sin(dot(co.xy ,vec2(12.9898,78.233))) * 43758.5453);
                }

                void main() {
                    #include <uv_vertex>
                    #include <uv2_vertex>
                    #include <color_vertex>
                    #include <skinbase_vertex>
                    #ifdef USE_ENVMAP
                    #include <beginnormal_vertex>
                    #include <morphnormal_vertex>
                    #include <skinnormal_vertex>
                    #include <defaultnormal_vertex>
                    #endif
                    #include <begin_vertex>
                    #include <morphtarget_vertex>
                    #include <skinning_vertex>
                    #include <project_vertex>
                    #include <logdepthbuf_vertex>
                    #include <worldpos_vertex>
                    #include <clipping_planes_vertex>
                    #include <envmap_vertex>
                    #include <fog_vertex>

                    vec3 ndc = vec3(gl_Position.z) / gl_Position.w;
        
                    instanceId = iPosition.xy;
                    depth = ndc.y * 0.5 + 0.5;  
                    // if (sizeVariance > 0.0) {
                    //     gl_PointSize = size - (sizeVariance * 0.3) + floor(randTest(transformed.xz) * sizeVariance);
                    // }
                    pos = vec4(iPosition, 1.0);
                    // pos = instanceMatrix * pos;
                    pos = modelViewMatrix * pos;
                    pos = projectionMatrix * pos;
                    worldPos = transformed;
                }
            `;
            shader.fragmentShader = glsl`
                uniform vec3 diffuse;
                uniform float opacity;
                #ifndef FLAT_SHADED
                    varying vec3 vNormal;
                #endif
                #include <common>
                #include <dithering_pars_fragment>
                #include <color_pars_fragment>
                #include <uv_pars_fragment>
                #include <uv2_pars_fragment>
                #include <map_pars_fragment>
                #include <alphamap_pars_fragment>
                #include <aomap_pars_fragment>
                #include <lightmap_pars_fragment>
                #include <envmap_common_pars_fragment>
                #include <envmap_pars_fragment>
                #include <cube_uv_reflection_fragment>
                #include <fog_pars_fragment>
                #include <specularmap_pars_fragment>
                #include <logdepthbuf_pars_fragment>
                #include <clipping_planes_pars_fragment>

                // varying mat2 rotation;
                varying vec4 pos;
                varying vec3 worldPos;
        
                // attribute float instanceIndex;

                varying float depth;
                varying vec2 instanceId;
        
                uniform float depthBias;
                uniform vec3 color;
                uniform float u_time;
                uniform sampler2D tDepth;
                // uniform sampler2D tNormal;
                uniform sampler2D renderTexture;
                uniform vec2 spriteSheetSize;   // In px
                uniform vec2 spriteSize;        // In px
                uniform float spriteIndex;            // Sprite spriteIndex in sprite sheet (0-...)
                uniform float spriteFrameCount;
                uniform bool randomizeInsteadOfAnimate;

                float loop_mod(float a, float b) {
                    float cycle = 2.0 * (b - 1.0);
                    float a_mod = mod(a, cycle);
                    if (a_mod >= b) {
                        return(cycle - a_mod);
                    }
                    return(a_mod);
                }

                float randTest(vec2 co){
                    return fract(sin(dot(co.xy ,vec2(12.9898,78.233))) * 43758.5453);
                }

                float randTest(float co){
                    return fract(sin(dot(co ,12.9898)) * 43758.5453);
                }

                float colorDist(vec3 c1, vec3 c2) {
                    return sqrt((c2.r-c1.r) + (c2.g-c1.g) + (c2.b-c1.b));
                }

                void main() {
                    #include <clipping_planes_fragment>
                    vec4 diffuseColor = vec4( diffuse, opacity );
                    #include <logdepthbuf_fragment>
                    #include <map_fragment>
                    // #include <color_fragment>
                    #include <alphamap_fragment>
                    #include <alphatest_fragment>
                    // #include <specularmap_fragment>
                    // ReflectedLight reflectedLight = ReflectedLight( vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ), vec3( 0.0 ) );
                    // #ifdef USE_LIGHTMAP
                    
                    //     vec4 lightMapTexel= texture2D( lightMap, vUv2 );
                    //     reflectedLight.indirectDiffuse += lightMapTexelToLinear( lightMapTexel ).rgb * lightMapIntensity;
                    // #else
                    //     reflectedLight.indirectDiffuse += vec3( 1.0 );
                    // #endif
                    // #include <aomap_fragment>

                    vec4 renderColor = texture2D(renderTexture, pos.xy * .5 + .5);

                    vec3 outgoingLight = diffuseColor.rgb;

                    float positionDepth = depth;
                    float depthFromMap = texture2D(tDepth, pos.xy * .5 + .5).x;
                    // outgoingLight = vec3(positionDepth - depthFromMap);
                    if (diffuseColor.a > 0.0 && positionDepth - depthFromMap < depthBias) {
                        outgoingLight += renderColor.rgb;// * texture2D(tDepth, pos.xy * .5 + .5).x;
                        
                        if (renderColor.g + renderColor.r + renderColor.b < 0.3) {
                            // outgoingLight = color.rgb * vec3(randTest(instanceId) * 0.15);
                        } else {
                            if (distance(renderColor.rgb, color) > 0.25) {
                                outgoingLight = vec3(0.0);
                                discard;
                            }
                        }

                        gl_FragColor = vec4( outgoingLight, diffuseColor.a );
                    } else {
                        // gl_FragColor = vec4(0.0);
                        outgoingLight = vec3(0.0);
                        discard;
                        // gl_FragColor = vec4(color, 0.0);
                    }
                    
                    
                    // #include <envmap_fragment>
                    // #include <tonemapping_fragment>
                    // #include <encodings_fragment>
                    // #include <fog_fragment>
                    // #include <premultiplied_alpha_fragment>
                    // #include <dithering_fragment>
                }
            `;
        };

        return this;
    }
}
