// TODOs (engine-roadmap candidates):
// 1. materialManagerPlugin integration — reuse existing materials instead of
//    replacing them on every export. Material dedup + shaderTreePlugin compiled
//    materials should survive geometry swaps.
// 2. Generalized sceneLoader plugin — instead of every project rolling its own
//    GLB loading + feature-tag dispatch, a suite of composable plugins should
//    handle the full "load a blender scene" pipeline. This realtime geometry
//    plugin would become a consumer of that pipeline (write to object3D
//    components, not directly to the scene graph).
// 3. object3D as an ECS component — geometry replacement should operate on the
//    component level (update entity.components.object3D), not traverse the
//    three.js scene. A separate system reacts to object3D changes and syncs
//    the scene graph. This plugin does scene traversal directly as a shortcut.

import { GLTFLoader } from 'three-stdlib';
import * as THREE from 'three';
import { blenderEvents } from './realtime';

export interface RealtimeGeometryConfig {
    loader: GLTFLoader;
    scene: THREE.Scene | THREE.Group;
    resolveUrl?: (filename: string) => string;
    onBeforeReplace?: (name: string, oldObject: THREE.Object3D, newObject: THREE.Object3D) => void;
    onAfterReplace?: (name: string, object: THREE.Object3D) => void;
    onNewObject?: (name: string, object: THREE.Object3D) => void;
}

function replaceMesh(existing: THREE.Mesh, fresh: THREE.Mesh, config: RealtimeGeometryConfig) {
    config.onBeforeReplace?.(fresh.name, existing, fresh);

    existing.geometry.dispose();
    existing.geometry = fresh.geometry;

    if (Array.isArray(fresh.material)) {
        if (Array.isArray(existing.material)) {
            existing.material.forEach(m => m.dispose());
        } else {
            existing.material.dispose();
        }
        existing.material = fresh.material;
    } else if (fresh.material) {
        if (Array.isArray(existing.material)) {
            existing.material.forEach(m => m.dispose());
        } else {
            existing.material.dispose();
        }
        existing.material = fresh.material;
    }

    existing.userData = fresh.userData;
    existing.position.copy(fresh.position);
    existing.quaternion.copy(fresh.quaternion);
    existing.scale.copy(fresh.scale);

    config.onAfterReplace?.(fresh.name, existing);
}

export function applyRealtimeGeometryPlugin(config: RealtimeGeometryConfig) {
    const resolveUrl = config.resolveUrl ?? ((filename: string) => `/${filename}`);

    blenderEvents.addEventListener('realtimeGeometry', async (event: CustomEvent<{ name: string }>) => {
        const filename = event.detail.name;
        const url = resolveUrl(filename);

        console.log('[RealtimeGeometry] loading', url);

        try {
            const gltf = await new Promise<THREE.GLTF>((resolve, reject) => {
                config.loader.load(url, resolve, undefined, reject);
            });

            if (!gltf.scene) return;

            const freshChildren = [...gltf.scene.children];

            for (const fresh of freshChildren) {
                const name = fresh.name;
                if (!name) continue;

                const existing = config.scene.getObjectByName(name);

                if (existing) {
                    if (existing.type === 'Mesh' && fresh.type === 'Mesh') {
                        replaceMesh(existing as THREE.Mesh, fresh as THREE.Mesh, config);
                    } else {
                        existing.parent?.remove(existing);
                        config.scene.add(fresh);
                        config.onNewObject?.(name, fresh);
                    }
                } else {
                    config.scene.add(fresh);
                    config.onNewObject?.(name, fresh);
                }
            }
        } catch (err) {
            console.error('[RealtimeGeometry] failed to load', url, err);
        }
    });
}
