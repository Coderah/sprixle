import em from './entityManager';

export const meshQuery = em.createQuery({
    includes: ['type'],
    excludes: ['mesh'],
});

export const velocityQuery = em.createQuery({
    includes: ['position', 'velocity'],
});

console.log(velocityQuery);
