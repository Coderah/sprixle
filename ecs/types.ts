import { Group } from '@deepkit/type';

export type MapOf<T> = Map<keyof T, T[keyof T]>;

export type SingletonComponent = Group<'SingletonComponent'>;

type NestableTypes = Record<string, unknown> | Array<unknown>;
export type Nested<T extends NestableTypes> = T & Group<'Nested'>;
