import { Color, Texture, Vector2, Vector3 } from 'three';

import { simplifiedNoise } from './shaderIncludes';
import { glsl } from './util';

export const postProcessCelShader = {
    uniforms: {
        cameraPosition: { value: new Vector3() },
        tDiffuse: { value: new Texture() },
        cels: {
            value: [
                // threshold, tint
                new Vector2(1, 0.95), // white
                new Vector2(0.8, 0.9), // highlight
                new Vector2(0.75, 0.85), // neutral
                new Vector2(0.4, 0.765), // shadow
                new Vector2(0.2, 0.74), // deep shadow
                new Vector2(0.06, 0.72), // deeper shadow
                new Vector2(0.03, 0.7), // deepest shadow
                new Vector2(0.01, 0), // black
            ],
        },
    },

    vertexShader: glsl`
        varying vec2 vUv;
		varying vec4 pos;
        // varying vec4 worldPos;

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
        uniform vec2[8] cels;
        // uniform vec4 worldPos;

        uniform sampler2D tDiffuse;

        // Generic algorithm to desaturate images used in most game engines
        vec4 generic_desaturate(vec3 color, float factor)
        {
            vec3 lum = vec3(0.299, 0.587, 0.114);
            vec3 gray = vec3(dot(lum, color));
            return vec4(mix(color, gray, factor), 1.0);
        }

        // Algorithm employed by photoshop to desaturate the input
        vec4 photoshop_desaturate(vec3 color)
        {
            float bw = (min(color.r, min(color.g, color.b)) + max(color.r, max(color.g, color.b))) * 0.5;
            return vec4(bw, bw, bw, 1.0);
        }

    
        void main() {
            // TODO consider diffuse  color divide for true original luminosity
            vec4 originalColor = texture2D(tDiffuse, vUv);
            vec4 normalColor = normalize(originalColor);
            vec4 luminosity = generic_desaturate(originalColor.rgb, 1.0);


            if (luminosity.x < cels[7].x) {
                gl_FragColor = originalColor * cels[7].y;
            } else if (luminosity.x < cels[6].x) {
                gl_FragColor = originalColor * cels[6].y;
            } else if (luminosity.x < cels[5].x) {
                gl_FragColor = originalColor * cels[5].y;
            } else if (luminosity.x < cels[4].x) {
                gl_FragColor = originalColor * cels[4].y;
            } else if (luminosity.x < cels[3].x) {
                gl_FragColor = originalColor * cels[3].y;
            } else if (luminosity.x < cels[2].x) {
                gl_FragColor = originalColor * cels[2].y;
            } else if (luminosity.x < cels[1].x) {
                gl_FragColor = originalColor * cels[1].y;
            } else if (luminosity.x < cels[0].x) {
                gl_FragColor = originalColor * cels[0].y;
            } else if (luminosity.x > cels[0].x) {
                gl_FragColor = normalColor * vec4(5.0,5.0,5.0,1.0);
            }
            gl_FragColor.w = originalColor.w;
            #include <colorspace_fragment>
       }
    `,
};
