/** functional way to conditionally run code at a regular interval, can be accumulative to guarantee all time passed is accounted for. */
export function interval(length: number) {
    const fn = (delta: number) => {
        fn.time += delta;
        if (fn.time >= length) {
            const totalDelta = fn.time;
            if (fn.accumulative) {
                fn.time = Math.max(0, fn.time - length);
            } else {
                fn.time = 0;
            }
            return totalDelta;
        }

        return false;
    };

    fn.time = 0;
    fn.timeLength = length;
    fn.accumulative = true;

    return fn;
}
