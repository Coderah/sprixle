export async function time(n: number) {
    return new Promise((resolve) => {
        setTimeout(resolve, n);
    });
}
