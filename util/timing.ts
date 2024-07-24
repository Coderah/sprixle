export function interval(length: number) {
    let time = 0;

    return (delta: number) => {
        time += delta;
        if (time >= length) {
            const totalDelta = time;
            time = Math.max(0, time - length);
            return totalDelta;
        }

        return false;
    };
}
