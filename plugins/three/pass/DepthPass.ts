import * as THREE from 'three';
import { RenderPass } from 'three-stdlib';

export class DepthPass extends RenderPass {
    constructor(scene: THREE.Scene, camera: THREE.Camera) {
        const overrideMaterial = new THREE.MeshBasicMaterial({
            colorWrite: false,
            color: 'red',
            depthWrite: true,
        });
        super(scene, camera, overrideMaterial);
    }

    render(
        renderer: THREE.WebGLRenderer,
        inputBuffer: THREE.WebGLRenderTarget,
        outputBuffer: THREE.WebGLRenderTarget
    ): void {
        renderer.getContext().depthFunc(renderer.getContext().LEQUAL);
        super.render(renderer, inputBuffer, outputBuffer);
    }
}
