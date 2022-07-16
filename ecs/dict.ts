import { vec2 } from 'gl-matrix';
import {set as loSet, get as loGet} from 'lodash';

type Keys<T> = T extends Partial<infer O> ? keyof O : keyof T;

type NullableProperties<T> = {
    [K in keyof T]?: T[K] | null;
};

type Head<T> = T extends Parameters<(v: infer R, ...args: any[]) => any>
    ? R
    : never;

type Tail<T> = T extends any[]
    ? ((...args: T) => any) extends (v: any, ...args: infer R) => any
        ? R
        : never
    : never;

type POJO<T> = T extends Dict<infer O> ? O : T;

type RetrievePathReducer<T, C, L extends any[]> = C extends Keys<T>
    ? {
          0: T[C];
          1: RetrievePathReducer<POJO<T[C]>, Head<L>, Tail<L>>;
      }[L extends [] ? 0 : 1]
    : never;

export type RetrievePath<T, L> = L extends []
    ? T
    : RetrievePathReducer<POJO<T>, Head<L>, Tail<L>>;

// type Path<T, K extends keyof POJO<T> = keyof POJO<T>> = K extends K ? [K, ...{
//       0: []
//       1: [] | Path<POJO<T>[K]>
//   }[POJO<T>[K] extends string | number | boolean ? 0: 1]] : never;

type PathTree<T> = {
    [P in Keys<T>]: T[P] extends object
        ? [P] | [P, ...Path<T[P]>]
        : [P];
};

type Path<T> = T extends Dict<infer O>
    ? PathTree<O>[keyof PathTree<O>]
    : PathTree<T>[keyof PathTree<T>];

declare module 'lodash' {
    interface LoDashStatic {
        get<T, P extends Path<T>, V = RetrievePath<T,P>>(obj: T, path: P): V
        set<T, P extends Path<T>, V = RetrievePath<T,P>>(obj: T, path: P, value: V)
    }
}

export function get<T, P extends Path<T>, V = RetrievePath<T, P>>(
    data: T,
    path: P
): V | null {
    return loGet<T, P, V>(data, path);
}

export function set<T, P extends Path<T>, V = RetrievePath<T, P>>(
    data: T,
    path: P,
    value: V,
 ) {
   loSet<T, P, V>(data, path, value);
}

export function keys<T>(data: T): Array<Keys<T>> {
    return Object.keys(data) as Array<Keys<T>>;
}

export function keySet<T>(data: T) {
    return new Set(keys(data));
}

export class Dict<T> {
    data: T;
    constructor(values: T) {
        this.data = Object.assign({}, values);
    }

    get<P extends Path<T>>(...path: P) {
        return get<T, P>(this.data, path);
    };

    set<P extends Path<T>, V = RetrievePath<T, P>>(path: P, value: V) {
        return set<T, P, V>(this.data, path, value);
    }

    keys() {
        return keys(this.data);
    }
}