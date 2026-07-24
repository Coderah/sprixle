import { EntityId, Manager, defaultComponentTypes, Keys } from './manager';
import { Consumer, Query } from './query';
import { interval } from '../util/timing';

// --- Yieldable conditions ---

export interface DelayCondition {
    _spx: 'delay';
    ms: number;
    deadline: number;
    _deadlineSet: boolean;
}

export interface EntityWaitCondition {
    _spx: 'entityWait';
    entityId: EntityId;
    component: string;
    mode: 'added' | 'removed' | 'changed';
    _lastSeen?: any;
}

export interface QueryWaitCondition {
    _spx: 'queryWait';
    queryName: string;
    predicate?: (entity: any) => boolean;
    _consumerRef?: Consumer<any, any, any, any, any>;
}

export interface PromiseCondition {
    _spx: 'promise';
    promise: Promise<any>;
    resolved: boolean;
    value?: any;
    error?: any;
}

export type Yieldable =
    | DelayCondition
    | EntityWaitCondition
    | QueryWaitCondition
    | PromiseCondition
    | Promise<any>;

// --- AsyncSystem ---

export interface AsyncSystem<
    ExactComponentTypes extends defaultComponentTypes,
> {
    id?: string;
    tag?: string;
    condition?(): boolean;
    interval?: ReturnType<typeof interval>;
    init?(): void;
    reset?(): void;
    cleanup?(): void;

    _genFn: (
        em: Manager<ExactComponentTypes>,
        delta: number,
    ) => Generator<Yieldable, boolean | void, any>;
    _generator: Generator<Yieldable, boolean | void, any> | null;
    _currentCondition: Yieldable | null;
    _delta: number;
}

// --- Resume queue entry ---

export interface ResumeEntry {
    system: AsyncSystem<any>;
    value: any;
    error?: any;
}

// --- Condition builders (called by Manager helpers) ---

export function createDelayCondition(ms: number): DelayCondition {
    return { _spx: 'delay', ms, deadline: 0, _deadlineSet: false };
}

export function createEntityWaitCondition(
    entityId: EntityId,
    component: string,
    mode: 'added' | 'removed' | 'changed',
): EntityWaitCondition {
    return { _spx: 'entityWait', entityId, component, mode };
}

export function createQueryWaitCondition(
    queryName: string,
    predicate?: (entity: any) => boolean,
): QueryWaitCondition {
    return { _spx: 'queryWait', queryName, predicate };
}

export function wrapPromiseCondition(promise: Promise<any>): PromiseCondition {
    const cond: PromiseCondition = {
        _spx: 'promise',
        promise,
        resolved: false,
    };
    promise.then(
        (v) => {
            cond.resolved = true;
            cond.value = v;
        },
        (e) => {
            cond.resolved = true;
            cond.error = e;
        },
    );
    return cond;
}

// --- Condition evaluator (read-only) ---

