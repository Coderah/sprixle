interface Map<K, V> {
    first(): V;
}

Map.prototype.first = function <K, V>(this: Map<K, V>) {
    return this.values()[0];
};

interface Set<T> {
    equals(b: Set<T>): boolean;
    first(): T;
    map<V>(callbackFn: (value: T) => V): Set<V>;
    reduce<A>(callbackFn: (accumulator: A, value: T) => A, accumulator: A): A;
    union(b: Set<T>): Set<T>;
    intersect(...b: Set<T>[]): Set<T>;
    subtract(...b: Set<T>[]): Set<T>;
}

Set.prototype.reduce = function <T, A>(
    this: Set<T>,
    callbackFn: (accumulator: A, value: T) => A,
    accumulator: A
) {
    this.forEach((value) => {
        accumulator = callbackFn(accumulator, value);
    });

    return accumulator;
};

Set.prototype.subtract = function <T>(this: Set<T>, ...b: Set<T>[]) {
    return new Set<T>(
        Array.from(this).filter((x) => !b.some((bb) => bb.has(x)))
    );
};

Set.prototype.union = function <T>(this: Set<T>, b: Set<T>) {
    return new Set([...this, ...b]);
};

Set.prototype.intersect = function <T>(this: Set<T>, ...b: Set<T>[]) {
    return new Set<T>(
        Array.from(this).filter((x) => b.every((bb) => bb.has(x)))
    );
};

Set.prototype.map = function <T, V>(
    this: Set<T>,
    callbackFn: (value: T) => V
): Set<V> {
    return new Set(Array.from(this).map(callbackFn));
};

Set.prototype.first = function <T>(this: Set<T>) {
    return this.values()[0];
};

Set.prototype.equals = function <T>(this: Set<T>, b: Set<T>) {
    if (this.size !== b.size) return false;
    for (let a of this) if (!b.has(a)) return false;
    return true;
};
