import { DepthTexture, Texture, Vector2 } from 'three';
import { now } from '../../../util/now';

export const uniformTime = {
    value: now(),
};

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
