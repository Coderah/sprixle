// TODO add reuseMaterial
// TODO add purgeMaterials
// TODO

import {
    BatchedMesh,
    Euler,
    InstancedMesh,
    Material,
    Matrix3,
    Matrix4,
    Mesh,
    Object3D,
    Points,
    Texture,
} from 'three';
import { defaultComponentTypes, Manager } from '../../ecs/manager';
import { Pipeline } from '../../ecs/system';
import uuid from 'uuid-random';
import { BatchedObject3DRef } from './BatchedMeshManager';

export type MaterialManagerComponentTypes = {
    object3D: Object3D;
    material: Material;
    depthMaterial: Material;
    materialName: string;
    // TODO ability to tag for singleton use only?
    environmentMap: Texture;
};

function objectWithMaterial(o: Object3D) {
    if (o instanceof BatchedObject3DRef) {
        return o._manager.getBatchedMesh(o);
    }

    if (
        !(
            (o instanceof Mesh ||
                o instanceof InstancedMesh ||
                o instanceof BatchedMesh ||
                o instanceof Points) &&
            o.material
        )
    ) {
        return null;
    }

    return o;
}

export function applyMaterialManagerPlugin<
    M extends Manager<ComponentTypes>,
    ComponentTypes extends defaultComponentTypes & MaterialManagerComponentTypes
>(em: M, components: Array<keyof ComponentTypes> = ['object3D']) {
    const objectQuery = em.createQuery({
        includes: components,
        flexible: true,
    });

    const materialQuery = em.createQuery({
        includes: ['material', 'materialName'],
    });

    function reuseMaterial(object: ReturnType<typeof objectWithMaterial>) {
        const material = object.material;

        if (!material) return;

        // TODO: use query indexing and lookup
        const existingMaterial = materialQuery.find(
            (e) => e.components.materialName === material.name
        );

        if (!existingMaterial) {
            useMaterial(material, object.customDepthMaterial);
            return;
        }

        object.material = existingMaterial.components.material;
        if (existingMaterial.components.depthMaterial) {
            object.customDepthMaterial =
                existingMaterial.components.depthMaterial;
            object.customDistanceMaterial =
                existingMaterial.components.depthMaterial;
        } else {
            object.customDepthMaterial = undefined;
            object.customDistanceMaterial = undefined;
        }
    }

    function useMaterial(material: Material, depthMaterial?: Material) {
        if (!material.name) {
            console.warn(
                '[MaterialManagerPlugin] material has no name, an id will be generated. Re-use of this material will be impossible.',
                material
            );
            material.name = uuid();
        }

        applyEnvironmentMapToMaterial(material);

        // TODO @ts-ignore
        const newMaterialEntity = em.quickEntity(
            {
                material,
                materialName: material.name,
            },
            'material' + material.name
        );

        if (depthMaterial) {
            newMaterialEntity.components.depthMaterial = depthMaterial;
        }

        return material;
    }

    function applyEnvironmentMapToMaterial(material: Material) {
        const environmentMap = em.getSingletonEntityComponent('environmentMap');
        if (environmentMap && !material.envMap) {
            material.envMapRotation = new Euler();
            material.envMap = environmentMap;
            material.envMapIntensity = 1.0;
            if (material.uniforms) {
                material.uniforms.envMap = {
                    value: environmentMap,
                };
                material.uniforms.envMapRotation = {
                    value: new Matrix3(),
                };
                material.uniforms.flipEnvMap = {
                    value: 1.0,
                };
                material.needsUpdate = true;
                material.uniformsNeedUpdate = true;
            }
            console.log('add environment map to material', material);
        }
    }

    function garbageCollectMaterials() {
        const inUseMaterials = new Set<string>();

        for (let entity of objectQuery) {
            for (let component of components) {
                const object3D = entity.components[component];
                if (!object3D) continue;

                object3D.traverse((o) => {
                    const object = objectWithMaterial(o);
                    if (!object) return;

                    inUseMaterials.add(object.material.name);
                });
            }
        }

        for (let materialEntity of materialQuery) {
            const { materialName, material } = materialEntity.components;

            if (!inUseMaterials.has(materialName)) {
                console.log(
                    '[MaterialManager] releasing material',
                    materialName
                );
                // TODO actually dispose?
                em.deregisterEntity(materialEntity);
            }
        }
    }

    const objectSystem = em.createSystem(objectQuery.createConsumer(), {
        forNew(entity) {
            // TODO traverse
            for (let component of components) {
                const object3D = entity.components[component];
                if (!object3D) continue;
                object3D.traverse((o) => {
                    const object = objectWithMaterial(o);

                    if (!object) return;

                    // TODO dedupe work in materialSystem somehow?
                    reuseMaterial(object);
                });
            }
        },
    });

    const materialConsumer = materialQuery.createConsumer();
    const materialSystem = em.createSystem(materialConsumer, {
        newOrUpdated(entity) {
            const { material, depthMaterial, materialName } = entity.components;

            // remove older instances
            for (let materialEntity of materialQuery) {
                if (
                    materialEntity !== entity &&
                    materialEntity.components.materialName === materialName
                ) {
                    if (
                        materialConsumer.newEntities.has(materialEntity.id) ||
                        materialConsumer.updatedEntities.has(materialEntity.id)
                    ) {
                        // Ensures newest entity wins
                        return;
                    }
                    em.deregisterEntity(materialEntity);
                }
            }

            applyEnvironmentMapToMaterial(material);
            for (let objectEntity of objectQuery) {
                for (let component of components) {
                    const object3D = objectEntity.components[component];
                    if (!object3D) continue;
                    object3D.traverse((o) => {
                        const object = objectWithMaterial(o);

                        if (
                            !object ||
                            object.material.name !== materialName ||
                            object.material === material
                        )
                            return;

                        object.material.dispose();

                        // TODO apply in more situations more appropriately
                        // console.log(
                        //     '[materialManagerPlugin] swapped new material',
                        //     object,
                        //     material
                        // );

                        object.material = material;
                        if (depthMaterial) {
                            object.customDepthMaterial = depthMaterial;
                            object.customDistanceMaterial = depthMaterial;
                        } else {
                            object.customDepthMaterial = undefined;
                            object.customDistanceMaterial = undefined;
                        }
                    });
                }
            }
        },
        removed(entity) {
            entity.components.material.dispose();
        },
    });

    const materialPipeline = new Pipeline(em, materialSystem, objectSystem);
    materialPipeline.tag = 'materialPipeline';

    return {
        useMaterial,
        reuseMaterial,
        garbageCollectMaterials,
        materialPipeline,
    };
}
