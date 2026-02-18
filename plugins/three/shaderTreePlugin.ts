import {
    ReceiveType,
    ReflectionClass,
    resolveReceiveType,
} from '@deepkit/type';
import {
    BasicDepthPacking,
    FrontSide,
    GLSL3,
    InstancedMesh,
    MeshDepthMaterial,
    ShaderMaterial,
} from 'three';
import { UnionOrIntersectionType } from 'typescript';
import { blenderEvents } from '../../blender/realtime';
import {
    defaultComponentTypes,
    EntityWithComponents,
    Manager,
} from '../../ecs/manager';
import {
    createNodeTreeCompiler,
    NodeTree,
    ShaderTreeMethods,
} from '../nodeTrees/createCompiler';
import blenderShaders, { includesRegex } from '../nodeTrees/shader/blender';
import materialManagerPlugin, {
    MaterialManagerComponentTypes,
} from './materialManagerPlugin';
import { sprixlePlugin } from '../../ecs/plugin';
import { SingletonComponent, TrackPrevious } from '../../ecs/types';
import {
    DEFAULT_PASS_TARGETS,
    PassTargets,
} from '../nodeTrees/shader/blender/viewLayer';
import prepBlenderGLSL from '../nodeTrees/shader/blender/prepBlenderGLSL';

export type ShaderTreeComponentTypes = {
    shaderTree: NodeTree & TrackPrevious;
    rPassTargets: PassTargets & SingletonComponent;
} & MaterialManagerComponentTypes;

const dependencies = { materialManagerPlugin };

const basicDepthPackMaterial = new MeshDepthMaterial({
    depthPacking: BasicDepthPacking,
});

