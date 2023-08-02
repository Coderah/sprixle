import {
    Color,
    NearestFilter,
    PointsMaterial,
    PointsMaterialParameters,
    Texture,
    Vector2,
} from 'three';
import { lightTextureUniform } from '../components/effects';
import { STAGED_NORMAL_TARGET, STAGED_RENDER_TARGET } from '../render/const';
import { glsl } from './util';

export type SplatMaterialParameters = PointsMaterialParameters & {
    sizeVariance?: number;
    spriteSize: Vector2;
    spriteStartIndex: number;
    spriteFrameCount: number;
    depthBias: number;
    time: { value: number };
    randomizeInsteadOfAnimate?: boolean;
};

export class SplatMaterial extends PointsMaterial {
    constructor(parameters: SplatMaterialParameters) {
        super(parameters);
        parameters.map.minFilter = parameters.map.magFilter = NearestFilter;
        this.alphaTest = 0.1;
        this.transparent = true;
        this.size = parameters.size;
        this.sizeAttenuation = false;
        this.color = new Color(0x39571c);
        this.userData.spriteSheetSize = new Vector2(
            parameters.map.image.width,
            parameters.map.image.height
        );
        this.userData.spriteSize = new Vector2(32, 32);
        this.userData.spriteIndex = parameters.spriteStartIndex;

        this.onBeforeCompile = (shader) => {
            shader.uniforms.color = { value: this.color };
            shader.uniforms.u_time = parameters.time;
            shader.uniforms.sizeVariance = {
                value: parameters.sizeVariance || 25,
            };
            shader.uniforms.spriteSheetSize = {
                value: this.userData.spriteSheetSize,
            };
            shader.uniforms.spriteSize = {
                value: this.userData.spriteSize,
            };
            shader.uniforms.spriteIndex = { value: this.userData.spriteIndex };
            shader.uniforms.spriteFrameCount = {
                value: parameters.spriteFrameCount,
            };
            shader.uniforms.depthBias = { value: parameters.depthBias };
            shader.uniforms.renderTexture = lightTextureUniform;
            shader.uniforms.tDepth = {
                value: STAGED_RENDER_TARGET.depthTexture,
            };
            // shader.uniforms.tNormal = {
            //     value: STAGED_NORMAL_TARGET.texture,
            // };
            shader.uniforms.randomizeInsteadOfAnimate = {
                value: parameters.randomizeInsteadOfAnimate || false,
            };
            shader.vertexShader = glsl`
                    varying vec4 pos;
                    varying vec3 worldPos;
                    varying float depth;
                    // varying mat2 rotation;
                    uniform float sizeVariance;

                    // uniform sampler2D tNormal;
    
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
        
                    ${shader.vertexShader}`;

            shader.vertexShader =
                shader.vertexShader.substring(
                    0,
                    shader.vertexShader.length - 2
                ) +
                glsl`
                    vec3 ndc = vec3(gl_Position.z) / gl_Position.w;
        
                    depth = ndc.y * 0.5 + 0.5;  
                    if (sizeVariance > 0.0) {
                        gl_PointSize = size - (sizeVariance * 0.3) + floor(randTest(transformed.xz) * sizeVariance);
                    }
                    pos = gl_Position;
                    worldPos = transformed;
                    // vec4 normalCoord = texture2D(tNormal, pos.xy * .5 + .5);
                    // rotation = mat2(cos(normal.x), sin(normal.z),
                    //         -sin(normal.z), cos(normal.x)); 
                }`;
            shader.fragmentShader = glsl`
                #include <common>
                #include <packing>

                // varying mat2 rotation;
                varying vec4 pos;
                varying vec3 worldPos;
        
                varying float depth;
        
                uniform float depthBias;
                uniform vec3 color;
                uniform float u_time;
                uniform vec3 diffuse;
                uniform float opacity;
                uniform sampler2D tDepth;
                // uniform sampler2D tNormal;
                uniform sampler2D renderTexture;
                uniform sampler2D map;
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

                float colorDist(vec3 c1, vec3 c2) {
                    return sqrt((c2.r-c1.r) + (c2.g-c1.g) + (c2.b-c1.b));
                }

                void main () {
                    vec3 outgoingLight = vec3( 0.0 );
                    float w = spriteSheetSize.x;
                    float h = spriteSheetSize.y;
                    float dx = spriteSize.x / w;
                    float dy = spriteSize.y / h;
                    float cols = w / spriteSize.x;

                    float true_index = spriteIndex;
                    if (!randomizeInsteadOfAnimate) {
                        true_index += loop_mod(floor(randTest(worldPos.xz) * 20.0 + u_time * (spriteFrameCount + 1.0)), spriteFrameCount);
                    } else {
                        true_index += loop_mod(floor(randTest(worldPos.xz) * 20.0), spriteFrameCount);
                    }
                    float col = mod(true_index, cols);
                    float row = floor(true_index / cols);

                    // vec2 center = vec2(0.5, 0.5);
                    // vec2 rotationCoord = rotation * (gl_PointCoord - center) + center;

                    vec2 uv = vec2(dx * gl_PointCoord.x + col * dx, 1.0 - dy - row * dy + dy * (1.0 - gl_PointCoord.y));
                    // uv = rotation * (uv - center) + center;

                    // vec4 diffuseColor = vec4(diffuse, opacity);
                    vec4 mapTexel = texture2D(map, uv);
                    vec4 diffuseColor = mapTexelToLinear( mapTexel );
                    vec4 renderColor = texture2D(renderTexture, pos.xy * .5 + .5);
                    
                    #include <alphatest_fragment>

                    float positionDepth = depth;
                    float depthFromMap = texture2D(tDepth, pos.xy * .5 + .5).x;
                    // outgoingLight = vec3(positionDepth - depthFromMap);
                    // if (positionDepth - depthFromMap > 0.05) {
                        // outgoingLight = vec3(1);
                        // gl_FragColor = vec4(outgoingLight, diffuseColor.a );
                    // }
                    if (positionDepth - depthFromMap < depthBias) {
                        outgoingLight = renderColor.rgb;// * texture2D(tDepth, pos.xy * .5 + .5).x;

                        if (renderColor.g + renderColor.r + renderColor.b < 0.3) {
                            
                            // outgoingLight = color.rgb * vec3((randTest(worldPos.xz) * 0.25));
                        } else {
                            if (distance(outgoingLight, color) > 0.7) {
                                // discard;
                            } else if (randTest(worldPos.xz) > 0.95) {
                                // outgoingLight *= vec3(randTest(worldPos.xz) * 0.75 );
                            }
                        }

                        // if (randTest(worldPos.xz) > 0.5) {
                        //     if (renderColor.g + renderColor.r + renderColor.b < 0.3) {
                        //         outgoingLight = color.rgb * vec3((randTest(worldPos.xz) * 0.25));
                        //     } else {
                        //         outgoingLight *= vec3(0.4 + (randTest(worldPos.xz) * 0.75) ); 
                        //     }
                        // }
                        gl_FragColor = vec4( outgoingLight, diffuseColor.a );
                    } else {
                        // gl_FragColor = vec4(0.0);
                        // discard;
                        gl_FragColor = vec4(color, 1.0);
                    }
                }
            `;
        };

        return this;
    }
}
