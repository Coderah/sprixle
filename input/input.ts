import {
    Camera,
    Plane,
    Raycaster,
    Renderer,
    Scene,
    Vector2,
    Vector3,
} from 'three';
import { now } from '../util/now';

const plane = new Plane(new Vector3(0, 1, 0), 1);
export const raycaster = new Raycaster();
const intersectPoint = new Vector3();

const worldMousePosition = new Vector3();
const screenMousePosition = new Vector2();

const mouseButtons = {
    0: 'Left',
    1: 'Middle',
    2: 'Right',
};

export type InputTypes = 'keyboard' | 'mouse' | 'gamepad';

export class KeyBinds<B, T extends keyof B> {
    binds: B;
    type: InputTypes;

    constructor(type: InputTypes, binds: B) {
        this.type = type;
        this.binds = binds;
    }

    get(bindName: T) {
        let input = this.binds[bindName] as string;

        if (input.startsWith('Any')) {
            input = input.replace('Any', '');
            return inputState[input + 'Left'] || inputState[input + 'Right'];
        }

        return inputState[input];
    }

    // TODO set
    // TODO (de)serialize
    // TODO add *once* event to set a keybind, limiting to this.type events
}

export const inputState = {
    screenMousePosition,
    worldMousePosition,
};

window['inputState'] = inputState;

export function inputTick(camera: Camera) {
    raycaster.setFromCamera(
        {
            x: (screenMousePosition.x / window.innerWidth) * 2 - 1,
            y: -(screenMousePosition.y / window.innerHeight) * 2 + 1,
        },
        camera
    );
    raycaster.ray.intersectPlane(plane, intersectPoint);

    worldMousePosition.copy(intersectPoint);
}

export function initInput(domElement: HTMLElement) {
    const handleMouseMove = (event: MouseEvent) => {
        screenMousePosition.set(event.offsetX, event.offsetY);
    };

    const handleMouseDown = (event: MouseEvent) => {
        if (event.currentTarget === domElement) {
            event.preventDefault();
            // event.stopImmediatePropagation();
        }
        if (event.button in mouseButtons) {
            inputState['MouseButton' + mouseButtons[event.button]] = now();
        } else {
            inputState['MouseButton' + event.button] = now();
        }
    };

    const handleMouseUp = (event: MouseEvent) => {
        if (event.currentTarget === domElement) {
            event.preventDefault();
            // event.stopImmediatePropagation();
        }
        if (event.button in mouseButtons) {
            inputState['MouseButton' + mouseButtons[event.button]] = null;
        } else {
            inputState['MouseButton' + event.button] = null;
        }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
        inputState[event.code] = now();
    };

    const handleKeyUp = (event: KeyboardEvent) => {
        inputState[event.code] = null;
    };

    domElement.addEventListener('contextmenu', (event) =>
        event.preventDefault()
    );

    document.addEventListener('keyup', handleKeyUp);
    document.addEventListener('keydown', handleKeyDown);
    domElement.addEventListener('mousedown', handleMouseDown);
    domElement.addEventListener('mouseup', handleMouseUp);
    domElement.addEventListener('dragend', handleMouseUp);
    domElement.addEventListener('mousemove', handleMouseMove);
    domElement.addEventListener('mouseleave', handleMouseMove);
}
