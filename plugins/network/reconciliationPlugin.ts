import {
    defaultComponentTypes,
    EntityId,
    Keys,
    Manager,
} from '../../ecs/manager';
import { sprixlePlugin } from '../../ecs/plugin';

export type ReconciliationStrategy = 'none' | 'basic' | 'replay';

export type ReconciliationComponentTypes = {
    reconciliationVersions: Record<string, number>;
};

type PredictionEntry = {
    version: number;
    strategy: ReconciliationStrategy;
};

// TODO implement replay strategy.

export default sprixlePlugin(function reconciliationPlugin<
    ComponentTypes extends defaultComponentTypes & ReconciliationComponentTypes,
>(manager: Manager<ComponentTypes>) {
    // Internal state: entityId -> componentKey -> { version, strategy }
    const predictions = new Map<EntityId, Map<string, PredictionEntry>>();

    // TODO maybe have per component versions??
    // Global version counter for RPC sequencing
    let versionCounter = 0;

    /**
     * Get the next version number for an RPC call.
     * Call this before executing the optimistic action.
     */
    function getNextVersion(): number {
        return ++versionCounter;
    }

    /**
     * Track a reconcilable action after the client has optimistically executed it.
     * Call this after the action has modified stagedUpdates.
     * @param strategy The reconciliation strategy to use
     * @param version The version number to apply (from getNextVersion)
     */
    function trackReconcilableAction(
        strategy: ReconciliationStrategy,
        version: number
    ) {
        if (strategy === 'none') return;

        for (const [entityId, components] of manager.state.stagedUpdates) {
            const entity = manager.state.entities.get(entityId);
            if (!entity) continue;

            // Ensure reconciliationVersions component exists
            let versions = (entity.components.reconciliationVersions ??
                {}) as Record<string, number>;

            // Track internally for each component that changed
            if (!predictions.has(entityId)) {
                predictions.set(entityId, new Map());
            }
            const entityPredictions = predictions.get(entityId)!;

            for (const componentKey of components) {
                // Skip tracking the reconciliationVersions component itself
                if (componentKey === 'reconciliationVersions') continue;

                // Apply the provided version for this component
                versions[componentKey as string] = version;

                // Store prediction internally
                entityPredictions.set(componentKey as string, {
                    version,
                    strategy,
                });
            }

            // Update the reconciliationVersions component on the entity
            // This will be synced to the server
            entity.components.reconciliationVersions = versions;
        }
    }

    /**
     * Server-side: Apply a version number to all entities/components modified by an RPC.
     * Call this after the RPC method has executed on the server.
     * @param version The version number received from the client
     */
    function applyReconciliationVersion(version: number) {
        for (const [entityId, components] of manager.state.stagedUpdates) {
            const entity = manager.state.entities.get(entityId);
            if (!entity) continue;

            // Ensure reconciliationVersions component exists
            let versions = (entity.components.reconciliationVersions ??
                {}) as Record<string, number>;

            for (const componentKey of components) {
                // Skip the reconciliationVersions component itself
                if (componentKey === 'reconciliationVersions') continue;

                // Apply version to this component
                versions[componentKey as string] = version;
            }

            // Update the reconciliationVersions component on the entity
            entity.willUpdate('reconciliationVersions');
            entity.components.reconciliationVersions = versions;
        }
    }

    /**
     * Resolve reconcilable actions after a network message handler has run.
     * Compares server state against our predictions and restores predicted values
     * where the server hasn't caught up yet.
     */
    function resolveReconcilableActions() {
        for (const [entityId, componentPredictions] of predictions) {
            const entity = manager.state.entities.get(entityId);
            if (!entity) {
                // Entity no longer exists, clear predictions
                predictions.delete(entityId);
                continue;
            }

            const serverVersions = (entity.components.reconciliationVersions ??
                {}) as Record<string, number>;

            for (const [
                componentKey,
                { version, strategy },
            ] of componentPredictions) {
                const serverVersion = serverVersions[componentKey] ?? 0;

                if (version > serverVersion) {
                    // Our prediction is ahead - restore it from previousComponents
                    const previousValue =
                        entity.previousComponents[
                            componentKey as Keys<ComponentTypes>
                        ];

                    if (previousValue !== undefined) {
                        // Restore the predicted value
                        entity.quietSet(
                            componentKey as Keys<ComponentTypes>,
                            previousValue
                        );
                    }

                    // Restore our version number
                    const currentVersions = (entity.components
                        .reconciliationVersions ?? {}) as Record<
                        string,
                        number
                    >;
                    entity.quietSet(
                        'reconciliationVersions' as Keys<ComponentTypes>,
                        {
                            ...currentVersions,
                            [componentKey]: version,
                        } as ComponentTypes[Keys<ComponentTypes>]
                    );
                } else {
                    // Server caught up - clear this prediction
                    componentPredictions.delete(componentKey);
                }
            }

            // Clean up entity entry if no predictions remain
            if (componentPredictions.size === 0) {
                predictions.delete(entityId);
            }
        }
    }

    /**
     * Check if we have any pending predictions for an entity+component.
     * Useful for debugging or conditional logic.
     */
    function hasPendingPrediction(
        entityId: EntityId,
        componentKey?: string
    ): boolean {
        const entityPredictions = predictions.get(entityId);
        if (!entityPredictions) return false;
        if (componentKey) return entityPredictions.has(componentKey);
        return entityPredictions.size > 0;
    }

    /**
     * Clear all predictions. Useful for reconnection scenarios.
     */
    function clearAllPredictions() {
        predictions.clear();
    }

    return {
        predictions,
        getNextVersion,
        trackReconcilableAction,
        applyReconciliationVersion,
        resolveReconcilableActions,
        hasPendingPrediction,
        clearAllPredictions,
    };
});
