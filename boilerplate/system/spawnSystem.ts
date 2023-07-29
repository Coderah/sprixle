import { Vector3 } from 'three';
import { interval } from '../../util/timing';
import em from '../entityManager';

const time = interval(16.7);
let runs = 0;
export function spawnSystem(delta: number) {
    if (runs < 500 && time(delta)) {
        const entity = em.createEntity();
        em.addComponents(entity, {
            type: 'cube',
            position: new Vector3(
                Math.random() * 30,
                Math.random() * 30,
                Math.random() * 30
            ),
            velocity: new Vector3(
                Math.random() * 0.5,
                Math.random() * 0.5,
                Math.random() * 0.5
            ),
        });
        em.registerEntity(entity);
        runs++;
    }
}
