import em from '../entityManager';
import { velocityQuery } from '../queries';

const consumer = velocityQuery.createConsumer();

export function velocitySystem(delta: number) {
    consumer.forUpdated((entity) => {
        const { velocity } = entity.components;
        if (!velocity) return;

        entity.components.position?.add(velocity);
        entity.flagUpdate('position');
    });
}
