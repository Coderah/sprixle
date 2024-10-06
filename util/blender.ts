import { Material, Object3D } from 'three';

export function getFeaturesFromName(o: {
    name: string;
    userData?: Object3D['userData'];
    material?: Material;
}) {
    const features: {
        [key: string]: boolean | string;
    } = {};

    Array.from(
        (
            ((o.userData?.name as string) || o.name) +
            ' ' +
            ((o.material?.userData.name as string) || o.material?.name || '')
        ).matchAll(/\+([\w]+)(?:\(([\w-]+)\))?/gi)
    ).forEach((m) => {
        if (m[1]) {
            features[m[1]] = m[2] || true;
        }
    });

    return features;
}
