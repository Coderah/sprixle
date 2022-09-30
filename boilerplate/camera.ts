import { OrthographicCamera } from 'three';
import { PerspectiveCamera } from 'three';

// export const camera = new PerspectiveCamera(
//     70,
//     window.innerWidth / window.innerHeight,
//     0.1,
//     100000
// );
export const camera = new OrthographicCamera(-1, 1, 1, -1,-1000, 10000);
camera.position.set(20,0,20);
camera.lookAt(0, 0, 0);
camera.zoom=0.05;
camera.updateProjectionMatrix()
window['camera'] = camera;