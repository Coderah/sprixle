/**
 * ReplicaSet — tracks what entity state the worker needs and accumulates
 * deltas for incremental sync. Lives on the main thread, driven by
 * patchHandlers and mirror queries.
 */

import { EntityId, Manager, defaultComponentTypes, Keys } from './manager';
import { Query, QueryParametersInput } from './query';
import { SerializedQueryDef, WriteEntry } from './sabTransport';

export interface ReplicaSetConfig {
    /** Additional component types to replicate beyond what queries auto-detect */
    extraComponents?: string[];
}

/**
 * Accumulated deltas for a single entity since last flush.
 * Component removal encoded as `{ key: undefined }` in the `set` record.
 */
interface EntityDelta {
    set: Record<string, unknown>;
    delete: string[];
}

export class ReplicaSet<CT extends defaultComponentTypes> {
    readonly manager: Manager<CT>;

    /** Component types the worker needs — auto-detected from query definitions */
    readonly neededComponentTypes = new Set<keyof CT>();

    /** Entities currently tracked (union of all mirror query entity sets) */
    readonly neededEntities = new Set<EntityId>();

    /** Mirror query for each worker query definition */
    private _mirrorQueries: Array<{
        query: Query<CT, any, any>;
        lastEntities: Set<EntityId>;
    }> = [];

    /** Pending component-level deltas, keyed by entity ID. Accumulated per-flush. */
    private _pendingDeltas = new Map<EntityId, EntityDelta>();

    /** Track which entities we've already sent full snapshots for */
    private _sentEntities = new Set<EntityId>();

    /** Snapshot of already-sent entity state for diffing */
    private _entityStates = new Map<EntityId, Record<string, unknown>>();

    private _initialized = false;

    constructor(manager: Manager<CT>) {
        this.manager = manager;
    }

    /** Initialize from worker query definitions. Must be called before any delta accumulation. */
    init(queryDefs: SerializedQueryDef[], config?: ReplicaSetConfig): void {
        if (this._initialized) return;
        this._initialized = true;

        // Auto-detect needed component types from query includes
        for (const def of queryDefs) {
            for (const name of def.includes) {
                this.neededComponentTypes.add(name as keyof CT);
            }
            if (def.index) {
                this.neededComponentTypes.add(def.index as keyof CT);
            }
        }

        // Add extra components from config
        if (config?.extraComponents) {
            for (const name of config.extraComponents) {
                this.neededComponentTypes.add(name as keyof CT);
            }
        }

        // Warn if no queries and no extra components
        if (queryDefs.length === 0 && !config?.extraComponents?.length) {
            console.warn(
                '[ReplicaSet] Worker has no queries and no extraComponents specified. ' +
                'All component types will be assumed needed. Consider adding queries ' +
                'or specifying neededComponents for better performance.'
            );
            for (const name of this.manager.componentNames) {
                this.neededComponentTypes.add(name);
            }
        }

        // Create mirror queries on the main thread
        for (const def of queryDefs) {
            const mirrorQuery = this.manager.createQuery({
                includes: def.includes as unknown as any[],
                excludes: def.excludes as unknown as any[],
                flexible: def.flexible,
                index: def.index as unknown as any,
            } as QueryParametersInput<typeof this.manager.ComponentTypes, any, any>);
            this._mirrorQueries.push({
                query: mirrorQuery as any,
                lastEntities: new Set(),
            });
        }

        // Install patchHandlers
        this._installPatchHandlers();
    }

    /** Build initial snapshot of all entities currently matching worker queries */
    buildSnapshot(): Record<EntityId, Record<string, unknown>> {
        const snapshot: Record<EntityId, Record<string, unknown>> = {};

        this._updateNeededEntities();

        for (const entityId of this.neededEntities) {
            const entity = this.manager.getEntity(entityId);
            if (!entity) continue;

            const filtered: Record<string, unknown> = {};
            for (const key of this.neededComponentTypes) {
                const k = key as string;
                if (k in entity.components) {
                    filtered[k] = entity.components[key];
                }
            }

            snapshot[entityId] = filtered;
            this._entityStates.set(entityId, { ...filtered });
            this._sentEntities.add(entityId);
        }

        return snapshot;
    }

    /** Accumulate a component-level delta for a tracked entity */
    accumulate(entityId: EntityId, patches: Record<string, unknown>): void {
        if (!this._sentEntities.has(entityId)) return;

        // Filter to only needed components
        const filtered: Record<string, unknown> = {};
        const deleted: string[] = [];

        for (const key of Object.keys(patches)) {
            if (!this.neededComponentTypes.has(key as keyof CT)) continue;
            if (patches[key] === undefined) {
                deleted.push(key);
            } else {
                filtered[key] = patches[key];
            }
        }

        if (Object.keys(filtered).length === 0 && deleted.length === 0) return;

        const existing = this._pendingDeltas.get(entityId);
        if (existing) {
            Object.assign(existing.set, filtered);
            for (const d of deleted) {
                if (!existing.delete.includes(d)) existing.delete.push(d);
                delete existing.set[d];
            }
        } else {
            this._pendingDeltas.set(entityId, { set: filtered, delete: deleted });
        }

        // Update tracked state snapshot
        const state = this._entityStates.get(entityId);
        if (state) {
            for (const key of deleted) delete state[key];
            Object.assign(state, filtered);
        }
    }

