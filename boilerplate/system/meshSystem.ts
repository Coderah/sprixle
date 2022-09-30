import {
    BufferGeometry,
    Mesh,
    MeshStandardMaterial,
    Object3D,
} from 'three';
import em from '../entityManager';
import { scene } from '../scene';

const objectMaterial = new MeshStandardMaterial({
    metalness: 0,
    roughness: 1.2,
    color: 0x232323,
});

export const models: { [key: string]: Object3D } = {
};

export function meshSystem(state: typeof em.State, delta: number) {
    const entityMap = state.entityMap;
    const typeEntities = entityMap.get('type');
    const meshEntities = entityMap.get('mesh') || new Set;

    if (!typeEntities) return state;

    typeEntities.subtract(meshEntities).forEach((id) => {
        let entity = em.getEntity(state, id);
        if (!entity) return;
        const position = entity.components.position;
        const type = entity.components.type;

        if (!type) return;

        let mesh: Mesh<BufferGeometry, MeshStandardMaterial> | null = null;
        if (type in models) {
            if (models[type] === null) return;
            mesh = models[type].clone() as Mesh<
                BufferGeometry,
                MeshStandardMaterial
            >;
        }

        if (mesh) {
            if (position) mesh.position.copy(position);
            scene.add(mesh);
            entity = em.addComponent(entity, 'mesh', mesh);

            state = em.registerEntity(state, entity);
        }
    });

    return state;
}