/// <reference path="./damp.d.ts" />

import { Vector2, Vector3 } from 'three';
import { lerp } from 'three/src/math/MathUtils.js';

export function dLerp(
    source: number,
    target: number,
    smoothing: number,
    delta: number
) {
    return lerp(source, target, 1 - Math.pow(smoothing, delta / 1000));
}

Vector3.prototype.dLerp = function (
    target: Vector3,
    smoothing: number,
    delta: number
) {
    this.set(
        dLerp(this.x, target.x, smoothing, delta),
        dLerp(this.y, target.y, smoothing, delta),
        dLerp(this.z, target.z, smoothing, delta)
    );

    return this;
};

Vector2.prototype.dLerp = function (
    this: Vector2,
    target: Vector2,
    smoothing: number,
    delta: number
) {
    this.set(
        dLerp(this.x, target.x, smoothing, delta),
        dLerp(this.y, target.y, smoothing, delta)
    );

    return this;
};
