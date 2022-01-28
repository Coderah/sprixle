import { fromJS, List, Set } from 'immutable';

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

type POJO<T> = T extends Immutable<infer O> ? O : T;

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
    [P in Keys<T>]: T[P] extends Immutable<infer O>
        ? [P] | [P, ...Path<O>]
        : [P];
};

type Path<T> = T extends Immutable<infer O>
    ? PathTree<O>[keyof PathTree<O>]
    : PathTree<T>[keyof PathTree<T>];

export interface Immutable<T> {
    // __POJOType: T;
    get<K extends Keys<T>>(key: K): T[K] | undefined;
    set<K extends Keys<T>, V extends T[K]>(key: K, value: V): Immutable<T>;
    setIn<P extends Path<T>, V extends RetrievePath<T, P>>(
        path: P,
        value: V
    ): Immutable<T>;
    updateIn<P extends Path<T>, V extends RetrievePath<T, P>>(
        path: P,
        value: (v: V) => V
    ): Immutable<T>;
    updateIn<P extends Path<T>, V extends RetrievePath<T, P>>(
        path: P,
        notSetValue: V,
        value: (v: V) => V
    ): Immutable<T>;
    deleteIn<P extends Path<T>, V extends RetrievePath<T, P>>(
        path: P
    ): Immutable<T>;
    getIn<P extends Path<T>, V extends RetrievePath<T, P>>(
        path: P,
        notSetValue?: V
    ): V | undefined;
    hasIn<P extends Path<T>>(path: P): boolean;
    keySeq(): Set<Keys<POJO<T>>>;

    forEach(
        fn: <K extends Keys<T>>(value: POJO<T[K]>, key?: K) => boolean | void
    ): number;
    map(
        fn: <K extends Keys<T>>(value: POJO<T[K]>, key?: K) => T[K]
    ): Immutable<T>;
    mapKeys<ET>(
        fn: <K extends Keys<T>>(key: K, value?: POJO<T[K]>) => Keys<ET>
    ): Immutable<ET>;
    filter(
        fn: <K extends Keys<T>>(value: POJO<T[K]>, key?: K) => boolean
    ): Immutable<Partial<T>>;
}

export default function imm<T>(o: T) {
    return fromJS(o) as unknown as Immutable<T>;
}
