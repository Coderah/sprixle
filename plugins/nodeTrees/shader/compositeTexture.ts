import { memoize } from 'lodash';
import {
    CanvasTexture,
    LinearFilter,
    NearestFilter,
    RepeatWrapping,
} from 'three';
import { CompilationCache } from '../createCompiler';

export function getCompositeTexture(
    reference: string,
    itemWidth: number,
    itemHeight: number,
    compilationCache: CompilationCache
) {
    const existing = compilationCache.shader.compositeTextures[reference];

    if (existing) return existing;

    compilationCache.shader.compositeTextures[reference] = new CompositeTexture(
        itemWidth,
        itemHeight
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
    protected context = this.canvas.getContext('2d');
    canvasTexture = new CanvasTexture(this.canvas);

    constructor(
        itemWidth: number,
        itemHeight: number,
        textureWidth: number = 257,
        textureHeight: number = 1024
    ) {
        this.width = itemWidth;
        this.height = itemHeight;

        this.textureWidth = itemWidth;
        this.textureHeight = textureHeight;
        this.canvas.width = textureWidth;
        this.canvas.height = textureHeight;

        this.canvasTexture.wrapS = this.canvasTexture.wrapT = RepeatWrapping;
        this.canvasTexture.magFilter = this.canvasTexture.minFilter =
            LinearFilter;
    }

    // TODO might need to memoize on imageData instead?
    add = memoize(function add(canvas: HTMLCanvasElement) {
        this.count++;
        this.canvas.dataset.count = this.count;
        const imageData = canvas
            .getContext('2d')
            .getImageData(0, 0, this.width, this.height);

        this.context.putImageData(imageData, this.x, this.y);
        this.canvasTexture.needsUpdate = true;

        const result = {
            x: this.x,
            y: this.y,
            texture: this.canvasTexture,
        };

        this.moveToNext();

        return result;
    });

    protected moveToNext() {
        this.x += this.width;
        if (this.x + this.width > this.textureWidth) {
            this.x = 0;
            this.y += this.height;
        }
    }
}
