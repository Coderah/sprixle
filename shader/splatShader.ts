import { Color, Texture, Vector2 } from "three";
import { glsl } from "./util";

export const splatShader = {
    map: null as Texture,

    defines: {

        "STANDARD": '',
        "USE_UV": '',
        "USE_MAP": ''

    },

    uniforms: {
        size: { value: 1 },
        scale: { value: window.innerHeight * 0.5 },
        sizeAttenuation: { value: false },
        map: { value: null as Texture },

        color: { value: new Color()},
        time: { value: 0 },
        spriteSheetSize: { value: new Vector2(32, 32) },
        spriteSize: { value: new Vector2(32, 32) },
        index: { value: 0.0 },
        tColor: { value: null as Texture },
        tDepth: { value: null as Texture },

        'tDiffuse': { value: null as Texture },
    },

    vertexShader: glsl`
    #define USE_MAP
        varying vec4 pos;
        varying vec3 worldPos;

        varying float depth;

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

        uniform float size;
        uniform float scale;
        #include <common>
        #include <color_pars_vertex>
        #include <fog_pars_vertex>
        #include <morphtarget_pars_vertex>
        #include <logdepthbuf_pars_vertex>
        #include <clipping_planes_pars_vertex>

        void main() {
            #include <color_vertex>
            #include <begin_vertex>
            #include <morphtarget_vertex>
            #include <project_vertex>
            #ifdef USE_SIZEATTENUATION
                bool isPerspective = isPerspectiveMatrix( projectionMatrix );
                if ( isPerspective ) gl_PointSize *= ( scale / - mvPosition.z );
            #endif
            #include <logdepthbuf_vertex>
            #include <clipping_planes_vertex>
            #include <worldpos_vertex>
            #include <fog_vertex>
            vec3 ndc = vec3(gl_Position.z) / gl_Position.w;

            depth = ndc.y * 0.5 + 0.5;  
            gl_PointSize = size - 10.0 + floor(randTest(transformed.xz) * 25.0);
            pos = gl_Position;
            worldPos = transformed;
        }
    `,

    fragmentShader: glsl`
        #include <common>
        #include <packing>

        varying vec4 pos;
        varying vec3 worldPos;

        varying float depth;

        uniform vec3 color;
        uniform float u_time;
        uniform vec3 diffuse;
        uniform float opacity;
        uniform sampler2D tDepth;
        uniform sampler2D tColor;
        uniform sampler2D map;
        uniform vec2 spriteSheetSize;   // In px
        uniform vec2 spriteSize;        // In px
        uniform float index;            // Sprite index in sprite sheet (0-...)

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

            float true_index = index + loop_mod(floor(randTest(worldPos.xz) * 20.0 + u_time * 5.0), 3.0);
            float col = mod(true_index, cols);
            float row = floor(true_index / cols);
            vec2 uv = vec2(dx * gl_PointCoord.x + col * dx, 1.0 - dy - row * dy + dy * (1.0 - gl_PointCoord.y));

            vec4 diffuseColor = vec4(diffuse, opacity);
            vec4 mapTexel = texture2D(map, uv);
            diffuseColor *= mapTexelToLinear( mapTexel );
            vec4 renderColor = texture2D(tColor, pos.xy * .5 + .5);
            
            #include <alphatest_fragment>

            float positionDepth = depth;
            float depthFromMap = texture2D(tDepth, pos.xy * .5 + .5).x;
            // gl_FragColor = vec4(0.0);
            // if (positionDepth - depthFromMap < 0.0004) {
                outgoingLight = renderColor.rgb;// * texture2D(tDepth, pos.xy * .5 + .5).x;
                if (randTest(worldPos.xz) > 0.5) {
                    if (renderColor.g + renderColor.r + renderColor.b < 0.3) {
                        outgoingLight = color.rgb * vec3((randTest(worldPos.xz) * 0.25));
                    } else {
                        outgoingLight *= vec3(0.6 + (randTest(worldPos.xz) * 0.65) ); 
                    }   
                }
                if (outgoingLight.r + outgoingLight.g + outgoingLight.b > 0.4) {
                    gl_FragColor = vec4( outgoingLight, diffuseColor.a );
                }
            // } else {
                // gl_FragColor = vec4(0.0);
                // gl_FragColor = vec4(color, diffuseColor.a);
            // }
        }
    `,
}