import { vec2 } from "gl-matrix";
import { Dict } from "../ecs/dict";

let test = new Dict({
    test: 'value',
    deep: {
        bar: 'foo',
        vec: vec2.create(),
    }
})

test.get('test') //?
test.get('deep') //?
test.get('deep', 'vec', 0); //?

test.set(['deep', 'vec', 0], 5);
test.get('deep', 'vec', 0); //?

test.set('test', 'newValue');
test.get('test') // ?