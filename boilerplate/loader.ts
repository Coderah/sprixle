import { TextureLoader } from "three";
import { DRACOLoader, GLTFLoader } from "three-stdlib";

export const gltfLoader = new GLTFLoader();

const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath('/examples/js/libs/draco/');
gltfLoader.setDRACOLoader(dracoLoader);

export const textureLoader = new TextureLoader();