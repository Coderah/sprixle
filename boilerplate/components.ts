import { Mesh } from "three";
import { Vector3 } from "three";
import { defaultComponentTypes, DEFAULT_COMPONENT_DEFAULTS } from "../ecs/manager";

export type ComponentTypes = defaultComponentTypes & {
    version: number;

    mesh: Mesh | null,
    type: string | null,

    position: Vector3;
}

export const COMPONENT_DEFAULTS: ComponentTypes = {
    ...DEFAULT_COMPONENT_DEFAULTS,
    version: 0,

    mesh: null,
    type: null,

    position: new Vector3(0,0,0),
}