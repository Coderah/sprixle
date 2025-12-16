import { Vector3 } from 'three';
import em from '../entityManager';
import { velocityQuery } from '../queries';

const consumer = velocityQuery.createConsumer();

const bounds = new Vector3(100, 100, 100);

export function boundsSystem(delta: number) {
    consumer.forUpdated((entity) => {
        const { position, velocity } = entity.components;

        if (!position || !velocity) return;

        if (position.x > bounds.x || position.x < -bounds.x) {
            entity.willUpdate('velocity');
            velocity.setX(-velocity.x);
        }
        if (position.y > bounds.y || position.y < -bounds.y) {
            entity.willUpdate('velocity');
            velocity.setY(-velocity.y);
        }
        if (position.z > bounds.z || position.z < -bounds.z) {
            entity.willUpdate('velocity');
            velocity.setZ(-velocity.z);
        }
    });
}
