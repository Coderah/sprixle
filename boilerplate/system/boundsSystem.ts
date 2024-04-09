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
            velocity.setX(-velocity.x);
            entity.flagUpdate('velocity');
        }
        if (position.y > bounds.y || position.y < -bounds.y) {
            velocity.setY(-velocity.y);
            entity.flagUpdate('velocity');
        }
        if (position.z > bounds.z || position.z < -bounds.z) {
            velocity.setZ(-velocity.z);
            entity.flagUpdate('velocity');
        }
    });
}
