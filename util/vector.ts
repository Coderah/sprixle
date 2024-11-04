/// <reference path="./vector.d.ts" />

import { Vector2, Vector3 } from 'three';

const rand = () => Math.random() * 2 - 1;

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

export function randomizeVector<V = Vector2 | Vector3>(vector: V): V {
    if (vector instanceof Vector2) {
        vector.set(rand(), rand());
    } else if (vector instanceof Vector3) {
        vector.set(rand(), rand(), rand());
    }
    return vector;
}

Object.defineProperty(Vector2.prototype, 'xYz', {
    get() {
        return xyzVector.set(this.x, this.y, 0);
    },
});

// Object.defineProperty(Vector3.prototype, 'r', {
//     get() {
//         return this.x;
//     },
//     set(v: number) {
//         this.x = v;
//     },
// });

// Object.defineProperty(Vector3.prototype, 'g', {
//     get() {
//         return this.y;
//     },
//     set(v: number) {
//         this.y = v;
//     },
// });

// Object.defineProperty(Vector3.prototype, 'b', {
//     get() {
//         return this.z;
//     },
//     set(v: number) {
//         this.z = v;
//     },
// });
