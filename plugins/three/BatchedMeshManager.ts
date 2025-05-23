import {
    Object3D,
    Mesh,
    BufferGeometry,
    Material,
    BatchedMesh,
    Matrix4,
    Group,
    Raycaster,
    Intersection,
    Ray,
} from 'three';

// Define some default values for max counts if not provided
const DEFAULT_MAX_INSTANCE_COUNT = 100;
const DEFAULT_MAX_VERTEX_COUNT = 400000;
const DEFAULT_MAX_INDEX_COUNT = 500000;

/**
 * A reference object that extends Object3D but internally manages its matrix
 * for batched rendering. It acts as an opaque layer, allowing interaction
 * with standard Object3D APIs.
 */
export class BatchedObject3DRef extends Object3D {
    _manager: BatchedMeshManager | null = null;
    _geometry: BufferGeometry | null = null;
    _material: Material | Material[] | null = null;
    _batchId: number = -1;
    _geometryId: number = -1;
    // TODO store reference to original geometry, and handle meshBVH / bounding box stuff.

    constructor() {
        super();
    }

    /**
     * @internal Sets the internal batching manager and relevant data.
     * Should only be called by the BatchedMeshManager.
     */
    _setBatchData(
        manager: BatchedMeshManager,
        geometry: BufferGeometry,
        material: Material | Material[],
        geometryId: number,
        batchId: number
    ): void {
        this._manager = manager;
        this._geometry = geometry;
        this._material = material;
        this._geometryId = geometryId;
        this._batchId = batchId;
    }

    /**
     * Updates the corresponding matrix in the BatchedMesh.
     * @override
     */
    updateMatrixWorld(force?: boolean): void {
        const needsUpdate = this.matrixWorldNeedsUpdate || force;

        super.updateMatrixWorld(force);
        if (
            needsUpdate &&
            this._manager &&
            this._batchId !== -1 &&
            this._geometryId !== -1
        ) {
            this._manager.updateInstanceMatrix(
                this,
                this._geometryId,
                this._batchId
            );
        }
    }

    // remove(...object: Object3D[]): this {
    //     super.remove(...object);

    //     return this;
    // }

    /**
     * Intersects the object with the ray.
     * @param raycaster The raycaster to use for intersection.
     * @param intersects An array to store the intersection results.
     */
    raycast(raycaster: Raycaster, intersects: Intersection[]): void {
        if (this._manager && this._geometryId !== -1 && this._batchId !== -1) {
            const material = this._material;
            const materialKey = this._manager.getMaterialKey(material);
            const batchedMesh = this._manager.batchedMeshes.get(materialKey);

            if (batchedMesh) {
                // const worldMatrixInverse = new Matrix4().copy(batchedMesh.matrixWorld).invert();
                // const ray = new Ray().copy(raycaster.ray).applyMatrix4(worldMatrixInverse);

                const localIntersects = raycaster.intersectObject(batchedMesh);

                for (let i = 0; i < localIntersects.length; i++) {
                    const intersection = localIntersects[i];
                    if (intersection.batchId === this._batchId) {
                        intersection.object = this;
                        intersection.batchId = undefined; // Remove the internal instanceId
                        intersects.push(intersection);
                    }
                }
            }
        }
    }

    /**
     * Disposes of this batched ref and its entire hierarchy
     */
    dispose() {
        this.removeFromParent();
        this.traverse((o) => {
            if (o instanceof BatchedObject3DRef) {
                this._manager.disposeBatchedRef(o, o._batchId);
            }
        });
    }
}

/**
 * Manages BatchedMesh instances and BatchedObject3DRef objects for efficient
 * rendering of object hierarchies.
 */
export class BatchedMeshManager extends Object3D {
    batchedMeshes: Map<string, BatchedMesh> = new Map();
    _geometryCache: Map<BufferGeometry, number> = new Map();

    maxInstanceCount: number;
    maxVertexCount: number;
    maxIndexCount: number;

    constructor(
        maxInstanceCount = DEFAULT_MAX_INSTANCE_COUNT,
        maxVertexCount = DEFAULT_MAX_VERTEX_COUNT,
        maxIndexCount = DEFAULT_MAX_INDEX_COUNT
    ) {
        super();
        this.name = 'BatchedMeshManager';

        this.maxInstanceCount = maxInstanceCount;
        this.maxVertexCount = maxVertexCount;
        this.maxIndexCount = maxIndexCount;
    }

