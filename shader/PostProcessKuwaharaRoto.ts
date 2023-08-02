import { Color, Texture, Vector2, Vector3 } from 'three';
import { uniformTime } from '../render/const';

import { simplifiedNoise } from './shaderIncludes';
import { glsl } from './util';

export const postProcessKuwaharaRoto = {
    uniforms: {
        cameraPosition: { value: new Vector3() },
        tDiffuse: { value: new Texture() },
        colorSlider: { value: 0.3 },
        resolution: {
            value: new Vector2(window.innerWidth, window.innerHeight),
        },
        time: uniformTime,
    },

    vertexShader: glsl`
        varying vec2 vUv;
		varying vec4 pos;

		void main() {

			vUv = uv;

			gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
            pos = vec4(position, 1.0);
		    // pos = modelMatrix * vec4( position, 1.0 );
            // worldPos = vec4( position, 1.0 );
            pos = projectionMatrix * pos;
            pos = modelMatrix * pos;
		}
        `,

    fragmentShader: glsl`
        varying vec2 vUv;
        varying vec4 pos;

        uniform vec2 resolution;
        uniform sampler2D tDiffuse;
        uniform float colorSlider;
        uniform float time;

        // #define A texture2D(tDiffuse, v.xy).r

        float map(float value, float min1, float max1, float min2, float max2) {
            return min2 + (value - min1) * (max2 - min2) / (max1 - min1);
        }

        vec4 photoshop_desaturate(vec3 color)
        {
            float bw = (min(color.r, min(color.g, color.b)) + max(color.r, max(color.g, color.b))) * 0.5;
            return vec4(bw, bw, bw, 1.0);
        }

        float step = 1.2;

        float intensity(in vec4 color){
            return sqrt((color.x*color.x)+(color.y*color.y)+(color.z*color.z));
        }

        vec3 sobel(float stepx, float stepy, vec2 center){
            // get samples around pixel
            float tleft = intensity(texture2D(tDiffuse,center + vec2(-stepx,stepy)));
            float left = intensity(texture2D(tDiffuse,center + vec2(-stepx,0)));
            float bleft = intensity(texture2D(tDiffuse,center + vec2(-stepx,-stepy)));
            float top = intensity(texture2D(tDiffuse,center + vec2(0,stepy)));
            float bottom = intensity(texture2D(tDiffuse,center + vec2(0,-stepy)));
            float tright = intensity(texture2D(tDiffuse,center + vec2(stepx,stepy)));
            float right = intensity(texture2D(tDiffuse,center + vec2(stepx,0)));
            float bright = intensity(texture2D(tDiffuse,center + vec2(stepx,-stepy)));
        
            // Sobel masks (see http://en.wikipedia.org/wiki/Sobel_operator)
            //        1 0 -1     -1 -2 -1
            //    X = 2 0 -2  Y = 0  0  0
            //        1 0 -1      1  2  1
            
            // You could also use Scharr operator:
            //        3 0 -3        3 10   3
            //    X = 10 0 -10  Y = 0  0   0
            //        3 0 -3        -3 -10 -3
        
            float x = tleft + 2.0*left + bleft - tright - 2.0*right - bright;
            float y = -tleft - 2.0*top - tright + bleft + 2.0 * bottom + bright;
            float color = sqrt((x*x) + (y*y));
            return vec3(color,color,color);
        }

        vec4 kuwahara(vec2 uv, vec2 resolution, int radius){
            float n = float((radius + 1) * (radius + 1));
            vec3 m[4];
            vec3 s[4];
            for (int k = 0; k < 4; ++k) {
                m[k] = vec3(0.0);
                s[k] = vec3(0.0);
            }
        
            for (int j = -radius; j <= 0; ++j)  {
                for (int i = -radius; i <= 0; ++i)  {
                    vec3 c = texture2D(tDiffuse, uv + vec2(i,j) / resolution).rgb;
                    m[0] += c;
                    s[0] += c * c;
                }
            }
        
            for (int j = -radius; j <= 0; ++j)  {
                for (int i = 0; i <= radius; ++i)  {
                    vec3 c = texture2D(tDiffuse, uv + vec2(i,j) / resolution).rgb;
                    m[1] += c;
                    s[1] += c * c;
                }
            }
        
            for (int j = 0; j <= radius; ++j)  {
                for (int i = 0; i <= radius; ++i)  {
                    vec3 c = texture2D(tDiffuse, uv + vec2(i,j) / resolution).rgb;
                    m[2] += c;
                    s[2] += c * c;
                }
            }
        
            for (int j = 0; j <= radius; ++j)  {
                for (int i = -radius; i <= 0; ++i)  {
                    vec3 c = texture2D(tDiffuse, uv + vec2(i,j) / resolution).rgb;
                    m[3] += c;
                    s[3] += c * c;
                }
            }
        
        
            float min_sigma2 = 1e+2;
            vec4 color = vec4(0.);
            for (int k = 0; k < 4; ++k) {
                m[k] /= n;
                s[k] = abs(s[k] / n - m[k] * m[k]);
        
                float sigma2 = s[k].r + s[k].g + s[k].b;
                if (sigma2 < min_sigma2) {
                    min_sigma2 = sigma2;
                    color = vec4(m[k], 1.0);
                }
            }
            return color;
        }

        void main() {
            vec4 originalColor = texture2D(tDiffuse, vUv);
            vec2 v = vec2(vUv);

            float A = photoshop_desaturate(texture2D(tDiffuse, v.xy).rgb).g;
            v.x += 0.0009;
            float A2 = photoshop_desaturate(texture2D(tDiffuse, v.xy).rgb).g;
            v.x -= 0.0009;
            v.y += 0.0009;
            float A3 = photoshop_desaturate(texture2D(tDiffuse, v.xy).rgb).g;

            float shaderSlider = sin(time/1000.0);
            vec4 rotoColor = vec4(0.0) + map(shaderSlider, -1.0, 1.0, 10.0,20.4)*(.09-length(A-vec2( A2,A3 )));
            
            rotoColor.w = 1.0;

            vec3 strokeColor = vec3(1., 1., 1.);
            vec3 colMask = sobel(step/resolution.x, step/resolution.y, vUv);
            vec3 stroke = strokeColor*colMask;
            
            gl_FragColor =  vec4(0.8,0.8,0.8, .4) * texture2D(tDiffuse, vUv);
            if (stroke.x < .6) { //if (rotoColor.r > .2) {
                gl_FragColor = kuwahara(vUv, resolution.xy, 5);
            }
       }
    `,
};
