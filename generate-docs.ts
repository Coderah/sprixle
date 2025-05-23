global['window'] = global;

import { buildDocumentation, documentationToMarkdown } from 'tsdoc-markdown';
// const findFiles = require('file-regex');
import findFiles from 'file-regex';
import { inspect } from 'util';

import { transpilerMethods as shaderTranspilerMethods } from './plugins/nodeTrees/shader/transpilerMethods';
import { transpilerMethods as logicTranspilerMethods } from './plugins/nodeTrees/logic/transpilerMethods';
import { metaAnnotation, ReflectionClass, typeOf } from '@deepkit/type';
import path from 'path';
import { mkdirSync, writeFileSync } from 'fs';
import fuzzy from 'fuzzy';

shaderTranspilerMethods;
logicTranspilerMethods;

const blenderNodeLinks = {};

[
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/input/ao.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/input/attribute.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/input/bevel.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/input/camera_data.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/input/fresnel.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/input/geometry.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/input/hair_info.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/input/layer_weight.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/input/light_path.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/input/object_info.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/input/particle_info.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/input/point_info.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/input/rgb.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/input/tangent.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/input/texture_coordinate.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/input/uv_map.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/input/value.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/input/vertex_color.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/input/volume_info.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/input/wireframe.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/output/aov.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/output/material.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/output/light.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/output/world.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/shader/add.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/shader/background.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/shader/diffuse.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/shader/emission.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/shader/glass.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/shader/glossy.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/shader/hair.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/shader/holdout.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/shader/mix.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/shader/metallic.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/shader/principled.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/shader/hair_principled.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/shader/volume_principled.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/shader/ray_portal.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/shader/refraction.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/shader/specular_bsdf.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/shader/sss.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/shader/toon.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/shader/translucent.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/shader/transparent.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/shader/sheen.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/shader/volume_absorption.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/shader/volume_scatter.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/textures/brick.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/textures/checker.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/textures/environment.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/textures/gabor.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/textures/gradient.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/textures/ies.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/textures/image.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/textures/magic.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/textures/musgrave.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/textures/noise.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/textures/point_density.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/textures/sky.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/textures/voronoi.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/textures/wave.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/textures/white_noise.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/color/bright_contrast.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/color/gamma.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/color/hue_saturation.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/color/invert_color.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/color/light_falloff.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/color/mix.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/color/rgb_curves.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/vector/bump.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/vector/displacement.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/vector/mapping.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/vector/normal.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/vector/normal_map.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/vector/curves.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/vector/vector_displacement.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/vector/vector_rotate.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/vector/transform.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/converter/blackbody.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/converter/clamp.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/converter/color_ramp.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/converter/combine_color.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/converter/combine_xyz.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/converter/float_curve.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/converter/map_range.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/converter/math.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/converter/mix.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/converter/rgb_to_bw.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/converter/separate_color.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/converter/separate_xyz.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/converter/shader_to_rgb.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/converter/vector_math.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/converter/wavelength.html',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/groups.html#group-input',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/groups.html#group-output',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/groups.html#node-groups',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/osl.html#script-node',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/osl.html#writing-shaders',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/osl.html#closures',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/osl.html#attributes',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/osl.html#trace',
    'https://docs.blender.org/manual/en/latest/render/shader_nodes/osl.html#metadata',
].forEach((h) => {
    blenderNodeLinks[
        h.replace(
            'https://docs.blender.org/manual/en/latest/render/shader_nodes',
            ''
        )
    ] = h;
});

