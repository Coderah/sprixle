import { memoize } from 'lodash';

let timeDiff = 0;

export function setTimeSyncDiff(serverNow: number) {
    now.cache.clear?.();
    timeDiff = now() - serverNow;

    console.log('serverTime diff set', timeDiff);
}

export const now = memoize((): number => {
    return Date.now() - timeDiff;
});
