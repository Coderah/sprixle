import { throttle } from 'lodash';

let throttled = true;

export function setLogContextToDebug() {
    throttled = false;
}

const throttledHandler = throttle(console.log, 200, {
    leading: true,
    trailing: true,
});

export const throttleLog = function (...data: any[]) {
    if (throttled) {
        throttledHandler(...data);
    } else {
        console.log(...data);
    }
};
