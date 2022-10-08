import { Color, Texture, Vector2, Vector3 } from 'three';
import { uniformTime } from '../render/const';

import { simplifiedNoise } from './shaderIncludes';
import { glsl } from './util';

export const postProcessRotoscope = {

	uniforms: {
		cameraPosition: { value: new Vector3()},
        tDiffuse: { value: new Texture() },
        colorSlider: { value: 1.0 },
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

        void main() {
            vec4 originalColor = texture2D(tDiffuse, vUv);
            // if (originalColor.rgb == vec3(0.0)) {
            //     gl_FragColor = originalColor;
            //     return;
            // }
            vec2 v = vec2(vUv);

            float A = photoshop_desaturate(texture2D(tDiffuse, v.xy).rgb).g;
            v.x += 0.0009;
            float A2 = photoshop_desaturate(texture2D(tDiffuse, v.xy).rgb).g;
            v.x -= 0.0009;
            v.y += 0.0009;
            float A3 = photoshop_desaturate(texture2D(tDiffuse, v.xy).rgb).g;

            float shaderSlider = colorSlider;//sin(time/1000.0);
            vec4 rotoColor = vec4(0.0) + map(shaderSlider, -1.0, 1.0, 10.0,20.4)*(.05-length(A-vec2( A2,A3 )));
            
            rotoColor.w = 1.0;
            
            gl_FragColor = rotoColor;
            if (rotoColor.r > 0.2) {
                gl_FragColor = mix(originalColor, rotoColor, map(shaderSlider, -1.0, 1.0, 0.3, .6));
            } else if (shaderSlider < 0.0) {
                // gl_FragColor *= -1.0;
            }
       }
    `

};