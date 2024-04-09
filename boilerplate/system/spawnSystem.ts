import { Vector3 } from 'three';
import { interval } from '../../util/timing';
import em from '../entityManager';

const time = interval(16.7);
let runs = 0;
export function spawnSystem(delta: number) {
    if (runs < 1 && time(delta)) {
        for (let i = 0; i < 1000; i++) {
            const entity = em.createEntity();
            em.addComponents(entity, {
                type: 'cube',
                position: new Vector3(
                    Math.random() * 30,
                    Math.random() * 30,
                    Math.random() * 30
                ),
                velocity: new Vector3(
                    -0.15 + Math.random() * 0.25,
                    -0.05 + Math.random() * 0.15,
                    -0.15 + Math.random() * 0.25
                ),
            });
            em.registerEntity(entity);
        }
        runs++;
    }
}
