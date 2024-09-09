import { Vector2, Vector3 } from 'three';

declare module 'three' {
    export interface Vector3 {
        get xy(): Vector2;
        get xz(): Vector2;
    }
}