export function evaluateCondition(
    condition: Yieldable,
    em: Manager<any>,
    pipelineNow: number,
): { resolved: boolean; value?: any; error?: any } {
    const spx = (condition as any)._spx;

    if (!spx) {
        if (condition instanceof Promise) {
            return { resolved: false };
        }
        return { resolved: false };
    }

    switch (spx) {
        case 'delay': {
            const c = condition as DelayCondition;
            if (!c._deadlineSet) {
                c.deadline = pipelineNow + c.ms;
                c._deadlineSet = true;
            }
            if (pipelineNow >= c.deadline) {
                return { resolved: true, value: pipelineNow - c.deadline };
            }
            return { resolved: false };
        }

        case 'entityWait': {
            const c = condition as EntityWaitCondition;
            const entitySet = em.state.entityMap.get(c.component as any);
            const has = entitySet ? entitySet.has(c.entityId) : false;

            switch (c.mode) {
                case 'added':
                    if (has) return { resolved: true, value: em.getEntity(c.entityId) };
                    return { resolved: false };
                case 'removed':
                    if (!has) return { resolved: true, value: c.entityId };
                    return { resolved: false };
                case 'changed': {
                    if (!has) return { resolved: false };
                    const entity = em.getEntity(c.entityId);
                    if (!entity) return { resolved: false };
                    const current = entity.components[c.component as any];
                    if (c._lastSeen === undefined) {
                        c._lastSeen = current;
                        return { resolved: false };
                    }
                    if (current !== c._lastSeen) {
                        return { resolved: true, value: entity };
                    }
                    return { resolved: false };
                }
            }
            return { resolved: false };
        }

        case 'queryWait': {
            const c = condition as QueryWaitCondition;
            const query = em.state.queries.get(c.queryName);
            if (!query) return { resolved: false };

            let consumer = c._consumerRef;
            if (!consumer) {
                consumer = query.createConsumer();
                c._consumerRef = consumer;
            }

            let match: any = null;
            const check = (id: EntityId): boolean => {
                if (match) return false;
                const entity = em.getEntity(id);
                if (entity && (!c.predicate || c.predicate(entity))) {
                    match = entity;
                    return true;
                }
                return false;
            };

            for (const id of consumer.newEntities) {
                if (check(id)) break;
            }
            if (!match) {
                for (const id of consumer.updatedEntities) {
                    if (check(id)) break;
                }
            }

            if (match) {
                consumer.forNewOrUpdated();
                return { resolved: true, value: match };
            }
            return { resolved: false };
        }

        case 'promise': {
            const c = condition as PromiseCondition;
            if (c.resolved) {
                if (c.error) {
                    return { resolved: true, error: c.error };
                }
                return { resolved: true, value: c.value };
            }
            return { resolved: false };
        }

        default:
            return { resolved: false };
    }
}

// --- Async system evaluation: check condition, collect resume entry if resolved ---

export function evaluateAsyncSystem(
    system: AsyncSystem<any>,
    em: Manager<any>,
    pipelineNow: number,
    delta: number,
): ResumeEntry | null {
    system._delta = delta;

    if (!system._generator) {
        system._generator = system._genFn(em, delta);
    }

    if (!system._currentCondition) {
        const genResult = system._generator.next();
        if (genResult.done) {
            if (genResult.value !== false) {
                system._generator = system._genFn(em, system._delta);
            } else {
                system._generator = null;
            }
            return null;
        }
        const rawYield: Yieldable = genResult.value instanceof Promise
            ? wrapPromiseCondition(genResult.value)
            : genResult.value;
        system._currentCondition = rawYield;
        const evalResult = evaluateCondition(rawYield, em, pipelineNow);
        if (evalResult.resolved) {
            system._currentCondition = null;
            return { system, value: evalResult.value, error: evalResult.error };
        }
        return null;
    }

    const result = evaluateCondition(system._currentCondition, em, pipelineNow);
    if (result.resolved) {
        system._currentCondition = null;
        return { system, value: result.value, error: result.error };
    }
    return null;
}

// --- Flush deferred resumes after all sync systems ---

export function flushAsyncResumes(
    entries: ResumeEntry[],
    em: Manager<any>,
    pipelineNow: number,
): number {
    const MAX_CHAIN = 100;
    let count = 0;

    for (const entry of entries) {
        const system = entry.system;
        if (!system._generator) continue;

        let cycleCount = 0;
        let genResult: IteratorResult<Yieldable, boolean | void> = entry.error
            ? system._generator.throw(entry.error)
            : system._generator.next(entry.value);

        while (system._generator && cycleCount < MAX_CHAIN) {
            cycleCount++;
            count++;

            if (genResult.done) {
                if (genResult.value !== false) {
                    system._generator = system._genFn(em, system._delta);
                } else {
                    system._generator = null;
                }
                break;
            }

            const yielded = genResult.value;
            if (yielded instanceof Promise) {
                system._currentCondition = wrapPromiseCondition(yielded);
                break;
            }

            const evalResult = evaluateCondition(yielded, em, pipelineNow);
            if (evalResult.resolved) {
                genResult = evalResult.error
                    ? system._generator.throw(evalResult.error)
                    : system._generator.next(evalResult.value);
                continue;
            }

            system._currentCondition = yielded;
            break;
        }
    }

    return count;
}
