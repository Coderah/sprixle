# Goal
The intent of the blender addon is to utilize Blender as an integrated editor for Sprixle games.

# Supported

### GLTF as baseline
Anything that the standard [GLTF exporter](https://docs.blender.org/manual/en/2.80/addons/io_scene_gltf2.html) supports will work, modifiers will be applied on export. 

### Materials
Via the `ShaderTreePlugin` material nodes can be compiled directly to GLSL.

Depth test/write can be configured with `Configure Material`

Displacement is mostly supported.

Image Textures are auto exported and will be loaded.

Supported nodes are documented [here](plugins\shaderTree\supported-nodes.md).

*real-time supported with `enableNodeTreeBlenderConnection`*

### Geometry Nodes
Only supported at export time (not real-time in engine). Though to some degree real-time support is planned.

### Logic Trees
Any Geometry Nodes tree that is tagged `+logic` will be exported and when utilizing `LogicTreePlugin` they will compile to systems. The Asset library contains low-level generic logic nodes with [basic implementations](plugins\logicTree\implemented-nodes.md).

The intended goal is that you create and implement your own logic nodes. When instantiating the plugin you can write 1-to-1 implementations of nodes.

*real-time supported with `enableNodeTreeBlenderConnection`*

# Planned Support

### Materials
Currently materials don't handle some configurations. Control over things like backface culling and transparency will be added. Reasonable defaults / guesses are set in the mean-time.

### World Material (backgrounds)
World material nodes can be compiled as a shader or baked. I also plan to bake MIP-based environment map hacks. HDRIs and such currently rely on very expensive equirectangular samples, instead we will have two maps one blurred one unblurred and sample them using roughness irradiance estimation. see [shadertoy example](https://www.shadertoy.com/view/4sSfzK)

### Compositor nodes [in progress]
Along with a `ThreeRendererPlugin` and likely `ThreeCompositorPlugin` I will implement and support compositor nodes for post-processing. things like Bloom, Glare, Kuwahara, and other filters. As well as basic image manipulation. Some nodes like Color Ramp will be supported purely because this is just another shader tree.

### Realtime Geometry
Eventually we will implement real-time Geometry updates. This will require `ThreeGeometryPlugin`, `ThreeScenePlugin` and `ThreePrefabsPlugin` (* if used with prefabs)

### Animation
While animations are exported using the GLTF exporter, and available for use through three.js Animation apis. I intend to understand a solid re-usable workflow and make a plugin for better re-using and optimizing keyframe animations.

Crucially I will also be adding keyframe support for things like animated shaders (per object uniforms will likely be utilized)

* for reference new 4.4 slotted_actions https://developer.blender.org/docs/release_notes/4.4/upgrading/slotted_actions

### Shape Keys
Because we rely on "apply modifiers at export" we will try to support Shape Keys being exported with a custom data structure. I have not looked into this in detail but there is no reason it should not be possible.

*idea* there's also something interesting about https://docs.blender.org/api/current/bpy.ops.object.html#bpy.ops.object.modifier_apply_as_shapekey