    /**
     * Recursively processes an Object3D hierarchy and converts Mesh objects
     * into BatchedObject3DRef objects, adding their geometry to the appropriate
     * BatchedMesh instances.
     *
     * @param object The root of the Object3D hierarchy to add.
     * @returns The root of the processed hierarchy (can be a BatchedObject3DRef or the original Object3D/Group).
     */
    batch(object: Object3D): Object3D {
        const processObject = (obj: Object3D): Object3D => {
            if (obj instanceof Mesh) {
                // console.log('[BatchedMeshManager] batching within hierarchy', {
                //     topLevel: object.userData.name,
                //     object: obj.userData.name,
                // });
                const geometry = obj.geometry as BufferGeometry; // Explicitly cast to BufferGeometry
                const material = obj.material;
                const materialKey = this.getMaterialKey(material);

                let batchedMesh = this.batchedMeshes.get(materialKey);

                if (!batchedMesh) {
                    batchedMesh = new BatchedMesh(
                        this.maxInstanceCount,
                        this.maxVertexCount,
                        this.maxIndexCount,
                        material
                    );
                    batchedMesh.layers.mask = obj.layers.mask;
                    batchedMesh.sortObjects = false;
                    batchedMesh.perObjectFrustumCulled = false;
                    // batchedMesh.frustumCulled = false;
                    this.batchedMeshes.set(materialKey, batchedMesh);
                    this.add(batchedMesh); // Add the BatchedMesh to the manager's scene graph
                }

                let geometryId = this._geometryCache.get(geometry);
                if (geometryId === undefined) {
                    geometryId = batchedMesh.addGeometry(geometry);
                    this._geometryCache.set(geometry, geometryId);

                    // batchedMesh.computeBoundsTree(geometryId);
                }
                // console.log('[BatchedMeshManager] geometryId', {
                //     batchedMesh,
                //     geometryId,
                //     geometry,
                // });

                const batchId = batchedMesh.addInstance(geometryId);

                const batchedRef = new BatchedObject3DRef();
                batchedRef.name = obj.name;
                batchedRef.userData = obj.userData;
                batchedRef.matrixAutoUpdate = false;
                batchedRef.position.copy(obj.position);
                batchedRef.rotation.copy(obj.rotation);
                batchedRef.matrix.copy(obj.matrix);
                batchedRef._setBatchData(
                    this,
                    geometry,
                    material,
                    geometryId,
                    batchId
                );

                for (let i = 0; i < obj.children.length; i++) {
                    const child = obj.children[i];
                    const batchedChild = processObject(child);
                    batchedRef.add(batchedChild);
                }

                return batchedRef; // Return the BatchedObject3DRef so it's added to the hierarchy
            } else if (obj instanceof Group || obj instanceof Object3D) {
                const cloned = obj.clone(false); // Create a shallow clone to preserve the type
                for (let i = 0; i < obj.children.length; i++) {
                    const child = obj.children[i];
                    const batchedChild = processObject(child);
                    cloned.add(batchedChild);
                }
                return cloned;
            } else {
                // TODO handle first object not loopable
                return obj;
                // throw new Error(
                //     'BatchedMeshManager: Only Mesh, Group, and Object3D are supported for batching.'
                // );
            }
        };

        return processObject(object);
    }

    getBatchedMesh(batchedRef: BatchedObject3DRef) {
        const material = batchedRef._material;
        if (material) {
            const materialKey = this.getMaterialKey(material);
            const batchedMesh = this.batchedMeshes.get(materialKey);

            return batchedMesh;
        }
    }

    disposeBatchedRefs(object: Object3D) {
        object.traverse((o) => {
            if (o instanceof BatchedObject3DRef) {
                this.disposeBatchedRef(o, o._batchId);
            }
        });
    }

    disposeBatchedRef(batchedRef: BatchedObject3DRef, batchId: number) {
        this.getBatchedMesh(batchedRef).deleteInstance(batchId);
    }

    /**
     * Updates the instance matrix of a BatchedObject3DRef in its corresponding
     * BatchedMesh.
     *
     * @internal
     * @param batchedRef The BatchedObject3DRef whose matrix needs updating.
     * @param geometryId The ID of the geometry in the BatchedMesh.
     * @param batchId The ID of the instance in the BatchedMesh.
     */
    updateInstanceMatrix(
        batchedRef: BatchedObject3DRef,
        geometryId: number,
        batchId: number
    ): void {
        this.getBatchedMesh(batchedRef).setMatrixAt(
            batchId,
            batchedRef.matrixWorld
        );
    }

    getMaterialKey(material: Material | Material[]): string {
        let key: string;
        if (Array.isArray(material)) {
            key = `materials-${material.map((m) => m.name).join('-')}`;
        } else {
            key = `material-${material.name}`;
        }
        return key;
    }
}
