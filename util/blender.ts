import { Object3D } from 'three';

export function getFeaturesFromName(o: {
    name: string;
    userData?: Object3D['userData'];
}) {
    const features: {
        [key: string]: boolean | string;
    } = {};

    Array.from(
        ((o.userData?.name as string) || o.name).matchAll(
            /\+([\w]+)(?:\(([\w]+)\))?/gi
        )
    ).forEach((m) => {
        if (m[1]) {
            features[m[1]] = m[2] || true;
        }
    });

    return features;
}
