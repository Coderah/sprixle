import Stats from 'stats.js';
import * as THREE from 'three';
import { Vector2 } from 'three';
import {
    EffectComposer,
    MapControls,
    RenderPass,
    ShaderPass,
    UnrealBloomPass,
} from 'three-stdlib';
import './index.css';

import { Vector3 } from 'three';
import {
    acceleratedRaycast,
    computeBoundsTree,
    disposeBoundsTree,
} from 'three-mesh-bvh';
import { initInput, inputTick } from '../input/input';
import { now } from '../util/now';
import { camera } from './camera';
import em, { getState, setState } from './entityManager';
import { gltfLoader } from './loader';
import { renderer } from './renderer';
import { scene } from './scene';
import { meshSystem, models } from './system/meshSystem';

import { postProcessCelShader } from '../shader/PostProcessCelShader';

// Add the extension functions
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

initInput(renderer);

var stats = new Stats();
document.body.appendChild(stats.dom);

gltfLoader.load('assets/boilerplate-test.glb', (gltf) => {
    models['boilerplate-test'] = gltf.scene;
});

const controls = new MapControls(camera, renderer.domElement);
setState((state) => {
    // Setup initial entities here
    const meshOwnerEntity = em.createEntity('meshOwner');
    em.addComponent(meshOwnerEntity, 'type', 'boilerplate-test');
    em.addComponent(meshOwnerEntity, 'position', new Vector3(0, 0, 0));
    state = em.registerEntity(state, meshOwnerEntity);

    return state;
});

document.body.appendChild(renderer.domElement);
// controls.update();

const ambientLight = new THREE.HemisphereLight(
    new THREE.Color('yellow'),
    new THREE.Color('darkblue'),
    11
);
ambientLight.position.set(0, 7, 5);
scene.add(ambientLight);

const composer = new EffectComposer(renderer);

const renderPass = new RenderPass(scene, camera);
// renderPass.enabled = false;
composer.addPass(renderPass);

// const saoPass = new SAOPass( scene, camera, true, true );
// saoPass.params.saoBias = 0.05;
// saoPass.params.saoIntensity = 0.016;
// saoPass.params.saoScale = 80;
// saoPass.params.saoKernelRadius = 60;
// saoPass.params.saoBlur = false;
// saoPass.params.saoBlurRadius = 2;
// saoPass.params.output = 0;
// composer.addPass( saoPass );

const BloomPass = new UnrealBloomPass(new Vector2(1024, 1024), 0.05, 0.4, 0.65);
composer.addPass(BloomPass);

// const copyPass = new ShaderPass(CopyShader);
// composer.addPass(copyPass);

const celPass = new ShaderPass(postProcessCelShader);
composer.addPass(celPass);

// const taaRenderPass = new TAARenderPass( scene, camera );
// taaRenderPass.unbiased = false;
// taaRenderPass.accumulate = true;
// taaRenderPass.sampleLevel = 3; // 8 samples
// composer.addPass( taaRenderPass );

// const pass = new SMAAPass( window.innerWidth * renderer.getPixelRatio(), window.innerHeight * renderer.getPixelRatio() );
// composer.addPass( pass );

let time = now();

function tick() {
    const newTime = now();
    const delta = newTime - time;
    time = newTime;

    stats.begin();

    camera.layers.enableAll();

    let state = getState();
    controls.update();

    inputTick(camera);

    state = meshSystem(state, delta);

    setState(state);

    composer.render(delta);
    stats.end();

    requestAnimationFrame(tick);
}

requestAnimationFrame(tick);
