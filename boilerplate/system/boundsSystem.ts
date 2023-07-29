import { Vector3 } from 'three';
import em from '../entityManager';
import { velocityQuery } from '../queries';

const consumer = velocityQuery.createConsumer();

const bounds = new Vector3(100, 100, 100);

export function boundsSystem(delta: number) {
    consumer.forUpdated((entity) => {
        const { position } = entity.components;

        if (position.x > bounds.x || position.x < -bounds.x) {
            position.setX(-position.x + 1);
        }
        if (position.y > bounds.y || position.y < -bounds.y) {
            position.setY(-position.y + 1);
        }
        if (position.z > bounds.z || position.z < -bounds.z) {
            position.setZ(-position.z + 1);
        }
    });
}
