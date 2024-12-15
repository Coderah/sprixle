import { CanvasTexture, NearestFilter, RepeatWrapping, Texture } from 'three';

export interface ColorStop {
    position: number;
    color: [number, number, number, number]; // RGBA
}

export enum InterpolationType {
    LINEAR,
    CONSTANT,
    EASE,
    /** TODO: not yet implemented */
    B_SPLINE,
}

// TODO add memoization through data hashing
const LUT_SIZE = 257;
export function createColorRampLUT(
    colorRampData: ColorStop[],
    interpolationType: InterpolationType = InterpolationType.LINEAR
) {
    // TODO remove hack for test code
    // if (typeof document === 'undefined') return new Texture();
    const canvas = document.createElement('canvas');
    canvas.width = LUT_SIZE;
    canvas.height = 1;
    const context = canvas.getContext('2d')!;

    const imageData = context.createImageData(LUT_SIZE, 1);
    const data = imageData.data;

    for (let i = 0; i < LUT_SIZE; i++) {
        const position = i / (LUT_SIZE - 1);

        let currentStopIndex = 0;
        while (
            currentStopIndex < colorRampData.length - 1 &&
            colorRampData[currentStopIndex + 1].position < position
        ) {
            currentStopIndex++;
        }

        const startStop = colorRampData[currentStopIndex];
        const endStop = colorRampData[currentStopIndex + 1] || {
            position: 1,
            color: startStop.color,
        };

        let r: number,
            g: number,
            b: number,
            a: number,
            t: number = 0;
        switch (interpolationType) {
            case InterpolationType.LINEAR:
                t =
                    (position - startStop.position) /
                    (endStop.position - startStop.position);
                r = startStop.color[0] * (1 - t) + endStop.color[0] * t;
                g = startStop.color[1] * (1 - t) + endStop.color[1] * t;
                b = startStop.color[2] * (1 - t) + endStop.color[2] * t;
                a = startStop.color[3] * (1 - t) + endStop.color[3] * t;
                break;
            case InterpolationType.CONSTANT:
                r =
                    position >= endStop.position
                        ? endStop.color[0]
                        : startStop.color[0];
                g =
                    position >= endStop.position
                        ? endStop.color[1]
                        : startStop.color[1];
                b =
                    position >= endStop.position
                        ? endStop.color[2]
                        : startStop.color[2];
                a =
                    position >= endStop.position
                        ? endStop.color[3]
                        : startStop.color[3];
                break;
            case InterpolationType.EASE:
                t =
                    position < endStop.position
                        ? Math.pow(position / endStop.position, 2)
                        : 1;
                r = startStop.color[0] * (1 - t) + endStop.color[0] * t;
                g = startStop.color[1] * (1 - t) + endStop.color[1] * t;
                b = startStop.color[2] * (1 - t) + endStop.color[2] * t;
                a = startStop.color[3] * (1 - t) + endStop.color[3] * t;
                break;
            case InterpolationType.B_SPLINE:
                throw new Error(
                    '[createColorRampLUT] B_SPLINE is not yet implemented'
                );
        }

        const index = i * 4;
        data[index] = r * 255;
        data[index + 1] = g * 255;
        data[index + 2] = b * 255;
        data[index + 3] = a * 255;
    }

    imageData.data.set(data);
    context.putImageData(imageData, 0, 0);

    const texture = new CanvasTexture(canvas);
    texture.wrapS = texture.wrapT = RepeatWrapping;
    texture.magFilter = texture.minFilter = NearestFilter;
    texture.needsUpdate = true;

    return texture;
}
