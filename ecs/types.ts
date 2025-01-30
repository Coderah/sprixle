export type MapOf<T> = Map<keyof T, T[keyof T]>;

export type SingletonComponent = { __meta?: ['SingletonComponent'] };
