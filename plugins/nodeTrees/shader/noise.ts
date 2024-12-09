import * as THREE from 'three';
import * as SimplexNoise from 'simplex-noise';

interface NoiseTextureOptions {
    dimensions?: '1D' | '2D' | '3D' | '4D';
    type?:
        | 'FBM'
        | 'multifractal'
        | 'hybrid_multifractal'
        | 'ridged_multifractal'
        | 'hetero_terrain';
    useNormalize?: boolean;
    scale?: number;
    detail?: number;
    roughness?: number;
    offset?: number;
    gain?: number;
    lacunarity?: number;
    distortion?: number;
    width?: number;
    height?: number;
}

const seed = () => 0.5;
export class NoiseTextureGenerator {
    private static noise2D = SimplexNoise.createNoise2D(seed);
    private static noise3D = SimplexNoise.createNoise3D(seed);
    private static noise4D = SimplexNoise.createNoise4D(seed);

    private static safeSnoise(
        x: number,
        y?: number,
        z?: number,
        w?: number
    ): number {
        const precision_correction = 0.5 * Number(Math.abs(x) >= 1000000.0);
        const p = (x % 100000.0) + precision_correction;

        if (y === undefined) {
            return this.noise2D(p, 0);
        }

        if (z === undefined) {
            return this.noise2D(p, y);
        }

        if (w === undefined) {
            return this.noise3D(p, y, z);
        }

        // 4D noise (simplified)
        return this.noise4D(p, y, z, w);
    }

    private static noiseSelect(
        p: number | THREE.Vector2 | THREE.Vector3 | THREE.Vector4,
        detail: number,
        roughness: number,
        lacunarity: number,
        offset = 0,
        gain = 1,
        type: string = 'FBM',
        useNormalize = true
    ): number {
        switch (type) {
            case 'multifractal':
                return this.noiseMultiFractal(p, detail, roughness, lacunarity);
            case 'FBM':
                return this.noiseFbm(
                    p,
                    detail,
                    roughness,
                    lacunarity,
                    useNormalize
                );
            //   case 'hybrid_multifractal':
            //     return this.noiseHybridMultiFractal(p, detail, roughness, lacunarity, offset, gain);
            //   case 'ridged_multifractal':
            //     return this.noiseRidgedMultiFractal(p, detail, roughness, lacunarity, offset, gain);
            //   case 'hetero_terrain':
            //     return this.noiseHeteroTerrain(p, detail, roughness, lacunarity, offset);
            default:
                console.error('unsupported noise type');
                return 0;
        }
    }

    private static noiseFbm(
        co: number | THREE.Vector2 | THREE.Vector3 | THREE.Vector4,
        detail: number,
        roughness: number,
        lacunarity: number,
        useNormalize: boolean
    ): number {
        let p = typeof co !== 'number' ? co.toArray() : [co];
        let fscale = 1.0;
        let amp = 1.0;
        let maxamp = 0.0;
        let sum = 0.0;

        for (let i = 0; i <= Math.floor(detail); i++) {
            const t = this.safeSnoise.apply(
                this,
                p.map((x) => fscale * x)
            );
            sum += t * amp;
            maxamp += amp;
            amp *= roughness;
            fscale *= lacunarity;
        }

        const rmd = detail - Math.floor(detail);
        if (rmd !== 0.0) {
            const t = this.safeSnoise.apply(
                this,
                p.map((x) => fscale * x)
            );
            const sum2 = sum + t * amp;
            return useNormalize
                ? this.mix(
                      (0.5 * sum) / maxamp + 0.5,
                      (0.5 * sum2) / (maxamp + amp) + 0.5,
                      rmd
                  )
                : this.mix(sum, sum2, rmd);
        }

        return useNormalize ? (0.5 * sum) / maxamp + 0.5 : sum;
    }

    private static noiseMultiFractal(
        co: number | THREE.Vector2 | THREE.Vector3 | THREE.Vector4,
        detail: number,
        roughness: number,
        lacunarity: number
    ): number {
        let p = co;
        let value = 1.0;
        let pwr = 1.0;

        for (let i = 0; i <= detail; i++) {
            value *= pwr * this.safeSnoise(p as number) + 1.0;
            pwr *= roughness;
            p = this.scaleVector(p, lacunarity);
        }

        const rmd = detail - Math.floor(detail);
        if (rmd !== 0.0) {
            value *= rmd * pwr * this.safeSnoise(p as number) + 1.0;
        }

        return value;
    }

    // Other noise methods (noiseHybridMultiFractal, noiseHeteroTerrain, noiseRidgedMultiFractal)
    // would be implemented similarly, following the Blender implementation

    private static mix(a: number, b: number, t: number): number {
        return a * (1 - t) + b * t;
    }

    private static scaleVector(
        v: number | THREE.Vector2 | THREE.Vector3 | THREE.Vector4,
        scale: number
    ) {
        if (typeof v === 'number') return v * scale;
        if (v instanceof THREE.Vector2) return v.clone().multiplyScalar(scale);
        if (v instanceof THREE.Vector3) return v.clone().multiplyScalar(scale);
        if (v instanceof THREE.Vector4) return v.clone().multiplyScalar(scale);
        return v;
    }

    static generateNoiseTexture(
        options: NoiseTextureOptions = {}
    ): THREE.CanvasTexture {
        const {
            dimensions = '2D',
            type = 'FBM',
            useNormalize = true,
            scale = 5.0,
            detail = 2.0,
            roughness = 0.5,
            offset = 0.0,
            gain = 1.0,
            lacunarity = 2.0,
            distortion = 0.0,
            width = 256,
            height = 256,
        } = options;

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d')!;
        const imageData = ctx.createImageData(width, height);
        const data = imageData.data;

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                // Normalize coordinates to [-1, 1] range
                const nx = (x / width) * 2 - 1;
                const ny = (y / height) * 2 - 1;

                // Apply scale and potential distortion
                const scaledX = nx * scale;
                const scaledY = ny * scale;

                let value: number;
                if (dimensions === '2D') {
                    const point = new THREE.Vector2(scaledX, scaledY);
                    point.addScalar(
                        this.safeSnoise.apply(
                            this,
                            point
                                .clone()
                                .add(
                                    new THREE.Vector2(
                                        this.safeSnoise.apply(
                                            this,
                                            point.toArray()
                                        ),
                                        this.safeSnoise.apply(
                                            this,
                                            point.toArray()
                                        )
                                    )
                                )
                                .toArray()
                        ) *
                            distortion *
                            0.1
                    );
                    value = this.noiseSelect(
                        point,
                        detail,
                        roughness,
                        lacunarity,
                        offset,
                        gain,
                        type,
                        useNormalize
                    );
                } else {
                    const point = new THREE.Vector3(scaledX, scaledY, 0);
                    point.addScalar(
                        this.safeSnoise.apply(
                            this,
                            point
                                .clone()
                                .addScalar(Math.random() * distortion)
                                .toArray()
                        )
                    );
                    value = this.noiseSelect(
                        point,
                        detail,
                        roughness,
                        lacunarity,
                        offset,
                        gain,
                        type,
                        useNormalize
                    );
                }

                // Ensure value is in [0, 1] range
                value = Math.max(0, Math.min(1, value));

                const index = (y * width + x) * 4;
                data[index] =
                    data[index + 1] =
                    data[index + 2] =
                        Math.floor(value * 255);
                data[index + 3] = 255;
            }
        }

        ctx.putImageData(imageData, 0, 0);
        const texture = new THREE.CanvasTexture(canvas);
        texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
        return texture;
    }
}

export default NoiseTextureGenerator;
