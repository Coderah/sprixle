import { glsl } from './util';

export const lodBlurFragmentShader = glsl`

// const float PI = 3.14159265358979323846;
// const float blurRadius = 200.0;

// float getBlurRadius()
// {
//     return blurRadius * (1.0 - pow((sin(iTime) + 1.0) * 0.5, 3.0));
// }

// float getLOD(){
//     return (1.0 - pow(1.0 - (getBlurRadius() / blurRadius), 20.0)) * 6.0;
// }

// vec2 getBlurUV(vec2 fragCoord)
// {
//     return floor(fragCoord / getBlurRadius()) * getBlurRadius() / iResolution.xy;
// }

// vec2 getInterpolationDistance(vec2 fragCoord)
// {
//     return mod(fragCoord, getBlurRadius()) / getBlurRadius();
// }

// vec4 cosLerp(vec4 x, vec4 y, float a)
// {
//     float cos_a = (1.0 - cos(a * PI)) / 2.0;
//     return x * (1.0 - cos_a) + y * cos_a;
// }

// void mainImage( out vec4 fragColor, in vec2 fragCoord )
// {    
//     vec4 bottomLeft = textureLod(iChannel0, getBlurUV(fragCoord), getLOD());
//     vec4 bottomRight = textureLod(iChannel0, getBlurUV(fragCoord + vec2(getBlurRadius(), 0)), getLOD());
//     vec4 topLeft = textureLod(iChannel0, getBlurUV(fragCoord + vec2(0, getBlurRadius())), getLOD());
//     vec4 topRight = textureLod(iChannel0, getBlurUV(fragCoord + vec2(getBlurRadius(), getBlurRadius())), getLOD());

//     vec2 interpolation = getInterpolationDistance(fragCoord);

//     vec4 bottom = cosLerp(bottomLeft, bottomRight, interpolation.x);
//     vec4 top = cosLerp(topLeft, topRight, interpolation.x);
    
//     fragColor = cosLerp(bottom, top, interpolation.y);
// }

// const float PI = 3.14159265358979323846;
// const float blurRadius = 200.0;
// #define PI 3.14159265358979323846
#define BLUR_SCALE 1.

float getLOD(in float blurRadius){
    return (1.0 - pow(1.0 - (BLUR_SCALE / blurRadius), 20.0)) * 6.0;
}

vec2 getBlurUV(in vec2 uv)
{
    return uv;
}

vec2 getInterpolationDistance(in vec2 uv)
{
    return mod(uv, BLUR_SCALE) / BLUR_SCALE;
}

vec4 cosLerp(in vec4 x, in vec4 y, in float a)
{
    float cos_a = (1.0 - cos(a * PI)) / 2.0;
    return x * (1.0 - cos_a) + y * cos_a;
}

vec4 lodBlur(in sampler2D texture, in vec2 uv, in float blurRadius )
{    
    float LOD = 2.;
    vec4 bottomLeft = textureLod(texture, getBlurUV(uv), LOD);
    vec4 bottomRight = textureLod(texture, getBlurUV(uv + vec2(blurRadius, 0)), LOD);
    vec4 topLeft = textureLod(texture, getBlurUV(uv + vec2(0, blurRadius)), LOD);
    vec4 topRight = textureLod(texture, getBlurUV(uv + vec2(blurRadius)), LOD);

    vec2 interpolation = getInterpolationDistance(uv);

    vec4 bottom = cosLerp(bottomLeft, bottomRight, interpolation.x);
    vec4 top = cosLerp(topLeft, topRight, interpolation.x);
    
    return cosLerp(bottom, top, interpolation.y);
}`;
