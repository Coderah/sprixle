let timeDiff = 0;

export function setTimeSyncDiff(serverNow: number, pingSentAt = now.real()) {
    timeDiff = pingSentAt - serverNow;

    console.log('serverTime diff set', timeDiff);
}

export function getTimeDiff(): number {
    return timeDiff;
}

let activeTimeTarget: { now: number } | null = null;

export function setActiveTimeTarget(timeTarget: { now: number } | null) {
    activeTimeTarget = timeTarget;
}

export const now = (): number => {
    return activeTimeTarget ? activeTimeTarget.now : Date.now();
};

now.real = () => Date.now();
