import { Material, Object3D } from 'three';

export function getFeaturesFromName(
    o:
        | string
        | {
              name: string;
              userData?: Object3D['userData'];
              material?: Material;
          }
) {
    const name =
        typeof o === 'string'
            ? o
            : ((o.userData?.name as string) || o.name) +
              ' ' +
              ((o.material?.userData.name as string) || o.material?.name || '');

    const features: {
        [key: string]: boolean | string;
    } = {
        reference: name.includes('+')
            ? name.substring(0, name.indexOf('+'))
            : name,
    };

    Array.from(name.matchAll(/\+([\w]+)(?:\(([\w-]+)\))?/gi)).forEach((m) => {
        if (m[1]) {
            features[m[1]] = m[2] || true;
        }
    });

    return features;
}
