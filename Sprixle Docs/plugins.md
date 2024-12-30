## Functions

- [applyDeathEffectPlugin](#applydeatheffectplugin)
- [applyEditorUIPlugin](#applyeditoruiplugin)
- [applyInputPlugin](#applyinputplugin)
- [applyStateMachinePlugin](#applystatemachineplugin)
- [applyTweenPlugin](#applytweenplugin)
- [applyMaterialManagerPlugin](#applymaterialmanagerplugin)
- [applyLogicTreePlugin](#applylogictreeplugin)
- [applyShaderTreePlugin](#applyshadertreeplugin)

### applyDeathEffectPlugin

Creates a system for death side-effects, an entities death can cause components to be applied to a different entity.

| Function | Type |
| ---------- | ---------- |
| `applyDeathEffectPlugin` | `<M extends Manager<ComponentTypes>, ComponentTypes extends defaultComponentTypes and DeathEffectComponents<ComponentTypes>>(manager: M) => { deathEffectQuery: Query<ComponentTypes, "deathEffect"[], Manager<...>, EntityWithComponents<...>>; deathEffectSystem: ConsumerSystem<...>; }` |

### applyEditorUIPlugin

| Function | Type |
| ---------- | ---------- |
| `applyEditorUIPlugin` | `<ComponentTypes extends defaultComponentTypes>(manager: Manager<ComponentTypes>) => { pipeline: Pipeline<ComponentTypes>; tweakpane: Pane; addDeltaGraph(): { ...; }; addComponentBinding<Component extends keyof ComponentTypes>(component: Component, options?: Partial<...>, query?: Query<...>, parent?: Pane or ... 1 mor...` |

### applyInputPlugin

| Function | Type |
| ---------- | ---------- |
| `applyInputPlugin` | `<ComponentTypes extends defaultComponentTypes and InputComponents>(manager: Manager<ComponentTypes>, options?: InputPluginOptions or undefined) => { ...; }` |

### applyStateMachinePlugin

| Function | Type |
| ---------- | ---------- |
| `applyStateMachinePlugin` | `<ComponentTypes extends defaultComponentTypes and StateMachineComponents<T, StateName>, T extends string or number, STATES extends Enum<T> = Enum<T>, StateName extends string = "state", M extends Manager<ComponentTypes> = Manager<ComponentTypes>, E extends EntityWithComponents<ComponentTypes, M, StateName or `${StateNam...` |

### applyTweenPlugin

| Function | Type |
| ---------- | ---------- |
| `applyTweenPlugin` | `<ComponentTypes extends defaultComponentTypes and TweenComponents<ComponentTypes>>(manager: Manager<ComponentTypes>) => { tweenerQuery: Query<ComponentTypes, "tweenTargetId"[], Manager<...>, EntityWithComponents<...>>; tweenSystem: QuerySystem<...>; tween<C extends Keys<ComponentTypes>, V extends number or number[]>(en...` |

### applyMaterialManagerPlugin

| Function | Type |
| ---------- | ---------- |
| `applyMaterialManagerPlugin` | `<M extends Manager<ComponentTypes>, ComponentTypes extends defaultComponentTypes and MaterialManagerComponenTypes>(em: M) => { useMaterial: (material: Material) => Material; reuseMaterial: (object: Object3D<...> or null) => void; garbageCollectMaterials: () => void; materialPipeline: Pipeline<...>; }` |

### applyLogicTreePlugin

| Function | Type |
| ---------- | ---------- |
| `applyLogicTreePlugin` | `<C extends defaultComponentTypes and LogicTreeComponentTypes<C>, M extends LogicTreeMethods>(em: Manager<C>, methods: M, methodsType?: ReceiveType<M> or undefined) => { ...; }` |

### applyShaderTreePlugin

This plugin handles compiling and applying ShaderTree format (from blender addon)

| Function | Type |
| ---------- | ---------- |
| `applyShaderTreePlugin` | `<C extends defaultComponentTypes and ShaderTreeComponentTypes, M extends {}>(em: Manager<C>, transpilerMethods: M, methodsType?: ReceiveType<M> or undefined) => ConsumerSystem<...>` |


