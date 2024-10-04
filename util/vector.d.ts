import { Vector2, Vector3 } from 'three';

declare module 'three' {
    export interface Vector3 {
        get xy(): Vector2;
        get xz(): Vector2;
        get r(): number;
        get g(): number;
        get b(): number;
    }

    export interface Vector2 {
        get xYz(): Vector3;
        get xyZ(): Vector3;
    }
}
