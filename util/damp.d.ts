import { Vector3, Vector2 } from 'three';

declare module 'three' {
    export interface Vector3 {
        dLerp: (target: Vector3, smoothing: number, delta: number) => Vector2;
    }

    export interface Vector2 {
        dLerp: (
            this: Vector2,
            target: Vector2,
            smoothing: number,
            delta: number
        ) => Vector2;
    }
}
