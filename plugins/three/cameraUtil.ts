import { Camera, OrthographicCamera, PerspectiveCamera } from 'three';
import {
    cameraFarUniform,
    cameraNearUniform,
} from '../nodeTrees/shader/uniforms';

export function applyCamera<C extends Camera>(
    newCamera: C,
    cameraToApplyTo: C
) {
    const cameraIsOrthographic =
        cameraToApplyTo instanceof OrthographicCamera &&
        newCamera instanceof OrthographicCamera;
    const cameraIsPerspective =
        cameraToApplyTo instanceof PerspectiveCamera &&
        newCamera instanceof PerspectiveCamera;

    if (!cameraIsOrthographic && !cameraIsPerspective) {
        throw new Error(
            '[applyCamera] unable to convert between orthographic and perspective camera'
        );
    }

    cameraToApplyTo.position.copy(newCamera.position);
    cameraToApplyTo.scale.copy(newCamera.scale);
    cameraToApplyTo.rotation.copy(newCamera.rotation);

    if (cameraIsOrthographic) {
        cameraToApplyTo.left = newCamera.left;
        cameraToApplyTo.top = newCamera.top;
        cameraToApplyTo.right = newCamera.right;
        cameraToApplyTo.bottom = newCamera.bottom;
    }

    cameraToApplyTo.far = newCamera.far;
    cameraToApplyTo.near = newCamera.near;

    cameraFarUniform.value = cameraToApplyTo.far;
    cameraNearUniform.value = cameraToApplyTo.near;

    if (cameraIsPerspective) {
        cameraToApplyTo.aspect = newCamera.aspect;
        cameraToApplyTo.filmGauge = newCamera.filmGauge;
        cameraToApplyTo.filmOffset = newCamera.filmOffset;
        cameraToApplyTo.fov = newCamera.fov;
    }
    cameraToApplyTo.updateMatrixWorld();
    cameraToApplyTo.updateProjectionMatrix();
}

// TODO add lerpCamera
