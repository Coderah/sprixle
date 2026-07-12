# Vue / ECS Bridge

*Engine ref: f3f5215 (2026-07-05)*

Source: `plugins/vuePlugin.ts`. Reference implementation: test-pilots (`src/client/system/vuePipeline.ts` + ~70 components).

## Setup

```ts
// per-build bridge module, e.g. src/client/system/vuePipeline.ts
const { vuePipeline, useQuery, useQueryIndexedBy, useComponent, useEntity, useSingletonEntityComponent } =
    applyVuePlugin<ComponentTypes>(em, () => createApp(App).mount('#app'));
export { useQuery, useQueryIndexedBy, useComponent, useEntity, useSingletonEntityComponent };
```

Add `vuePipeline` to the frame pipeline. Components import composables **from the bridge module**, never `applyVuePlugin` directly — this is what lets a second build (role/kiosk page) swap in a mirror bridge module (different root component, stubbed app-specific refs) via a webpack import rewrite while sharing the component library.

## Composables

| Composable | Returns | Notes |
|---|---|---|
| `useQuery(query)` | `ShallowRef<ShallowRef<Entity>[]>` | Reactive list of matches. Inner ref value is `undefined` after removal. |
| `useQueryIndexedBy(query, value)` | same | One index bucket; `value` may itself be a ref. |
| `useEntity(id)` | `ShallowRef<Entity \| undefined>` | Fires on any component change. |
| `useComponent(id, key)` | `ShallowRef<value \| undefined>` | Single component. |
| `useSingletonEntityComponent(key)` | `ShallowRef<value \| undefined>` | Singleton value (thin wrapper over `useComponent`, so undefined-able). |

## Rules

1. **ECS is the state manager; Vue reads.** Mutations go through action functions, never `entity.components.x = v` inside a component event handler bound to render state (wrap it in an action).
2. **Never put entities/components in `ref()`/`reactive()`** — deep proxying ECS objects is both wrong and slow. Everything in the bridge is `shallowRef`.
3. **Sort/filter in `computed()`**, on top of the composable's value. Remember the Set-extension gotcha applies to entity sets you touch: `.map`/`.filter` → Set, `.sort()`/`.toArray()` → array.
4. Composables must be called in `setup()` so `onUnmounted` cleanup registers. The plugin tears down its per-consumer systems and watcher refs on unmount — this matters enormously under virtualized scrolling where components mount/unmount constantly; a leak means every frame iterates dead consumers.

## How it works (so you don't break it)

- The plugin installs `patchHandlers` (chaining any existing ones) and fans changes out to two registries: `componentWatchers` (id → key → Set<ref>) and `entityWatchers` (id → Set<ref>).
- `useQuery` rebuilds its array **only when query membership changes** (`consumer.newEntities.size || consumer.deletedEntities.size`), on a RAF tick. Individual entity refs update independently through the watcher registries. This membership-gating replaced an O(querySize)-per-mutation rebuild that was the dominant UI cost under load — don't "simplify" it away.
- **Each `useQuery`/`useQueryIndexedBy` call owns its own refs per entity** (a local cache), never shared across consumers. Sharing a ref across consumers caused a real bug (a consumer unmounting orphaned other consumers' refs → "reordered list doesn't move until reload").
- On entity **deregister**, refs are set to `undefined` but the watcher *sets are kept* — a deregister followed by re-register (network `SyncEntity` churn, reconnects) must keep existing watchers alive. Deleting the set froze displays in production.
- The "re-fire hack": when a new value is `===` the old, the plugin sets `ref.value = undefined` then reassigns to force shallowRef listeners to fire. Fragile but load-bearing; if you see it, leave it (or fix it properly engine-wide).

## App-level derived state: compute once at root

For expensive derived data consumed by many components (warnings, aggregates), don't give every row its own query consumer. Compute in **one** watcher installed at the app root and publish via module-level `shallowRef`s that any component imports directly:

```ts
// bridge module
export const projectWarnings = shallowRef<Warning[]>([]);
export function useProjectWarningsSource() { /* install the single watcher; called once in App root */ }
```

Module-level refs are also shared across teleported child windows that share the module registry.

## Multi-build gotchas

- A shared component library referencing app-specific refs needs those refs **stubbed** (empty `shallowRef`s) in the secondary build's bridge module, or shared components crash.
- Node-only modules (fs, project managers, history) must not be transitively importable from the browser build's root component; use the mirror-bridge + webpack `resolve.alias` stubs (`{ ws: false }`) pattern.
- Build-specific installs (history recording) should be explicit function calls in the entry, not import side effects.

## InputPlugin + Vue touch coexistence (SCAR, 2026-07-09)

**A DOM/Vue UI over `applyInputPlugin(em, { domElement: document.body })` gets all touch input swallowed on device.** The plugin's `handleTouchStart`/`handleTouchEnd` call `preventDefault()` + `stopPropagation()` + `stopImmediatePropagation()`, guarded by `event.currentTarget === domElement` — but in a *bubble* listener `currentTarget` is ALWAYS the bound element, so the guard is always true: every touch on the page has its default cancelled, killing tap→`click` synthesis (buttons, `@click`), scrolling, and card gestures. Desktop mouse is unaffected (mouse `click` survives `mousedown` preventDefault), so it only shows on phone. **Fix:** pass `allowOtherTouchEvents: true` (and usually `allowOtherMouseEvents: true`) for any UI-first app, and manage gestures on the actual play surface with CSS `touch-action: none` on that element only — not global JS preventDefault. Leave the flags off only for a full-surface game canvas that intends to swallow browser gestures. (Deeper latent bug — the `currentTarget` guard should be `target`-based — noted in engine-roadmap.md; not changed by default to avoid regressing canvas games.)
