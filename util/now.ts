let timeDiff = 0;

export function setTimeSyncDiff(serverNow: number) {
    timeDiff = now() - serverNow;

    console.log('serverTime diff set', timeDiff);
}

export function now(): number {
    return Date.now() - timeDiff;
}
