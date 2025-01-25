import {
    ReceiveType,
    ReflectionClass,
    resolveReceiveType,
} from '@deepkit/type';
import {
    DoubleSide,
    FrontSide,
    InstancedMesh,
    Material,
    Object3D,
    ShaderMaterial,
    Vector3,
} from 'three';
import {
    defaultComponentTypes,
    Entity,
    EntityWithComponents,
    Manager,
} from '../../ecs/manager';
import { Pipeline } from '../../ecs/system';
import { interval } from '../../util/timing';
import {
    CompilationCache,
    createNodeTreeCompiler,
    NodeTree,
} from '../nodeTrees/createCompiler';
import { blenderEvents } from '../../blender/realtime';
import { MaterialManagerComponenTypes } from './materialManagerPlugin';
import { combineVertexShader } from '../nodeTrees/shader/combineCode';
import blenderShaders, { includesRegex } from '../nodeTrees/shader/blender';

export type ShaderTreeComponentTypes = {
    mesh: Object3D;
    shaderTree: NodeTree;
} & MaterialManagerComponenTypes;

// TODO allow passing in custom transpiler methods
/** This plugin handles compiling and applying ShaderTree format (from blender addon) */
export function applyShaderTreePlugin<
    C extends defaultComponentTypes & ShaderTreeComponentTypes,
    M extends {}
>(em: Manager<C>, transpilerMethods: M, methodsType?: ReceiveType<M>) {
    // methodsType = resolveReceiveType(methodsType);

    // const reflection = ReflectionClass.from(methodsType);
    // TODO should be improved with abstraction of createCompiler

    const shaderTreeQuery = em.createQuery({
        includes: ['shaderTree', 'materialName'],
    });

    const compileShaderTree = createNodeTreeCompiler({
        type: 'ShaderTree',
    });

    function makeShaderMaterial(
        entity: EntityWithComponents<C, Manager<C>, 'materialName'>,
        transpiledShader: ReturnType<typeof compileShaderTree>
    ) {
        // TODO: allow passing in things like side, etc.
        const material = new ShaderMaterial({
            lights: transpiledShader.compilationCache.features.has('lights'),
            // TODO control
            side: DoubleSide,
            // TODO conditional
            transparent: true,
            alphaTest: 0.1,
            // dithering: true,
            // depthWrite: false,
            // depthTest: false,

            uniforms: {
                ...transpiledShader.compilationCache.uniforms,
                // TODO get from geometry bounding box
                // size: { value: 90 },
                // scale: { value: 1 },
            },
            defines: Array.from(
                transpiledShader.compilationCache.defines
            ).reduce(
                (defines, v) => {
                    defines[v] = '';
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
        };

        entity.components.material = material;
        em.removeComponent(entity, 'shaderTree');
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

            const compiledShaderTree = compileShaderTree(shaderTree);

            let shaderLog = compiledShaderTree.fragmentShader;
            for (let shaderName in blenderShaders) {
                const replaceableShaderCode = blenderShaders[
                    shaderName
                ].replace(includesRegex, '');
                shaderLog = shaderLog.replace(
                    replaceableShaderCode,
                    `#include <${shaderName}>`
                );
            }
            console.log('[transpiledShaderTree]', shaderLog);

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

    return shaderTreeSystem;
}
