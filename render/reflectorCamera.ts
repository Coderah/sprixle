import {
    Color,
    Matrix4,
    Mesh,
    PerspectiveCamera,
    Plane,
    ShaderMaterial,
    UniformsUtils,
    Vector3,
    Vector4,
    WebGLRenderTarget,
    HalfFloatType,
    NoToneMapping,
    Object3D,
    WebGLRenderer,
    Scene,
    Camera,
    BufferGeometry,
    LinearFilter,
    CameraHelper,
    LinearMipmapLinearFilter,
} from 'three';

export interface ReflectorOptions {
    color?: Color | string | number;
    textureWidth?: number;
    textureHeight?: number;
    clipBias?: number;
    shader?: object;
    multisample?: number;
    debug?: boolean;
    anisotropy: number;
}

/** A non geometry version of three-stdlib/Reflector requires geometry to be facing 0,0,1 and then the mesh rotated into place.
 * to render apply textureMatrix on position for a uv4 then read with texture2DProj
 */
class Reflector extends Object3D {
    camera: PerspectiveCamera;
    isReflector = true;
    type = 'Reflector';

    textureMatrix: Matrix4;
    renderTarget: WebGLRenderTarget;

    constructor(options: ReflectorOptions = { anisotropy: 0 }) {
        super();

        this.camera = new PerspectiveCamera();

        const scope = this;

        const color =
            options.color !== undefined
                ? new Color(options.color)
                : new Color(0x7f7f7f);
        const textureWidth = options.textureWidth || 512;
        const textureHeight = options.textureHeight || 512;
        const clipBias = options.clipBias || 0;
        const multisample =
            options.multisample !== undefined ? options.multisample : 4;

        //

        const reflectorPlane = new Plane();
        const normal = new Vector3();
        const reflectorWorldPosition = new Vector3();
        const cameraWorldPosition = new Vector3();
        const rotationMatrix = new Matrix4();
        const lookAtPosition = new Vector3(0, 0, -1);
        const clipPlane = new Vector4();

        const view = new Vector3();
        const target = new Vector3();
        const q = new Vector4();

        const textureMatrix = (this.textureMatrix = new Matrix4());
        const virtualCamera = this.camera;

        const renderTarget = (this.renderTarget = new WebGLRenderTarget(
            textureWidth,
            textureHeight,
            {
                samples: multisample,
                type: HalfFloatType,
                magFilter: LinearFilter,
                minFilter: LinearMipmapLinearFilter,
                anisotropy: options.anisotropy,
                generateMipmaps: true,
            }
        ));

        const cameraHelper = new CameraHelper(this.camera);

        this.render = function (renderer, scene, camera) {
            if (options.debug) scene.add(cameraHelper);
            // console.log('reflector onBeforeRender');
            reflectorWorldPosition.setFromMatrixPosition(scope.matrixWorld);
            cameraWorldPosition.setFromMatrixPosition(camera.matrixWorld);

            rotationMatrix.extractRotation(scope.matrixWorld);

            normal.set(0, 0, 1);
            normal.applyMatrix4(rotationMatrix);

            view.subVectors(reflectorWorldPosition, cameraWorldPosition);

            // Avoid rendering when reflector is facing away

            if (view.dot(normal) > 0) return;

            view.reflect(normal).negate();
            view.add(reflectorWorldPosition);

            rotationMatrix.extractRotation(camera.matrixWorld);

            lookAtPosition.set(0, 0, -1);
            lookAtPosition.applyMatrix4(rotationMatrix);
            lookAtPosition.add(cameraWorldPosition);

            target.subVectors(reflectorWorldPosition, lookAtPosition);
            target.reflect(normal).negate();
            target.add(reflectorWorldPosition);

            virtualCamera.position.copy(view);
            virtualCamera.up.set(0, 1, 0);
            virtualCamera.up.applyMatrix4(rotationMatrix);
            virtualCamera.up.reflect(normal);
            virtualCamera.lookAt(target);

            virtualCamera.near = camera.near;
            virtualCamera.far = camera.far; // Used in WebGLBackground

            virtualCamera.updateMatrixWorld();
            virtualCamera.projectionMatrix.copy(camera.projectionMatrix);

            // Update the texture matrix
            textureMatrix.set(
                0.5,
                0.0,
                0.0,
                0.5,
                0.0,
                0.5,
                0.0,
                0.5,
                0.0,
                0.0,
                0.5,
                0.5,
                0.0,
                0.0,
                0.0,
                1.0
            );
            textureMatrix.multiply(virtualCamera.projectionMatrix);
            textureMatrix.multiply(virtualCamera.matrixWorldInverse);
            textureMatrix.multiply(scope.matrixWorld);

            // Now update projection matrix with new clip plane, implementing code from: http://www.terathon.com/code/oblique.html
            // Paper explaining this technique: http://www.terathon.com/lengyel/Lengyel-Oblique.pdf
            reflectorPlane.setFromNormalAndCoplanarPoint(
                normal,
                reflectorWorldPosition
            );
            reflectorPlane.applyMatrix4(virtualCamera.matrixWorldInverse);

            clipPlane.set(
                reflectorPlane.normal.x,
                reflectorPlane.normal.y,
                reflectorPlane.normal.z,
                reflectorPlane.constant
            );

            const projectionMatrix = virtualCamera.projectionMatrix;

            q.x =
                (Math.sign(clipPlane.x) + projectionMatrix.elements[8]) /
                projectionMatrix.elements[0];
            q.y =
                (Math.sign(clipPlane.y) + projectionMatrix.elements[9]) /
                projectionMatrix.elements[5];
            q.z = -1.0;
            q.w =
                (1.0 + projectionMatrix.elements[10]) /
                projectionMatrix.elements[14];

            // Calculate the scaled plane vector
            clipPlane.multiplyScalar(2.0 / clipPlane.dot(q));

            // Replacing the third row of the projection matrix
            projectionMatrix.elements[2] = clipPlane.x;
            projectionMatrix.elements[6] = clipPlane.y;
            projectionMatrix.elements[10] = clipPlane.z + 1.0 - clipBias;
            projectionMatrix.elements[14] = clipPlane.w;

            // Render
            scope.visible = false;

            const currentRenderTarget = renderer.getRenderTarget();

            const currentXrEnabled = renderer.xr.enabled;
            const currentShadowAutoUpdate = renderer.shadowMap.autoUpdate;
            const currentToneMapping = renderer.toneMapping;

            let isSRGB = false;
            if ('outputColorSpace' in renderer)
                isSRGB = renderer.outputColorSpace === 'srgb';
            else isSRGB = renderer.outputEncoding === 3001; // sRGBEncoding

            renderer.xr.enabled = false; // Avoid camera modification
            renderer.shadowMap.autoUpdate = false; // Avoid re-computing shadows
            if ('outputColorSpace' in renderer)
                renderer.outputColorSpace = 'srgb-linear';
            else renderer.outputEncoding = 3000; // LinearEncoding
            renderer.toneMapping = NoToneMapping;

            renderer.setRenderTarget(renderTarget);

            renderer.state.buffers.depth.setMask(true); // make sure the depth buffer is writable so it can be properly cleared, see #18897

            if (renderer.autoClear === false) renderer.clear();
            renderer.render(scene, virtualCamera);
            renderer.xr.enabled = currentXrEnabled;
            renderer.shadowMap.autoUpdate = currentShadowAutoUpdate;
            renderer.toneMapping = currentToneMapping;

            if ('outputColorSpace' in renderer)
                renderer.outputColorSpace = isSRGB ? 'srgb' : 'srgb-linear';
            else renderer.outputEncoding = isSRGB ? 3001 : 3000;

            renderer.setRenderTarget(currentRenderTarget);

            // Restore viewport

            const viewport = camera.viewport;

            if (viewport !== undefined) {
                renderer.state.viewport(viewport);
            }

            scope.visible = true;

            if (options.debug) cameraHelper.update();
        };
    }
    dispose() {
        this.renderTarget.dispose();
    }
}

export { Reflector };
