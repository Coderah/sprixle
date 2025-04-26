import { BufferAttribute, Material, Mesh, Object3D } from 'three';

export function applyExportedAttributes(mesh: Mesh) {
    const { geometry } = mesh;

    for (let key in mesh.userData) {
        const features = getFeaturesFromName(key);

        if (features.attribute) {
            const list = JSON.parse(mesh.userData[key]);

            if (typeof list[0] === 'number') {
                // TODO determine float vs int?

                geometry.setAttribute(
                    features.reference,
                    new BufferAttribute(new Float32Array(list), 1)
                );
            } else {
                console.warn(
                    '[applyExportedAttributes] need to add support for attribute',
                    key,
                    'of type'
                );
            }
        }
    }
}

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
        reference: string;
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
