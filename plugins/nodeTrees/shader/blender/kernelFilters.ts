import { camelCase } from 'lodash';
import { glsl } from '../../../../shader/util';
import GLSL from '../GLSL';

export type KernelType =
    | '"Soften"'
    | '"Box Sharpen"'
    | '"Laplace"'
    | '"Sobel"'
    | '"Prewitt"'
    | '"Kirsch"'
    | '"Shadow"'
    | '"Diamond Sharpen"';

type Kernel3x3 = [
    [number, number, number],
    [number, number, number],
    [number, number, number],
];

export function getKernel(type: KernelType): Kernel3x3 {
    switch (type) {
        case '"Soften"':
            return [
                [1 / 16, 2 / 16, 1 / 16],
                [2 / 16, 4 / 16, 2 / 16],
                [1 / 16, 2 / 16, 1 / 16],
            ];
        case '"Box Sharpen"':
            return [
                [-1, -1, -1],
                [-1, 9, -1],
                [-1, -1, -1],
            ];
        case '"Laplace"':
            return [
                [-1 / 8, -1 / 8, -1 / 8],
                [-1 / 8, 1, -1 / 8],
                [-1 / 8, -1 / 8, -1 / 8],
            ];
        case '"Sobel"':
            return [
                [1, 0, -1],
                [2, 0, -2],
                [1, 0, -1],
            ];
        case '"Prewitt"':
            return [
                [1, 0, -1],
                [1, 0, -1],
                [1, 0, -1],
            ];
        case '"Kirsch"':
            return [
                [5, -3, -2],
                [5, -3, -2],
                [5, -3, -2],
            ];
        case '"Shadow"':
            return [
                [1, 2, 1],
                [0, 1, 0],
                [-1, -2, -1],
            ];
        case '"Diamond Sharpen"':
            return [
                [0, -1, 0],
                [-1, 5, -1],
                [0, -1, 0],
            ];
    }
}

export function isEdgeFilter(type: KernelType): boolean {
    switch (type) {
        case '"Laplace"':
        case '"Sobel"':
        case '"Prewitt"':
        case '"Kirsch"':
            return true;
        default:
            return false;
    }
}

function formatFloat(n: number): string {
    const s = n.toString();
    return s.includes('.') ? s : s + '.0';
}

function texelOffset(
    uvReference: string,
    offsetX: number,
    offsetY: number
): string {
    if (offsetX === 0 && offsetY === 0) return uvReference;
    return `uv + texelSize * vec2(${formatFloat(offsetX)}, ${formatFloat(offsetY)})`;
}

export function filterGLSL(
    kernelType: KernelType,
    sampleFunction = 'texture2D(tDiffuse, ',
    textureSizeCall = 'textureSize(tDiffuse, 0)'
) {
    const fnReference = camelCase('filter' + kernelType);
    const kernel = getKernel(kernelType);
    const isEdge = isEdgeFilter(kernelType);

    if (isEdge) {
        const samples: string[] = [];

        for (let j = 0; j < 3; j++) {
            for (let i = 0; i < 3; i++) {
                const kx = kernel[j][i];
                const ky = kernel[i][j]; // transposed for Y direction

                if (kx === 0 && ky === 0) continue;

                const coord = texelOffset('uv', i - 1, j - 1);
                samples.push(`{ vec3 s = ${sampleFunction}${coord}).rgb;`);
                if (kx !== 0)
                    samples.push(`  color_x += s * ${formatFloat(kx)};`);
                if (ky !== 0)
                    samples.push(`  color_y += s * ${formatFloat(ky)};`);
                samples.push(`}`);
            }
        }

        const mixLine = glsl`vec4 filteredColor = vec4(mix(centerColor.rgb, magnitude, fac), centerColor.a);`;

        return [
            glsl`vec4 ${fnReference}(float fac, vec2 uv) {
            vec2 texelSize = 1.0 / vec2(${textureSizeCall});
            vec3 color_x = vec3(0.0);
            vec3 color_y = vec3(0.0);
            ${samples.join('\n')}
            vec3 magnitude = sqrt(color_x * color_x + color_y * color_y);
            vec4 centerColor = ${sampleFunction} uv);
            ${mixLine}
            return filteredColor;
        }`,
            fnReference,
        ];
    }

    const samples: string[] = [];

    for (let j = 0; j < 3; j++) {
        for (let i = 0; i < 3; i++) {
            const k = kernel[j][i];
            if (k === 0) continue;

            const coord = texelOffset('uv', i - 1, j - 1);
            samples.push(
                glsl`filteredColor += ${sampleFunction}${coord}) * ${formatFloat(k)};`
            );
        }
    }

    const factorMix = glsl`filteredColor = mix(${sampleFunction} uv), filteredColor, fac);`;

    return [
        glsl`vec4 ${fnReference}(float fac, vec2 uv) {
        vec2 texelSize = 1.0 / vec2(${textureSizeCall});
        vec4 filteredColor = vec4(0.0);
        ${samples.join('\n')}
        ${factorMix}
        return filteredColor;
    }`,
        fnReference,
    ];
}
