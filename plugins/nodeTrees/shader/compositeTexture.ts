import { memoize } from 'lodash';
import {
    CanvasTexture,
    ClampToEdgeWrapping,
    LinearFilter,
    MirroredRepeatWrapping,
    NearestFilter,
    RepeatWrapping,
    Vector2,
} from 'three';
import { CompilationCache } from '../createCompiler';

export function getCompositeTexture(
    reference: string,
    interpolation: typeof LinearFilter | typeof NearestFilter,
    itemWidth: number,
    itemHeight: number,
    compilationCache: CompilationCache
) {
    const existing = compilationCache.shader.compositeTextures[reference];

    if (existing) return existing;

    compilationCache.shader.compositeTextures[reference] = new CompositeTexture(
        itemWidth,
        itemHeight,
        interpolation
    );

    compilationCache.shader.compositeTextures[
        reference
    ].canvas.dataset.reference = reference;
    // document.body.append(
    //     compilationCache.shader.compositeTextures[reference].canvas
    // );

    return compilationCache.shader.compositeTextures[reference];
}

export class CompositeTexture {
    width: number;
    height: number;

    textureWidth: number;
    textureHeight: number;

    count = 0;

    protected x = 0;
    protected y = 0;

    protected canvas = document.createElement('canvas') as HTMLCanvasElement;
    protected context = this.canvas.getContext('2d', { alpha: false });
    canvasTexture = new CanvasTexture(this.canvas);

    constructor(
        itemWidth: number,
        itemHeight: number,
        interpolation:
            | typeof LinearFilter
            | typeof NearestFilter = LinearFilter,
        textureWidth: number = 257,
        textureHeight: number = 1024
    ) {
        this.width = itemWidth;
        this.height = itemHeight;

        this.textureWidth = itemWidth;
        this.textureHeight = textureHeight;
        this.canvas.width = textureWidth;
        this.canvas.height = textureHeight;

        this.canvasTexture.wrapS = this.canvasTexture.wrapT =
            ClampToEdgeWrapping;
        this.canvasTexture.magFilter = this.canvasTexture.minFilter =
            interpolation;

        this.canvas.style.imageRendering = 'pixelated';
        this.context.imageSmoothingEnabled = false;
    }

    add = memoize(
        function add(
            this: CompositeTexture,
            imageData: ImageData,
            reference: string
        ) {
            this.count++;
            this.canvas.dataset.count = this.count.toString();

            this.context.putImageData(imageData, this.x, this.y);
            const startIndex = (this.y * this.textureWidth + this.x) * 4;
            const updateLength = imageData.data.length; //this.width * this.height * 4;
            this.canvasTexture.addUpdateRange(startIndex, updateLength);

            const sampler_offset = 0.5 / this.textureHeight;
            const sampler_scale = 1.0 / this.textureHeight;

            const result = {
                x: this.x,
                y: this.y,
                uv: new Vector2(
                    this.x / this.textureWidth,
                    1 - (this.y * sampler_scale + sampler_offset)
                    // 1 - this.y + (0.5 / this.textureHeight)
                ),
                texture: this.canvasTexture,
            };

            this.moveToNext();

            return result;
        },
        (imageData, reference) => reference
    );

    protected moveToNext() {
        this.x += this.width;
        if (this.x + this.width > this.textureWidth) {
            this.x = 0;
            this.y += this.height;
        }
    }
}
