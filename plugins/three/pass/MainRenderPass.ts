import * as THREE from 'three';
import { RenderPass } from 'three-stdlib';

export class MainRenderPass extends RenderPass {
    constructor(scene: THREE.Scene, camera: THREE.Camera) {
        super(scene, camera);
        // Avoid clearing the depth buffer before rendering as that would throw out all the depth data
        // computed in the pre-pass
        this.clear = false;
    }

    render(
        renderer: THREE.WebGLRenderer,
        inputBuffer: THREE.WebGLRenderTarget,
        outputBuffer: THREE.WebGLRenderTarget
    ) {
        const ctx = renderer.getContext();

        // Set the depth test function to EQUAL which uses the pre-computed data in the depth buffer to
        // automatically discard fragments that aren't visible to the camera
        ctx.depthFunc(ctx.EQUAL);
        super.render.apply(this, [renderer, inputBuffer, outputBuffer]);
        ctx.depthFunc(ctx.LEQUAL);
    }
}
