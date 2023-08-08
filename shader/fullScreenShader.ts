import * as THREE from 'three';
import { Color, Texture, Vector2, Vector3 } from 'three';
import { glsl } from './util';
import { uniformTime } from '../render/const';

export const fullScreenShader = {
    transparent: true,
    uniforms: {
        tDiffuse: { value: new Texture() },
    },

    vertexShader: glsl`
    varying vec2 vUv;  

    void main(){
    
        vUv = uv;
        gl_Position = vec4(position, 1.0);
    }`,

    fragmentShader: glsl`
    uniform sampler2D tDiffuse;
    
    varying vec2 vUv;  
    void main(){
        vec4 color = texture2D(tDiffuse, vUv);
        gl_FragColor = color;
    }
    `,
};
