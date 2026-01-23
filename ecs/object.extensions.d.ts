declare interface Map<K, V> {
    first(): V;
    last(): V;
}

declare interface Set<T> {
    equals(b: Set<T>): boolean;
    first(): T;
    last(): T;
    keyBy<K extends keyof T>(key: K): Map<K, T>;
    map<V>(callbackFn: (value: T) => V): Set<V>;
    reduce<A>(callbackFn: (accumulator: A, value: T) => A, accumulator: A): A;
    union(b: Set<T>): Set<T>;
    intersect(...b: Set<T>[]): Set<T>;
    /** Loops through `this` and only runs `fn` for items that are also in `b` */
    eachIntersect(b: Set<T>, fn: (value: T) => boolean | void): void;
    subtract(...b: Set<T>[]): Set<T>;
    /** Loops through `this` and only runs `fn` for items that are not in `b` */
    eachSub(b: Set<T>, fn: (value: T) => boolean | void): void;
    filter(fn: (value: T) => boolean): Set<T>;
    find(fn: (value: T) => boolean): T | null;
    every(fn: (value: T) => boolean): boolean;
    some(fn: (value: T) => boolean): boolean;
}
