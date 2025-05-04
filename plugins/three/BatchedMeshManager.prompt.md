We are going to write typescript classes to abstract batched rendering of three.js object hierarchies.

You will need to create two classes, one is just the parent Object3D that creates a `BatchedMesh` objects per material internally and manages them. The other is `BatchedObject3DRef` that will extend `Object3D` and be used to calculate `matrix` as well as operate as an opaque API layer to allow us to interact with standard `Object3D` apis while internally the matrix is utilized for the batched mesh rendering.

The manager class will need to have a custom add method that returns a `BatchedObject3DRef` tree given whatever hierarchy was passed in. We will re-use geometries if a previous `Mesh` was added that utilizes the same `Geometry`

The manager class will handle updating each batched reference's matrix within the correct `BatchedMesh` when rendering

Batching will need to be dynamic, as objects will also be destroyed/removed. However because `BatchedObject3DRef` doesn't extend `Mesh` you won't be able to change geometries so once added to batch the geometry becomes static.

utilize the internal three.js `BatchedMesh`

NOTE: we only need to convert `Mesh` to `BatchedObject3DRef` and other types (that aren't `Group` or `Object3D`) should throw an error.





Do you see any issues with this approach? do you have a full understanding of the intent and approach and if not, what else needs to be included?




`BatchedObject3DRef` should disallow re-parenting?