export function interval(length: number) {
    let time = 0;

    return (delta: number) => {
        time += delta;
        if (time >= length) {
            time = 0;
            return true;
        }

        return false;
    };
}
