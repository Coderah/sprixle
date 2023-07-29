import em from '../entityManager';
import { velocityQuery } from '../queries';

const consumer = velocityQuery.createConsumer();

export function velocitySystem(delta: number) {
    consumer.forUpdated((entity) => {
        entity.components.position?.add(entity.components.velocity);
        em.updatedEntity(entity);
    });
}
