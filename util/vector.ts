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

const xyzVector = new Vector3();
Object.defineProperty(Vector2.prototype, 'xyZ', {
    get() {
        return xyzVector.set(this.x, 0, this.y);
    },
});

Object.defineProperty(Vector2.prototype, 'xYz', {
    get() {
        return xyzVector.set(this.x, this.y, 0);
    },
});

Object.defineProperty(Vector3.prototype, 'r', {
    get() {
        return this.x;
    },
});

Object.defineProperty(Vector3.prototype, 'g', {
    get() {
        return this.y;
    },
});

Object.defineProperty(Vector3.prototype, 'b', {
    get() {
        return this.z;
    },
});
