import { glsl } from '../../../shader/util';

const shaderIncludes = {
    mapRange: glsl`
float mapRange(float value, float inMin, float inMax, float outMin, float outMax) {
    return outMin + (value - inMin) * (outMax - outMin) / (inMax - inMin);
}
vec2 mapRange(vec2 value, vec2 inMin, vec2 inMax, vec2 outMin, vec2 outMax) {
    return outMin + (value - inMin) * (outMax - outMin) / (inMax - inMin);
}
vec3 mapRange(vec3 value, vec3 inMin, vec3 inMax, vec3 outMin, vec3 outMax) {
    return outMin + (value - inMin) * (outMax - outMin) / (inMax - inMin);
}
vec4 mapRange(vec4 value, vec4 inMin, vec4 inMax, vec4 outMin, vec4 outMax) {
    return outMin + (value - inMin) * (outMax - outMin) / (inMax - inMin);
}
`,
    mappingNode: glsl`
vec3 mappingNode(vec3 vector, vec3 location, vec3 rotation, vec3 scale) {
    
    // Scaling
    vector *= scale;
    
    // 3D Rotation (using rotation matrices)
    float sx = sin(rotation.x);
    float sy = sin(rotation.y);
    float sz = sin(rotation.z);
    float cx = cos(rotation.x);
    float cy = cos(rotation.y);
    float cz = cos(rotation.z);
    
    mat3 rot_mat = mat3(
        cy * cz, cy * sz, -sy,
        sx * sy * cz - cx * sz, sx * sy * sz + cx * cz, sx * cy,
        cx * sy * cz + sx * sz, cx * sy * sz - sx * cz, cx * cy
    );
    vector = rot_mat * vector;

    // Translation
    vector += location;


    return vector;
}`,
    colorRamp: glsl`
float compute_color_map_coordinate(float coordinate)
{
  /* Color maps have a fixed width of 257. We offset by the equivalent of half a pixel and scale
   * down such that the normalized coordinate 1.0 corresponds to the center of the last pixel. */
  const float sampler_resolution = 257.0;
  const float sampler_offset = 0.5 / sampler_resolution;
  const float sampler_scale = 1.0 - (1.0 / sampler_resolution);
  return coordinate * sampler_scale + sampler_offset;
}`,
    LUT: glsl`vec4 lookup(in vec4 textureColor, in sampler2D lookupTable) {
    #ifndef LUT_NO_CLAMP
        textureColor = clamp(textureColor, 0.0, 1.0);
    #endif

    mediump float blueColor = textureColor.b * 63.0;

    mediump vec2 quad1;
    quad1.y = floor(floor(blueColor) / 8.0);
    quad1.x = floor(blueColor) - (quad1.y * 8.0);

    mediump vec2 quad2;
    quad2.y = floor(ceil(blueColor) / 8.0);
    quad2.x = ceil(blueColor) - (quad2.y * 8.0);

    highp vec2 texPos1;
    texPos1.x = (quad1.x * 0.125) + 0.5/512.0 + ((0.125 - 1.0/512.0) * textureColor.r);
    texPos1.y = (quad1.y * 0.125) + 0.5/512.0 + ((0.125 - 1.0/512.0) * textureColor.g);

    #ifdef LUT_FLIP_Y
        texPos1.y = 1.0-texPos1.y;
    #endif

    highp vec2 texPos2;
    texPos2.x = (quad2.x * 0.125) + 0.5/512.0 + ((0.125 - 1.0/512.0) * textureColor.r);
    texPos2.y = (quad2.y * 0.125) + 0.5/512.0 + ((0.125 - 1.0/512.0) * textureColor.g);

    #ifdef LUT_FLIP_Y
        texPos2.y = 1.0-texPos2.y;
    #endif

    lowp vec4 newColor1 = texture2D(lookupTable, texPos1);
    lowp vec4 newColor2 = texture2D(lookupTable, texPos2);

    lowp vec4 newColor = mix(newColor1, newColor2, fract(blueColor));
    return newColor;
}`,
};

export default shaderIncludes;
