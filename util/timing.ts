export function interval(length: number) {
    let time = 0;

    return (delta: number) => {
        time += delta;
        if (time >= length) {
            const totalDelta = time;
            time = 0;
            return totalDelta;
        }

        return false;
    };
}
