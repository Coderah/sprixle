import { memoize } from 'lodash';
import { Pipeline } from '../ecs/system';

let timeDiff = 0;

export function setTimeSyncDiff(serverNow: number) {
    memoizedGlobalNow.cache.clear?.();
    timeDiff = now() - serverNow;

    console.log('serverTime diff set', timeDiff);
}

let activePipeline: Pipeline<any> | null = null;

export function setTimeActivePipeline(pipeline: Pipeline<any> | null) {
    activePipeline = pipeline;
}

export const memoizedGlobalNow = memoize((): number => {
    return Date.now() - timeDiff;
});

export const now = (): number => {
    return activePipeline ? activePipeline.now : memoizedGlobalNow();
};
