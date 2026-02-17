import {
    DepthFormat,
    DepthTexture,
    HalfFloatType,
    RedFormat,
    RGBAFormat,
    Texture,
} from 'three';

export type PassTargets = Array<{
    name: string;
    format?: Texture['format'];
    type?: Texture['type'];
    internalShaderLogic?: 'Depth' | 'Normal' | 'Position' | 'Vector';
}>;

export interface BlenderViewLayer {
    name: string;
    samples: number;
    pass_alpha_threshold: number;
    eevee: any;
    aovs: AOV[];
    active_aov: string;
    active_aov_index: number;
    lightgroups: any[];
    active_lightgroup_index: number;
    use_pass_cryptomatte_object: boolean;
    use_pass_cryptomatte_material: boolean;
    use_pass_cryptomatte_asset: boolean;
    pass_cryptomatte_depth: number;
    use_pass_cryptomatte_accurate: boolean;
    use_solid: boolean;
    use_sky: boolean;
    use_ao: boolean;
    use_strand: boolean;
    use_volumes: boolean;
    use_motion_blur: boolean;
    use_grease_pencil: boolean;
    use_pass_combined: boolean;
    use_pass_z: boolean;
    use_pass_vector: boolean;
    use_pass_position: boolean;
    use_pass_normal: boolean;
    use_pass_uv: boolean;
    use_pass_mist: boolean;
    use_pass_object_index: boolean;
    use_pass_material_index: boolean;
    use_pass_shadow: boolean;
    use_pass_ambient_occlusion: boolean;
    use_pass_emit: boolean;
    use_pass_environment: boolean;
    use_pass_diffuse_direct: boolean;
    use_pass_diffuse_indirect: boolean;
    use_pass_diffuse_color: boolean;
    use_pass_glossy_direct: boolean;
    use_pass_glossy_indirect: boolean;
    use_pass_glossy_color: boolean;
    use_pass_transmission_direct: boolean;
    use_pass_transmission_indirect: boolean;
    use_pass_transmission_color: boolean;
    use_pass_subsurface_direct: boolean;
    use_pass_subsurface_indirect: boolean;
    use_pass_subsurface_color: boolean;
    layer_collection: string;
    active_layer_collection: string;
    use: boolean;
    has_export_collections: boolean;
    use_freestyle: boolean;
    freestyle_settings: any;
    use_pass_grease_pencil: boolean;
    depsgraph: any;
    cycles: string;
}

export interface AOV {
    name: string;
    is_valid: boolean;
    type: 'COLOR' | 'VALUE';
}

const defaultDepthType = new DepthTexture(6, 6).type;

export function convertViewLayerToTargets(viewLayer: BlenderViewLayer) {
    const result: PassTargets = [];

    result.push({
        name: 'MainColor',
        format: RGBAFormat,
    });

    // TODO support this as tDepth and utilize the build in depth rendering of renderPass
    if (viewLayer.use_pass_z) {
        result.push({
            name: 'Depth',
            format: DepthFormat,
            type: defaultDepthType,
            internalShaderLogic: 'Depth',
        });
    }

    if (viewLayer.use_pass_normal) {
        result.push({
            name: 'Normal',
            format: RGBAFormat,
            internalShaderLogic: 'Normal',
        });
    }

    if (viewLayer.use_pass_position) {
        result.push({
            name: 'Position',
            format: RGBAFormat,
            internalShaderLogic: 'Position',
        });
    }

    if (viewLayer.use_pass_vector) {
        result.push({
            name: 'Vector',
            format: RGBAFormat,
            internalShaderLogic: 'Vector',
        });
    }

    if (viewLayer.aovs.length) {
        viewLayer.aovs.forEach((aov) => {
            result.push({
                name: aov.name,
                format: aov.type === 'COLOR' ? RGBAFormat : RedFormat,
                // TODO check for FloatType support?
                type: HalfFloatType,
            });
        });
    }

    return result;
}

export const DEFAULT_PASS_TARGETS: PassTargets = [
    {
        name: 'pc_FragColor',
        format: RGBAFormat,
    },
];
