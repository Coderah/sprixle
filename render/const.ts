import * as THREE from 'three';
import { DepthTexture, NearestFilter, UnsignedShortType } from 'three';

export const GRID_UNIT = 6;

export const MESH_LAYER = 0;
export const INTERACTION_LAYER = 1;
export const LIGHT_LAYER = 2;
export const SPRITE_LAYER = 3;
export const OVERLAY_LAYER = 4;

export const uniformTime = { value: 0.0 };

const textureSize = 1024;

const depthTexture = new DepthTexture(textureSize, textureSize);
depthTexture.type = THREE.UnsignedIntType;
depthTexture.format = THREE.DepthFormat;

export const STAGED_RENDER_TARGET = new THREE.WebGLRenderTarget(textureSize, textureSize, {
    minFilter: NearestFilter,
    magFilter: NearestFilter,
    format: THREE.RGBAFormat,
    depthTexture,
    depthBuffer: true,
});

STAGED_RENDER_TARGET.texture.generateMipmaps = false;
STAGED_RENDER_TARGET.depthTexture = depthTexture;
STAGED_RENDER_TARGET.depthBuffer = true;

export const STAGED_NORMAL_TARGET = new THREE.WebGLRenderTarget(textureSize, textureSize, {
    minFilter: NearestFilter,
    magFilter: NearestFilter,
    format: THREE.RGBAFormat,
});