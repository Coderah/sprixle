import { DepthTexture, Texture, Vector2 } from 'three';

export const depthUniform = {
    value: new Texture(),
};

export const resolutionUniform = {
    value: new Vector2(window.innerWidth, window.innerHeight),
};

export const cameraNearUniform = {
    value: 0,
};

export const cameraFarUniform = {
    value: 300,
};