// TODO allow passing in custom transpiler methods
/** This plugin handles compiling and applying ShaderTree format (from blender addon) */
export default sprixlePlugin(function shaderTreePlugin<
    C extends defaultComponentTypes & ShaderTreeComponentTypes,
    M extends ShaderTreeMethods,
>(em: Manager<C>, methods: M, methodsType?: ReceiveType<M>) {
    methodsType = resolveReceiveType(methodsType);

    const reflection = ReflectionClass.from(methodsType)
        .type as unknown as UnionOrIntersectionType;

    const shaderTreeQuery = em.createQuery({
        includes: ['shaderTree', 'materialName'],
    });

    const compileShaderTree = createNodeTreeCompiler({
        type: 'ShaderTree',
        methods,
        reflection,
    });

    function makeShaderMaterial(
        entity: EntityWithComponents<C, Manager<C>, 'materialName'>,
        transpiledShader: ReturnType<typeof compileShaderTree>
    ) {
        const { compilationCache, configuration, depthTranspiled } =
            transpiledShader;

        // TODO: allow passing in things like side, etc.
        compilationCache.uniforms.envMapIntensity = { value: 1.0 };
        const material = new ShaderMaterial({
            glslVersion: GLSL3,
            lights: compilationCache.features.has('lights'),
            // TODO control
            side: FrontSide,
            premultipliedAlpha: false,
            alphaTest: 0.1,
            // dithering: true,
            // depthWrite: false,
            // depthTest: false,
            ...configuration,

            uniforms: compilationCache.uniforms,
            defines: Array.from(compilationCache.defines).reduce(
                (defines, v) => {
                    const [define, value = ''] = v.split(/ ?= ?/);
                    defines[define] = value;
                    return defines;
                },
                {}
                // { USE_POINTS: '', USE_POINTS_UV: '' }
            ),
            vertexShader: transpiledShader.vertexShader,
            fragmentShader: transpiledShader.fragmentShader,
        });
        if ('STANDARD' in material.defines) {
            material.isMeshStandardMaterial = true;
            material.uniforms.alphaTest = { value: 1.0 };
            material.uniforms.opacity = { value: 1 };
            material.uniforms.reflectivity = { value: 1 };
            material.uniforms.ior = { value: 1.25 };
            material.uniforms.refractionRatio = { value: 0.98 };
            material.uniforms.metalness = { value: 0.0 };
            material.uniforms.roughness = { value: 0.0 };
        }
        material.name = entity.components.materialName;

        material.onBeforeRender = (
            renderer,
            scene,
            camera,
            geometry,
            object,
            group
        ) => {
            if ('USE_OBJECT_INFO' in material.defines) {
                material.uniforms.objectLocation.value = object.position;
                material.uniformsNeedUpdate = true;
            }

            // TODO batching?
            if (object instanceof InstancedMesh) {
                material.defines['USE_INSTANCING'] = '';
            } else if ('USE_INSTANCING' in material.defines) {
                delete material.defines['USE_INSTANCING'];
            }

            for (let method of compilationCache.shader.onBeforeRender) {
                method.call(
                    material,
                    renderer,
                    scene,
                    camera,
                    geometry,
                    object,
                    group
                );
            }
        };

        if (depthTranspiled) {
            const depthMaterial = new ShaderMaterial({
                premultipliedAlpha: false,
                alphaTest: 0.1,
                // dithering: true,
                // depthWrite: false,
                // depthTest: false,
                ...depthTranspiled.configuration,

                uniforms: depthTranspiled.compilationCache.uniforms,
                defines: Array.from(
                    depthTranspiled.compilationCache.defines
                ).reduce(
                    (defines, v) => {
                        const [define, value = ''] = v.split(/ ?= ?/);
                        defines[define] = value;
                        return defines;
                    },
                    {}
                    // { USE_POINTS: '', USE_POINTS_UV: '' }
                ),
                vertexShader: depthTranspiled.vertexShader,
                fragmentShader: depthTranspiled.fragmentShader,
            });

            depthMaterial.name = entity.components.materialName + ' Depth';

            entity.components.depthMaterial = depthMaterial;
        } else {
            // entity.components.depthMaterial = basicDepthPackMaterial;
        }

        entity.components.material = material;
        delete entity.components['shaderTree'];

        console.log('[shaderTreePlugin] created material', material);
    }

    const shaderTreeSystem = em.createSystem(shaderTreeQuery.createConsumer(), {
        forNew(entity, delta) {
            // TODO add loading manager
            const { shaderTree, materialName } = entity.components;

            console.log(
                '[shaderTreeSystem] compiling',
                materialName,
                shaderTree
            );

            const rPassTargets =
                em.getSingletonEntityComponent('rPassTargets') ||
                DEFAULT_PASS_TARGETS;

            const compiledShaderTree = compileShaderTree(shaderTree, {
                rPassTargets,
            });

            logShader(materialName, compiledShaderTree);
            if (compiledShaderTree.depthTranspiled) {
                logShader(
                    'DEPTH ' + materialName,
                    compiledShaderTree.depthTranspiled
                );
            }

            // if (compiledShaderTree.initFn) {
            //     compiledShaderTree.initFn.call(entity.components.ShaderTreeCache, delta, methods, entity, {
            //         Geometry: mesh
            //     })
            // }
            // entity.components.compiledShaderTree = compiledShaderTree.fn;
            // console.log(entity.components.compiledShaderTree);

            makeShaderMaterial(entity, compiledShaderTree);
        },
    });

    // TODO
    blenderEvents.addEventListener('shaderTree', (event) => {
        const { tree, name } = event.detail;

        em.quickEntity({
            materialName: name,
            shaderTree: tree,
        });
    });

    function logShader(
        materialName: string,
        compiledShaderTree: ReturnType<typeof compileShaderTree>
    ) {
        let fragmentLog = compiledShaderTree.fragmentShader;
        for (let shaderName in blenderShaders) {
            const replaceableShaderCode = prepBlenderGLSL(
                blenderShaders[shaderName].replace(includesRegex, '')
            );
            fragmentLog = fragmentLog.replace(
                replaceableShaderCode,
                `#include <${shaderName}>`
            );
        }

        let vertexLog = compiledShaderTree.vertexShader;
        for (let shaderName in blenderShaders) {
            const replaceableShaderCode = prepBlenderGLSL(
                blenderShaders[shaderName].replace(includesRegex, '')
            );
            vertexLog = vertexLog.replace(
                replaceableShaderCode,
                `#include <${shaderName}>`
            );
        }

        console.groupCollapsed('[transpiledShaderTree] logs', materialName);
        console.log(compiledShaderTree.compilationCache);
        console.log('vertex', vertexLog);
        console.log('fragment', fragmentLog);
        console.groupEnd();
    }

    return shaderTreeSystem;
}, dependencies);