    /** Flush accumulated deltas and return them. Returns null if nothing to flush. */
    flush(): { patches: Array<{ entity: EntityId; set: Record<string, unknown>; delete: string[] }> } | null {
        this._updateNeededEntities();

        const patches: Array<{ entity: EntityId; set: Record<string, unknown>; delete: string[] }> = [];

        // Component-level deltas
        for (const [entityId, delta] of this._pendingDeltas) {
            patches.push({
                entity: entityId,
                set: delta.set,
                delete: delta.delete,
            });
        }
        this._pendingDeltas.clear();

        // Entity-level adds (new entities entered worker queries)
        for (const entityId of this.neededEntities) {
            if (!this._sentEntities.has(entityId)) {
                const entity = this.manager.getEntity(entityId);
                if (!entity) continue;

                const filtered: Record<string, unknown> = {};
                for (const key of this.neededComponentTypes) {
                    const k = key as string;
                    if (k in entity.components) {
                        filtered[k] = entity.components[key];
                    }
                }

                patches.push({
                    entity: entityId,
                    set: filtered,
                    delete: [],
                });

                this._entityStates.set(entityId, { ...filtered });
                this._sentEntities.add(entityId);
            }
        }

        // Entity-level removes (entities exited ALL worker queries)
        for (const entityId of this._sentEntities) {
            if (!this.neededEntities.has(entityId)) {
                patches.push({
                    entity: entityId,
                    set: {},
                    delete: [...this.neededComponentTypes] as unknown as string[],
                });

                this._sentEntities.delete(entityId);
                this._entityStates.delete(entityId);
            }
        }

        if (patches.length === 0) return null;
        return { patches };
    }

    /** Apply incoming worker writes to the main-thread manager */
    applyWrites(writes: WriteEntry[]): void {
        const em = this.manager;
        for (const write of writes) {
            if (write.create) {
                em.quickEntity(write.create as Partial<CT>);
                continue;
            }

            const entity = em.getEntity(write.entity);
            if (!entity) {
                if (write.destroy) continue;
                // Entity doesn't exist for non-create/non-destroy — might have been removed
                continue;
            }

            if (write.destroy) {
                em.deregisterEntity(entity);
                continue;
            }

            for (const key of write.delete) {
                delete (entity.components as any)[key];
            }
            for (const [key, val] of Object.entries(write.set)) {
                if (typeof val === 'object' && val !== null) {
                    entity.willUpdate(key as keyof CT);
                }
                (entity.components as any)[key] = val;
            }
        }
    }

    /** Check if a newly registered entity matches any worker queries */
    checkEntity(entity: CT['Entity']): void {
        for (const { query } of this._mirrorQueries) {
            if (query.entityMatches(entity)) {
                // Entity will be picked up on next flush via _updateNeededEntities
                return;
            }
        }
    }

    /** Mark entity for removal delta on next flush */
    handleEntityRemoved(entityId: EntityId): void {
        this._pendingDeltas.delete(entityId);
    }

    /** Clean up patchHandlers and mirror queries */
    destroy(): void {
        // Note: patchHandler chain removal would require storing the previous handlers
        // and restoring them. For now, simply null out the handler references.
        this._mirrorQueries = [];
        this._pendingDeltas.clear();
        this._sentEntities.clear();
        this._entityStates.clear();
    }

    // ── Internal ────────────────────────────────────────────────────

    /** Refresh neededEntities from all mirror queries */
    private _updateNeededEntities(): void {
        this.neededEntities.clear();

        if (this._mirrorQueries.length === 0 && this._sentEntities.size > 0) {
            // No queries but we've sent entities before — all sent entities are "needed"
            for (const id of this._sentEntities) this.neededEntities.add(id);
            return;
        }

        for (const mq of this._mirrorQueries) {
            for (const id of mq.query.entities) {
                this.neededEntities.add(id);
            }
        }
    }

    /** Install patchHandlers on the manager */
    private _installPatchHandlers(): void {
        const existing = this.manager.patchHandlers || {};

        const self = this;
        this.manager.patchHandlers = {
            ...existing,

            components(id: EntityId, patches: Partial<CT>) {
                existing.components?.(id, patches);
                if (!self._sentEntities.has(id)) return;

                const filtered: Record<string, unknown> = {};
                for (const key in patches) {
                    if (self.neededComponentTypes.has(key as keyof CT)) {
                        filtered[key] = patches[key];
                    }
                }
                if (Object.keys(filtered).length > 0) {
                    self.accumulate(id, filtered);
                }
            },

            register(entity: CT['Entity']) {
                existing.register?.(entity);
                self.checkEntity(entity);
            },

            deregister(entity: CT['Entity']) {
                existing.deregister?.(entity);
                self.handleEntityRemoved(entity.id);
            },
        };
    }
}