const shaderNodeFiles = ['./plugins/nodeTrees/shader/transpilerMethods.ts'];
(async function () {
    let pluginFiles = await findFiles('./plugins', /\.ts$/, 1);
    pluginFiles = pluginFiles.map(
        (f) =>
            './' + path.relative('./', f.dir + '/' + f.file).replace(/\\/g, '/')
    );
    console.log(pluginFiles);
    // pluginFiles = pluginFiles.filter(f => {

    // });

    mkdoc(pluginFiles, '/plugins.md', (entry) => entry.name.endsWith('Plugin'));

    mkdir('./Sprixle Docs/plugins/shaderTree');
    mkdir('./Sprixle Docs/plugins/logicTree');

    const supportedLogicNodesType = typeOf<typeof logicTranspilerMethods>();
    const supportedShaderNodesType = typeOf<typeof shaderTranspilerMethods>();

    const blenderNFilter = Object.keys(blenderNodeLinks);

    const supportedShaderNodeList = supportedShaderNodesType.types
        .sort((a, b) => (a.name > b.name ? 1 : -1))
        .map((t) => {
            let result = t.name;

            result = result
                .replace('VECT_MATH', 'VECTOR_MATH')
                .replace('EEVEE_SPECULAR', 'SPECULAR_BSDF')
                .replace(/(?:([A-Z])([A-Z]*))/g, (n, n1, n2) => {
                    if (n === 'BSDF') return n;

                    if (n === 'TEX') return 'Texture';

                    if (n === 'SHADERTORGB') return 'Shader_To_RGB';

                    if (n === 'VALTORGB') return 'Color_Ramp';

                    if (n === 'COMBXYZ') return 'Combine_XYZ';

                    return n1 + n2.toLowerCase();
                });

            const urlKey = fuzzy.filter(
                result.startsWith('Texture_') && result !== 'Texture_Coord'
                    ? result.replace('Texture_', 'textures/')
                    : result
                          .replace('Output_', 'output/')
                          .replace('BSDF_', 'shader/')
                          .replace('Specular_', 'shader/specular_')
                          .replace('New_', '')
                          .replace('Mix_Shader', 'shader/mix')
                          .replace('Mix', 'converter/mix'),
                blenderNFilter
            )[0]?.string;

            result = result.replace(/_/g, ' ');

            if (urlKey) {
                result = `[${result}](${blenderNodeLinks[urlKey]})`;
            } else {
                result = `${result} * From Asset library`;
            }

            if (t.return) {
                if (metaAnnotation.getForName(t.return, 'PartialSupport')) {
                    result += ' * Partially Supported';
                }

                if (metaAnnotation.getForName(t.return, 'StubbedSupport')) {
                    result += ' * Support is stubbed';
                }
            }

            return '* ' + result;
        });

    // TODO sort
    supportedShaderNodeList.push(
        '* [Separate XYZ](https://docs.blender.org/manual/en/latest/compositing/types/vector/separate_xyz.html)',
        `* Configure Material * From Asset library`
    );

    // @ts-ignore
    writeFileSync(
        './Sprixle Docs/plugins/shaderTree/supported-nodes.md',
        `### Blender

${supportedShaderNodeList.join('\n')}`
    );

    const supportedLogicNodeList = supportedLogicNodesType.types
        .sort((a, b) => (a.name > b.name ? 1 : -1))
        .map((t) => {
            let result = t.name;

            result = result.replace(/_/g, ' ');

            if (t.return) {
                if (metaAnnotation.getForName(t.return, 'PartialSupport')) {
                    result += ' * Partially Supported';
                }

                if (metaAnnotation.getForName(t.return, 'StubbedSupport')) {
                    result += ' * Support is stubbed';
                }
            }

            return '* ' + result;
        });

    writeFileSync(
        './Sprixle Docs/plugins/logicTree/implemented-nodes.md',
        `### Sprixle
        
${supportedLogicNodeList.join('\n')}`
    );
})();

function mkdoc(files, outPath = '', entryFilter) {
    let entries = [];

    // TODO implement hashing

    files.forEach((file) => {
        entries.push(
            ...buildDocumentation({
                inputFiles: [file],
                options: {
                    types: true,
                },
            })
        );
    });

    if (entryFilter) {
        entries = entries.filter(entryFilter);
    }
    // console.log(inspect(entries));

    if (outPath) {
        outPath = './Sprixle Docs/' + outPath;
        mkdir(path.dirname(outPath));
        writeFileSync(
            outPath,
            documentationToMarkdown({
                entries,
                options: {
                    emoji: null,
                },
            })
        );
    } else {
        // TODO
        entries.forEach((entry) => {
            outPath = './Sprixle Docs/' + entry.fileName.replace('.ts', '.md');
            mkdir(path.dirname(outPath));
            writeFileSync(
                outPath,
                documentationToMarkdown({
                    entries: [entry],
                    options: {
                        emoji: null,
                    },
                })
            );
        });
    }
}

function mkdir(path) {
    try {
        mkdirSync(path, {
            recursive: true,
        });
    } catch {}
}
