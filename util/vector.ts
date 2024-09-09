/// <reference path="./vector.d.ts" />

import { Vector2, Vector3 } from 'three';

const xzVector = new Vector2();
Object.defineProperty(Vector3.prototype, 'xz', {
    get() {
        return xzVector.set(this.x, this.z);
    },
});

const xyVector = new Vector2();
Object.defineProperty(Vector3.prototype, 'xy', {
    get() {
        return xyVector.set(this.x, this.y);
    },
});
