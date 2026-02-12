import { Data, Group } from '@deepkit/type';

export type MapOf<T> = Map<keyof T, T[keyof T]>;

export type SingletonComponent = Group<'SingletonComponent'>;

type NestableTypes = Record<string, unknown> | Array<unknown>;
export type Nested<T extends NestableTypes> = T & Group<'Nested'>;

type PointerMaps = Map<unknown, unknown> | Record<string, unknown>;
export type Pointer<T extends PointerMaps, PointerDataName extends string> = T &
    Data<'Pointer', PointerDataName>;

// TODO add TrackPrevious and only update previousComponents if this flag is on the type
export type TrackPrevious = Group<'TrackPrevious'>;

export type Annotations = 'Nested' | 'SingletonComponent' | 'TrackPrevious';
