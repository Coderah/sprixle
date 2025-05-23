## Functions

- [applyDeathEffectPlugin](#applydeatheffectplugin)
- [applyEditorUIPlugin](#applyeditoruiplugin)
- [applyInputPlugin](#applyinputplugin)
- [applyStateMachinePlugin](#applystatemachineplugin)
- [applyTweenPlugin](#applytweenplugin)
- [applyLogicTreePlugin](#applylogictreeplugin)
- [applyMaterialManagerPlugin](#applymaterialmanagerplugin)
- [applyShaderTreePlugin](#applyshadertreeplugin)

### applyDeathEffectPlugin

Creates a system for death side-effects, an entities death can cause components to be applied to a different entity.

| Function | Type |
| ---------- | ---------- |
| `applyDeathEffectPlugin` | `<M extends Manager<ComponentTypes>, ComponentTypes extends defaultComponentTypes and DeathEffectComponents<ComponentTypes>>(manager: M) => { deathEffectQuery: Query<ComponentTypes, "deathEffect"[], M, keyof ComponentTypes, EntityWithComponents<...>> or Query<...>; deathEffectSystem: ConsumerSystem<...>; }` |

### applyEditorUIPlugin

| Function | Type |
| ---------- | ---------- |
| `applyEditorUIPlugin` | `<ComponentTypes extends defaultComponentTypes>(manager: Manager<ComponentTypes>) => { pipeline: Pipeline<ComponentTypes>; tweakpane: Pane; addDeltaGraph(): { ...; }; addComponentBinding<Component extends keyof ComponentTypes>(component: Component, options?: Partial<...>, query?: Query<...>, parent?: Pane or ... 2 mor...` |

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
| `applyTweenPlugin` | `<ComponentTypes extends defaultComponentTypes and TweenComponents<ComponentTypes>>(manager: Manager<ComponentTypes>) => { tweenerQuery: Query<ComponentTypes, "tweenTargetId"[], Manager<...>, keyof ComponentTypes, EntityWithComponents<...>> or Query<...>; tweenSystem: QuerySystem<...>; tween<C extends Keys<ComponentType...` |

### applyLogicTreePlugin

| Function | Type |
| ---------- | ---------- |
| `applyLogicTreePlugin` | `<C extends defaultComponentTypes and LogicTreeComponentTypes<C>, M extends LogicTreeMethods>(em: Manager<C>, methods: M, methodsType?: ReceiveType<M> or undefined) => { ...; }` |

### applyMaterialManagerPlugin

| Function | Type |
| ---------- | ---------- |
| `applyMaterialManagerPlugin` | `<M extends Manager<ComponentTypes>, ComponentTypes extends defaultComponentTypes and MaterialManagerComponentTypes>(em: M, components?: (keyof ComponentTypes)[]) => { useMaterial: (material: Material, depthMaterial?: Material or undefined) => Material; reuseMaterial: (object: Mesh<...> or ... 3 more ... or undefined) => ...` |

### applyShaderTreePlugin

This plugin handles compiling and applying ShaderTree format (from blender addon)

| Function | Type |
| ---------- | ---------- |
| `applyShaderTreePlugin` | `<C extends defaultComponentTypes and ShaderTreeComponentTypes, M extends ShaderTreeMethods>(em: Manager<C>, methods: M, methodsType?: ReceiveType<M> or undefined) => ConsumerSystem<...>` |


