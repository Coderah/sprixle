import { throttle } from 'lodash';

export const throttleLog = throttle(console.log, 200, {
    leading: true,
    trailing: true,
});
