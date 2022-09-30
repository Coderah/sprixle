import { Camera, Plane, Raycaster, Renderer, Vector2, Vector3 } from 'three';
import { now } from '../util/now';

var plane = new Plane(new Vector3(0, 1, 0), 0);
var raycaster = new Raycaster();
var intersectPoint = new Vector3();

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

export function initInput(renderer: Renderer) {
    const handleMouseMove = (event: MouseEvent) => {
        screenMousePosition.set(event.clientX, event.clientY);
    };

    const handleMouseDown = (event: MouseEvent) => {
        if (event.currentTarget === renderer.domElement) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
        if (event.button in mouseButtons) {
            inputState['MouseButton' + mouseButtons[event.button]] = now();
        } else {
            inputState['MouseButton' + event.button] = now();
        }
    };

    const handleMouseUp = (event: MouseEvent) => {
        if (event.currentTarget === renderer.domElement) {
            event.preventDefault();
            event.stopImmediatePropagation();
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

    document.addEventListener('contextmenu', (event) => event.preventDefault());

    document.addEventListener('keyup', handleKeyUp);
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseleave', handleMouseMove);
}