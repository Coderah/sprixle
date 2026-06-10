/// <reference path="./object.extensions.d.ts" />

Map.prototype.first = function <K, V>(this: Map<K, V>) {
    return this.values()[0];
};

Map.prototype.last = function <K, V>(this: Map<K, V>) {
    return this.values()[this.size - 1];
};

Set.prototype.keyBy = function <T, K extends keyof T>(this: Set<T>, key: K) {
    const result = new Map<K, T>();

    for (let item of this) {
        result.set(item[key] as K, item);
    }

    return result;
};

Set.prototype.every = function <T>(this: Set<T>, fn: (value: T) => boolean) {
    for (let item of this) {
        if (!fn(item)) return false;
    }

    return true;
};

Set.prototype.some = function <T>(this: Set<T>, fn: (value: T) => boolean) {
    for (let item of this) {
        if (fn(item)) return true;
    }

    return false;
};

Set.prototype.eachIntersect = function <T>(
    this: Set<T>,
    b: Set<T>,
    fn: (value: T) => boolean
) {
    return this.forEach((t) => {
        if (b.has(t)) {
            return fn(t);
        }
    });
};

Set.prototype.eachSub = function <T>(
    this: Set<T>,
    b: Set<T>,
    fn: (value: T) => boolean
) {
    return this.forEach((t) => {
        if (!b.has(t)) {
            return fn(t);
        }
    });
};

Set.prototype.filter = function <T>(this: Set<T>, fn: (value: T) => boolean) {
    return new Set<T>(Array.from(this).filter(fn));
};

Set.prototype.find = function <T>(this: Set<T>, fn: (value: T) => boolean) {
    return Array.from(this).find(fn);
};

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

// Returns a NEW sorted array, not a Set — a Set has no meaningful internal order,
// so the only sensible result of sorting one is an ordered sequence you can index
// and iterate. This is the missing link in the common `query.entities` chain:
// `q.map(...).filter(...).sort(cmp)` — map/filter return Sets, and previously
// .sort blew up because Set had no sort. Now the whole chain just works.
Set.prototype.sort = function <T>(
    this: Set<T>,
    compareFn?: (a: T, b: T) => number
): T[] {
    return Array.from(this).sort(compareFn);
};

Set.prototype.toArray = function <T>(this: Set<T>): T[] {
    return Array.from(this);
};

Set.prototype.first = function <T>(this: Set<T>) {
    return this.values().next().value;
};

Set.prototype.last = function <K, V>(this: Map<K, V>) {
    return this.values()[this.size - 1];
};

Set.prototype.equals = function <T>(this: Set<T>, b: Set<T>) {
    if (this.size !== b.size) return false;
    for (let a of this) if (!b.has(a)) return false;
    return true;
};
