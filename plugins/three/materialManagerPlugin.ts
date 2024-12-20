// TODO add reuseMaterial
// TODO add purgeMaterials
// TODO

import { InstancedMesh, Material, Mesh, Object3D, Points } from 'three';
import { defaultComponentTypes, Manager } from '../../ecs/manager';
import { Pipeline } from '../../ecs/system';
import { BatchedMesh } from 'three-stdlib';
import uuid from 'uuid-random';

export type MaterialManagerComponenTypes = {
    mesh: Object3D;
    material: Material;
    materialName: string;
};

function objectWithMaterial(o: Object3D) {
    if (
        !(
            (o instanceof Mesh ||
                o instanceof InstancedMesh ||
                o instanceof BatchedMesh ||
                o instanceof Points) &&
            o.material
        )
    )
        return null;
    return o;
}

export function applyMaterialManagerPlugin<
    M extends Manager<ComponentTypes>,
    ComponentTypes extends defaultComponentTypes & MaterialManagerComponenTypes
>(em: M) {
    const objectQuery = em.createQuery({
        includes: ['mesh'],
    });

    const materialQuery = em.createQuery({
        includes: ['material', 'materialName'],
    });

    function reuseMaterial(object: ReturnType<typeof objectWithMaterial>) {
        const material = object.material;

        if (!material) return;

        const existingMaterial = materialQuery.find(
            (e) => e.components.materialName === material.name
        );

        if (!existingMaterial) {
            useMaterial(material);
            return;
        }

        object.material = existingMaterial.components.material;
    }

    function useMaterial(material: Material) {
        if (!material.name) {
            console.warn(
                '[MaterialManagerPlugin] material has no name, an id will be generated. Re-use of this material will be impossible.',
                material
            );
            material.name = uuid();
        }
        // TODO @ts-ignore
        em.quickEntity(
            {
                material,
                materialName: material.name,
            },
            'material' + material.name
        );

        return material;
    }

    function garbageCollectMaterials() {
        const inUseMaterials = new Set<string>();

        for (let entity of objectQuery) {
            const { mesh } = entity.components;

            mesh.traverse((o) => {
                const object = objectWithMaterial(o);
                if (!object) return;

                inUseMaterials.add(object.material.name);
            });
        }

        for (let materialEntity of materialQuery) {
            const { materialName, material } = materialEntity.components;

            if (!inUseMaterials.has(materialName)) {
                em.deregisterEntity(materialEntity);
            }
        }
    }

    const objectSystem = em.createSystem(objectQuery.createConsumer(), {
        forNew(entity) {
            // TODO traverse
            const object = objectWithMaterial(entity.components.mesh);

            if (!object) return;

            // TODO dedupe work in materialSystem somehow?
            reuseMaterial(object);
        },
    });

    const materialSystem = em.createSystem(materialQuery.createConsumer(), {
        newOrUpdated(entity) {
            const { material, materialName } = entity.components;

            // remove older instances
            for (let materialEntity of materialQuery) {
                if (
                    materialEntity !== entity &&
                    materialEntity.components.materialName === materialName
                ) {
                    em.deregisterEntity(materialEntity);
                }
            }

            for (let objectEntity of objectQuery) {
                objectEntity.components.mesh.traverse((o) => {
                    const object = objectWithMaterial(o);

                    if (
                        !object ||
                        object.material.name !== materialName ||
                        object.material === material
                    )
                        return;

                    object.material.dispose();
                    object.material = material;
                });
            }
        },
        removed(entity) {
            entity.components.material.dispose();
        },
    });

    return {
        useMaterial,
        reuseMaterial,
        garbageCollectMaterials,
        materialPipeline: new Pipeline(em, materialSystem, objectSystem),
    };
}
