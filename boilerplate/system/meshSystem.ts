import {
    BufferGeometry,
    Mesh,
    MeshStandardMaterial,
    BoxGeometry,
    Object3D,
    SphereGeometry,
} from 'three';
import em from '../entityManager';
import { scene } from '../scene';
import { meshQuery } from '../queries';

const objectMaterial = new MeshStandardMaterial({
    metalness: 0,
    roughness: 1.2,
    color: 0x232323,
});

export const models: { [key: string]: Object3D } = {
    cube: new Mesh(new SphereGeometry(), objectMaterial),
};

const consumer = meshQuery.createConsumer();

export function meshSystem(delta: number) {
    consumer.forNew((entity) => {
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
        } else {
            // TODO: figure out how to handle this case, we want to consume each entity??
            consumer.consumed = false;
        }

        if (mesh) {
            if (position) {
                mesh.position.copy(position);
                entity.components.position = mesh.position; // hack.. not sure how I feel about it
            }
            scene.add(mesh);
            entity.components.mesh = mesh;
        }
    });
}
