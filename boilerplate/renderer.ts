import * as THREE from 'three';
import { scene } from './scene';

export const renderer = new THREE.WebGLRenderer();
// scene.fog = new THREE.Fog(0x010121, 0.1, 200);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.physicallyCorrectLights = true;
renderer.outputEncoding = THREE.sRGBEncoding;
// renderer.setPixelRatio(0.5)
// renderer.setClearColor(0x000000, 1.0);
renderer.setSize(window.innerWidth, window.innerHeight);