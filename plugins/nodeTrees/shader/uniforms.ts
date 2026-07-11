import { DepthTexture, Texture, Vector2 } from 'three';
import { now } from '../../../util/now';

export const uniformTime = {
    value: now(),
};

export const uniformFrame = {
    value: 0,
};

export const depthUniform = {
    value: new Texture(),
};

// globalThis, not window: this module must stay importable in headless node (server sim, benchmark
// harness) where DOM globals don't exist. The renderer plugin overwrites it on resize regardless.
export const resolutionUniform = {
    value: new Vector2(globalThis.innerWidth ?? 1, globalThis.innerHeight ?? 1),
};

export const cameraNearUniform = {
    value: 0,
};

export const cameraFarUniform = {
    value: 300,
};
