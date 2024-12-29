import { glsl } from '../../../../shader/util';

export default glsl`
/* SPDX-FileCopyrightText: 2019-2023 Blender Authors
 *
 * SPDX-License-Identifier: GPL-2.0-or-later */

/* The following offset functions generate random offsets to be added to texture
 * coordinates to act as a seed since the noise functions don't have seed values.
 * A seed value is needed for generating distortion textures and color outputs.
 * The offset's components are in the range [100, 200], not too high to cause
 * bad precision and not too small to be noticeable. We use float seed because
 * OSL only support float hashes.
 */

#include "gpu_shader_common_hash.glsl"
// #include "gpu_shader_material_fractal_noise.glsl"
// #include "gpu_shader_material_noise.glsl"
// #include 


/* clang-format off */
#define FLOORFRAC(x, x_int, x_fract) { float x_floor = floor(x); x_int = int(x_floor); x_fract = x - x_floor; }
/* clang-format on */

/* Bilinear Interpolation:
 *
 * v2          v3
 *  @ + + + + @       y
 *  +         +       ^
 *  +         +       |
 *  +         +       |
 *  @ + + + + @       @------> x
 * v0          v1
 */
float bi_mix(float v0, float v1, float v2, float v3, float x, float y)
{
  float x1 = 1.0 - x;
  return (1.0 - y) * (v0 * x1 + v1 * x) + y * (v2 * x1 + v3 * x);
}

/* Trilinear Interpolation:
 *
 *   v6               v7
 *     @ + + + + + + @
 *     +\            +\
 *     + \           + \
 *     +  \          +  \
 *     +   \ v4      +   \ v5
 *     +    @ + + + +++ + @          z
 *     +    +        +    +      y   ^
 *  v2 @ + +++ + + + @ v3 +       \  |
 *      \   +         \   +        \ |
 *       \  +          \  +         \|
 *        \ +           \ +          +---------> x
 *         \+            \+
 *          @ + + + + + + @
 *        v0               v1
 */
float tri_mix(float v0,
              float v1,
              float v2,
              float v3,
              float v4,
              float v5,
              float v6,
              float v7,
              float x,
              float y,
              float z)
{
  float x1 = 1.0 - x;
  float y1 = 1.0 - y;
  float z1 = 1.0 - z;
  return z1 * (y1 * (v0 * x1 + v1 * x) + y * (v2 * x1 + v3 * x)) +
         z * (y1 * (v4 * x1 + v5 * x) + y * (v6 * x1 + v7 * x));
}

float compatible_fmod(float a, float b)
{
  if (b != 0.0) {
    int N = int(a / b);
    return a - float(N) * b;
  }
  return 0.0;
}
vec2 compatible_fmod(vec2 a, float b)
{
  return vec2(compatible_fmod(a.x, b), compatible_fmod(a.y, b));
}

vec3 compatible_fmod(vec3 a, float b)
{
  return vec3(compatible_fmod(a.x, b), compatible_fmod(a.y, b), compatible_fmod(a.z, b));
}

vec4 compatible_fmod(vec4 a, float b)
{
  return vec4(compatible_fmod(a.x, b),
              compatible_fmod(a.y, b),
              compatible_fmod(a.z, b),
              compatible_fmod(a.w, b));
}

float quad_mix(float v0,
               float v1,
               float v2,
               float v3,
               float v4,
               float v5,
               float v6,
               float v7,
               float v8,
               float v9,
               float v10,
               float v11,
               float v12,
               float v13,
               float v14,
               float v15,
               float x,
               float y,
               float z,
               float w)
{
  return mix(tri_mix(v0, v1, v2, v3, v4, v5, v6, v7, x, y, z),
             tri_mix(v8, v9, v10, v11, v12, v13, v14, v15, x, y, z),
             w);
}

float fade(float t)
{
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

float negate_if(float value, uint condition)
{
  return (condition != 0u) ? -value : value;
}

float noise_grad(uint hash, float x)
{
  uint h = hash & 15u;
  float g = float(1u + (h & 7u));
  return negate_if(g, h & 8u) * x;
}

float noise_grad(uint hash, float x, float y)
{
  uint h = hash & 7u;
  float u = h < 4u ? x : y;
  float v = 2.0 * (h < 4u ? y : x);
  return negate_if(u, h & 1u) + negate_if(v, h & 2u);
}

float noise_grad(uint hash, float x, float y, float z)
{
  uint h = hash & 15u;
  float u = h < 8u ? x : y;
  float vt = ((h == 12u) || (h == 14u)) ? x : z;
  float v = h < 4u ? y : vt;
  return negate_if(u, h & 1u) + negate_if(v, h & 2u);
}

float noise_grad(uint hash, float x, float y, float z, float w)
{
  uint h = hash & 31u;
  float u = h < 24u ? x : y;
  float v = h < 16u ? y : z;
  float s = h < 8u ? z : w;
  return negate_if(u, h & 1u) + negate_if(v, h & 2u) + negate_if(s, h & 4u);
}

float noise_perlin(float x)
{
  int X;
  float fx;

  FLOORFRAC(x, X, fx);

  float u = fade(fx);

  float r = mix(noise_grad(hash_int(X), fx), noise_grad(hash_int(X + 1), fx - 1.0), u);

  return r;
}

float noise_perlin(vec2 vec)
{
  int X, Y;
  float fx, fy;

  FLOORFRAC(vec.x, X, fx);
  FLOORFRAC(vec.y, Y, fy);

  float u = fade(fx);
  float v = fade(fy);

  float r = bi_mix(noise_grad(hash_int2(X, Y), fx, fy),
                   noise_grad(hash_int2(X + 1, Y), fx - 1.0, fy),
                   noise_grad(hash_int2(X, Y + 1), fx, fy - 1.0),
                   noise_grad(hash_int2(X + 1, Y + 1), fx - 1.0, fy - 1.0),
                   u,
                   v);

  return r;
}

float noise_perlin(vec3 vec)
{
  int X, Y, Z;
  float fx, fy, fz;

  FLOORFRAC(vec.x, X, fx);
  FLOORFRAC(vec.y, Y, fy);
  FLOORFRAC(vec.z, Z, fz);

  float u = fade(fx);
  float v = fade(fy);
  float w = fade(fz);

  float r = tri_mix(noise_grad(hash_int3(X, Y, Z), fx, fy, fz),
                    noise_grad(hash_int3(X + 1, Y, Z), fx - 1., fy, fz),
                    noise_grad(hash_int3(X, Y + 1, Z), fx, fy - 1., fz),
                    noise_grad(hash_int3(X + 1, Y + 1, Z), fx - 1., fy - 1., fz),
                    noise_grad(hash_int3(X, Y, Z + 1), fx, fy, fz - 1.),
                    noise_grad(hash_int3(X + 1, Y, Z + 1), fx - 1., fy, fz - 1.),
                    noise_grad(hash_int3(X, Y + 1, Z + 1), fx, fy - 1., fz - 1.),
                    noise_grad(hash_int3(X + 1, Y + 1, Z + 1), fx - 1., fy - 1., fz - 1.),
                    u,
                    v,
                    w);

  return r;
}

float noise_perlin(vec4 vec)
{
  int X, Y, Z, W;
  float fx, fy, fz, fw;

  FLOORFRAC(vec.x, X, fx);
  FLOORFRAC(vec.y, Y, fy);
  FLOORFRAC(vec.z, Z, fz);
  FLOORFRAC(vec.w, W, fw);

  float u = fade(fx);
  float v = fade(fy);
  float t = fade(fz);
  float s = fade(fw);

  float r = quad_mix(
      noise_grad(hash_int4(X, Y, Z, W), fx, fy, fz, fw),
      noise_grad(hash_int4(X + 1, Y, Z, W), fx - 1.0, fy, fz, fw),
      noise_grad(hash_int4(X, Y + 1, Z, W), fx, fy - 1.0, fz, fw),
      noise_grad(hash_int4(X + 1, Y + 1, Z, W), fx - 1.0, fy - 1.0, fz, fw),
      noise_grad(hash_int4(X, Y, Z + 1, W), fx, fy, fz - 1.0, fw),
      noise_grad(hash_int4(X + 1, Y, Z + 1, W), fx - 1.0, fy, fz - 1.0, fw),
      noise_grad(hash_int4(X, Y + 1, Z + 1, W), fx, fy - 1.0, fz - 1.0, fw),
      noise_grad(hash_int4(X + 1, Y + 1, Z + 1, W), fx - 1.0, fy - 1.0, fz - 1.0, fw),
      noise_grad(hash_int4(X, Y, Z, W + 1), fx, fy, fz, fw - 1.0),
      noise_grad(hash_int4(X + 1, Y, Z, W + 1), fx - 1.0, fy, fz, fw - 1.0),
      noise_grad(hash_int4(X, Y + 1, Z, W + 1), fx, fy - 1.0, fz, fw - 1.0),
      noise_grad(hash_int4(X + 1, Y + 1, Z, W + 1), fx - 1.0, fy - 1.0, fz, fw - 1.0),
      noise_grad(hash_int4(X, Y, Z + 1, W + 1), fx, fy, fz - 1.0, fw - 1.0),
      noise_grad(hash_int4(X + 1, Y, Z + 1, W + 1), fx - 1.0, fy, fz - 1.0, fw - 1.0),
      noise_grad(hash_int4(X, Y + 1, Z + 1, W + 1), fx, fy - 1.0, fz - 1.0, fw - 1.0),
      noise_grad(hash_int4(X + 1, Y + 1, Z + 1, W + 1), fx - 1.0, fy - 1.0, fz - 1.0, fw - 1.0),
      u,
      v,
      t,
      s);

  return r;
}

/* Remap the output of noise to a predictable range [-1, 1].
 * The scale values were computed experimentally by the OSL developers.
 */
float noise_scale1(float result)
{
  return 0.2500 * result;
}

float noise_scale2(float result)
{
  return 0.6616 * result;
}

float noise_scale3(float result)
{
  return 0.9820 * result;
}

float noise_scale4(float result)
{
  return 0.8344 * result;
}

/* Safe Signed And Unsigned Noise */

float snoise(float p)
{
  float precision_correction = 0.5 * float(abs(p) >= 1000000.0);
  /* Repeat Perlin noise texture every 100000.0 on each axis to prevent floating point
   * representation issues. */
  p = compatible_fmod(p, 100000.0) + precision_correction;

  return noise_scale1(noise_perlin(p));
}

float noise(float p)
{
  return 0.5 * snoise(p) + 0.5;
}

float snoise(vec2 p)
{
  vec2 precision_correction = 0.5 *
                              vec2(float(abs(p.x) >= 1000000.0), float(abs(p.y) >= 1000000.0));
  /* Repeat Perlin noise texture every 100000.0 on each axis to prevent floating point
   * representation issues. This causes discontinuities every 100000.0, however at such scales this
   * usually shouldn't be noticeable. */
  p = compatible_fmod(p, 100000.0) + precision_correction;

  return noise_scale2(noise_perlin(p));
}

float noise(vec2 p)
{
  return 0.5 * snoise(p) + 0.5;
}

float snoise(vec3 p)
{
  vec3 precision_correction = 0.5 * vec3(float(abs(p.x) >= 1000000.0),
                                         float(abs(p.y) >= 1000000.0),
                                         float(abs(p.z) >= 1000000.0));
  /* Repeat Perlin noise texture every 100000.0 on each axis to prevent floating point
   * representation issues. This causes discontinuities every 100000.0, however at such scales this
   * usually shouldn't be noticeable. */
  p = compatible_fmod(p, 100000.0) + precision_correction;

  return noise_scale3(noise_perlin(p));
}

float noise(vec3 p)
{
  return 0.5 * snoise(p) + 0.5;
}

float snoise(vec4 p)
{
  vec4 precision_correction = 0.5 * vec4(float(abs(p.x) >= 1000000.0),
                                         float(abs(p.y) >= 1000000.0),
                                         float(abs(p.z) >= 1000000.0),
                                         float(abs(p.w) >= 1000000.0));
  /* Repeat Perlin noise texture every 100000.0 on each axis to prevent floating point
   * representation issues. This causes discontinuities every 100000.0, however at such scales this
   * usually shouldn't be noticeable. */
  p = compatible_fmod(p, 100000.0) + precision_correction;

  return noise_scale4(noise_perlin(p));
}

float noise(vec4 p)
{
  return 0.5 * snoise(p) + 0.5;
}

// float snoise(float p) {
//     return fract(sin(p * 12.9898) * 43758.5453);
// }

// // Simple 2D noise function
// float snoise(vec2 p) {
//     return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
// }

// // Simple 3D noise function
// float snoise(vec3 p) {
//     return fract(sin(dot(p, vec3(12.9898, 78.233, 45.164))) * 43758.5453);
// }

// // Simple 4D noise function
// float snoise(vec4 p) {
//     return fract(sin(dot(p, vec4(12.9898, 78.233, 45.164, 23.032))) * 43758.5453);
// }

float safe_snoise(float p) {
    return snoise(p);
}

float safe_snoise(vec2 p) {
    return snoise(p);
}

float safe_snoise(vec3 p) {
    return snoise(p);
}

float safe_snoise(vec4 p) {
    return snoise(p);
}

/* SPDX-FileCopyrightText: 2019-2023 Blender Authors
 *
 * SPDX-License-Identifier: GPL-2.0-or-later */

// #include "gpu_shader_common_hash.glsl"
// #include "gpu_shader_material_noise.glsl"

#define NOISE_FBM(T) \
  float noise_fbm(T co, float detail, float roughness, float lacunarity,float offset, float gain, bool use_normalize) \
  { \
    T p = co; \
    float fscale = 1.0; \
    float amp = 1.0; \
    float maxamp = 0.0; \
    float sum = 0.0; \
\
    for (int i = 0; i <= int(detail); i++) { \
      float t = safe_snoise(fscale * p); \
      sum += t * amp; \
      maxamp += amp; \
      amp *= roughness; \
      fscale *= lacunarity; \
    } \
    float rmd = detail - floor(detail); \
    if (rmd != 0.0) { \
      float t = safe_snoise(fscale * p); \
      float sum2 = sum + t * amp; \
      return use_normalize ? \
                 mix(0.5 * sum / maxamp + 0.5, 0.5 * sum2 / (maxamp + amp) + 0.5, rmd) : \
                 mix(sum, sum2, rmd); \
    } \
    else { \
      return use_normalize ? 0.5 * sum / maxamp + 0.5 : sum; \
    } \
  }

#define NOISE_MULTI_FRACTAL(T) \
  float noise_multi_fractal(T co, \
                            float detail, \
                            float roughness, \
                            float lacunarity, \
                            float offset, \
                            float gain, \
                            bool normalize) \
  { \
    T p = co; \
    float value = 1.0; \
    float pwr = 1.0; \
\
    for (int i = 0; i <= int(detail); i++) { \
      value *= (pwr * snoise(p) + 1.0); \
      pwr *= roughness; \
      p *= lacunarity; \
    } \
\
    float rmd = detail - floor(detail); \
    if (rmd != 0.0) { \
      value *= (rmd * pwr * snoise(p) + 1.0); /* correct? */ \
    } \
\
    return value; \
  }

#define NOISE_HETERO_TERRAIN(T) \
  float noise_hetero_terrain(T co, \
                             float detail, \
                             float roughness, \
                             float lacunarity, \
                             float offset, \
                             float gain, \
                             bool normalize) \
  { \
    T p = co; \
    float pwr = roughness; \
\
    /* first unscaled octave of function; later octaves are scaled */ \
    float value = offset + snoise(p); \
    p *= lacunarity; \
\
    for (int i = 1; i <= int(detail); i++) { \
      float increment = (snoise(p) + offset) * pwr * value; \
      value += increment; \
      pwr *= roughness; \
      p *= lacunarity; \
    } \
\
    float rmd = detail - floor(detail); \
    if (rmd != 0.0) { \
      float increment = (snoise(p) + offset) * pwr * value; \
      value += rmd * increment; \
    } \
\
    return value; \
  }

#define NOISE_HYBRID_MULTI_FRACTAL(T) \
  float noise_hybrid_multi_fractal(T co, \
                                   float detail, \
                                   float roughness, \
                                   float lacunarity, \
                                   float offset, \
                                   float gain, \
                                   bool normalize) \
  { \
    T p = co; \
    float pwr = 1.0; \
    float value = 0.0; \
    float weight = 1.0; \
\
    for (int i = 0; (weight > 0.001) && (i <= int(detail)); i++) { \
      if (weight > 1.0) { \
        weight = 1.0; \
      } \
\
      float signal = (snoise(p) + offset) * pwr; \
      pwr *= roughness; \
      value += weight * signal; \
      weight *= gain * signal; \
      p *= lacunarity; \
    } \
\
    float rmd = detail - floor(detail); \
    if ((rmd != 0.0) && (weight > 0.001)) { \
      if (weight > 1.0) { \
        weight = 1.0; \
      } \
      float signal = (snoise(p) + offset) * pwr; \
      value += rmd * weight * signal; \
    } \
\
    return value; \
  }

#define NOISE_RIDGED_MULTI_FRACTAL(T) \
  float noise_ridged_multi_fractal(T co, \
                                   float detail, \
                                   float roughness, \
                                   float lacunarity, \
                                   float offset, \
                                   float gain, \
                                   bool normalize) \
  { \
    T p = co; \
    float pwr = roughness; \
\
    float signal = offset - abs(snoise(p)); \
    signal *= signal; \
    float value = signal; \
    float weight = 1.0; \
\
    for (int i = 1; i <= int(detail); i++) { \
      p *= lacunarity; \
      weight = clamp(signal * gain, 0.0, 1.0); \
      signal = offset - abs(snoise(p)); \
      signal *= signal; \
      signal *= weight; \
      value += signal * pwr; \
      pwr *= roughness; \
    } \
\
    return value; \
  }

/* Noise fBM. */

NOISE_FBM(float)
NOISE_FBM(vec2)
NOISE_FBM(vec3)
NOISE_FBM(vec4)

/* Noise Multi-fractal. */

// NOISE_MULTI_FRACTAL(float)
// NOISE_MULTI_FRACTAL(vec2)
// NOISE_MULTI_FRACTAL(vec3)
// NOISE_MULTI_FRACTAL(vec4)

/* Noise Hetero Terrain. */

// NOISE_HETERO_TERRAIN(float)
// NOISE_HETERO_TERRAIN(vec2)
// NOISE_HETERO_TERRAIN(vec3)
// NOISE_HETERO_TERRAIN(vec4)

/* Noise Hybrid Multi-fractal. */

// NOISE_HYBRID_MULTI_FRACTAL(float)
// NOISE_HYBRID_MULTI_FRACTAL(vec2)
// NOISE_HYBRID_MULTI_FRACTAL(vec3)
// NOISE_HYBRID_MULTI_FRACTAL(vec4)

/* Noise Ridged Multi-fractal. */

// NOISE_RIDGED_MULTI_FRACTAL(float)
// NOISE_RIDGED_MULTI_FRACTAL(vec2)
// NOISE_RIDGED_MULTI_FRACTAL(vec3)
// NOISE_RIDGED_MULTI_FRACTAL(vec4)

#define NOISE_FRACTAL_DISTORTED_1D(NOISE_TYPE) \
  if (distortion != 0.0) { \
    p += snoise(p + random_float_offset(0.0)) * distortion; \
  } \
\
  value = NOISE_TYPE(p, detail, roughness, lacunarity, offset, gain, normalize != 0.0); \
  color = vec4(value, \
               NOISE_TYPE(p + random_float_offset(1.0), \
                          detail, \
                          roughness, \
                          lacunarity, \
                          offset, \
                          gain, \
                          normalize != 0.0), \
               NOISE_TYPE(p + random_float_offset(2.0), \
                          detail, \
                          roughness, \
                          lacunarity, \
                          offset, \
                          gain, \
                          normalize != 0.0), \
               1.0);

#define NOISE_FRACTAL_DISTORTED_2D(NOISE_TYPE) \
  if (distortion != 0.0) { \
    p += vec2(snoise(p + random_vec2_offset(0.0)) * distortion, \
              snoise(p + random_vec2_offset(1.0)) * distortion); \
  } \
\
  value = NOISE_TYPE(p, detail, roughness, lacunarity, offset, gain, normalize != 0.0); \
  color = vec4(value, \
               NOISE_TYPE(p + random_vec2_offset(2.0), \
                          detail, \
                          roughness, \
                          lacunarity, \
                          offset, \
                          gain, \
                          normalize != 0.0), \
               NOISE_TYPE(p + random_vec2_offset(3.0), \
                          detail, \
                          roughness, \
                          lacunarity, \
                          offset, \
                          gain, \
                          normalize != 0.0), \
               1.0);

#define NOISE_FRACTAL_DISTORTED_3D(NOISE_TYPE) \
  if (distortion != 0.0) { \
    p += vec3(snoise(p + random_vec3_offset(0.0)) * distortion, \
              snoise(p + random_vec3_offset(1.0)) * distortion, \
              snoise(p + random_vec3_offset(2.0)) * distortion); \
  } \
\
  value = NOISE_TYPE(p, detail, roughness, lacunarity, offset, gain, normalize != 0.0); \
  color = vec4(value, \
               NOISE_TYPE(p + random_vec3_offset(3.0), \
                          detail, \
                          roughness, \
                          lacunarity, \
                          offset, \
                          gain, \
                          normalize != 0.0), \
               NOISE_TYPE(p + random_vec3_offset(4.0), \
                          detail, \
                          roughness, \
                          lacunarity, \
                          offset, \
                          gain, \
                          normalize != 0.0), \
               1.0);

#define NOISE_FRACTAL_DISTORTED_4D(NOISE_TYPE) \
  if (distortion != 0.0) { \
    p += vec4(snoise(p + random_vec4_offset(0.0)) * distortion, \
              snoise(p + random_vec4_offset(1.0)) * distortion, \
              snoise(p + random_vec4_offset(2.0)) * distortion, \
              snoise(p + random_vec4_offset(3.0)) * distortion); \
  } \
\
  value = NOISE_TYPE(p, detail, roughness, lacunarity, offset, gain, normalize != 0.0); \
  color = vec4(value, \
               NOISE_TYPE(p + random_vec4_offset(4.0), \
                          detail, \
                          roughness, \
                          lacunarity, \
                          offset, \
                          gain, \
                          normalize != 0.0), \
               NOISE_TYPE(p + random_vec4_offset(5.0), \
                          detail, \
                          roughness, \
                          lacunarity, \
                          offset, \
                          gain, \
                          normalize != 0.0), \
               1.0);

float random_float_offset(float seed)
{
  return 100.0 + hash_float_to_float(seed) * 100.0;
}

vec2 random_vec2_offset(float seed)
{
  return vec2(100.0 + hash_vec2_to_float(vec2(seed, 0.0)) * 100.0,
              100.0 + hash_vec2_to_float(vec2(seed, 1.0)) * 100.0);
}

vec3 random_vec3_offset(float seed)
{
  return vec3(100.0 + hash_vec2_to_float(vec2(seed, 0.0)) * 100.0,
              100.0 + hash_vec2_to_float(vec2(seed, 1.0)) * 100.0,
              100.0 + hash_vec2_to_float(vec2(seed, 2.0)) * 100.0);
}

vec4 random_vec4_offset(float seed)
{
  return vec4(100.0 + hash_vec2_to_float(vec2(seed, 0.0)) * 100.0,
              100.0 + hash_vec2_to_float(vec2(seed, 1.0)) * 100.0,
              100.0 + hash_vec2_to_float(vec2(seed, 2.0)) * 100.0,
              100.0 + hash_vec2_to_float(vec2(seed, 3.0)) * 100.0);
}

/* Noise fBM */

void node_noise_tex_fbm_1d(vec3 co,
                           float w,
                           float scale,
                           float detail,
                           float roughness,
                           float lacunarity,
                           float offset,
                           float gain,
                           float distortion,
                           float normalize,
                           out float value,
                           out vec4 color)
{
  detail = clamp(detail, 0.0, 15.0);
  roughness = max(roughness, 0.0);

  float p = w * scale;

  NOISE_FRACTAL_DISTORTED_1D(noise_fbm)
}

void node_noise_tex_fbm_2d(vec3 co,
                           float w,
                           float scale,
                           float detail,
                           float roughness,
                           float lacunarity,
                           float offset,
                           float gain,
                           float distortion,
                           float normalize,
                           out float value,
                           out vec4 color)
{
  detail = clamp(detail, 0.0, 15.0);
  roughness = max(roughness, 0.0);

  vec2 p = co.xy * scale;

  NOISE_FRACTAL_DISTORTED_2D(noise_fbm)
}

void node_noise_tex_fbm_3d(vec3 co,
                           float w,
                           float scale,
                           float detail,
                           float roughness,
                           float lacunarity,
                           float offset,
                           float gain,
                           float distortion,
                           float normalize,
                           out float value,
                           out vec4 color)
{
  detail = clamp(detail, 0.0, 15.0);
  roughness = max(roughness, 0.0);

  vec3 p = co * scale;

  NOISE_FRACTAL_DISTORTED_3D(noise_fbm)
}

void node_noise_tex_fbm_4d(vec3 co,
                           float w,
                           float scale,
                           float detail,
                           float roughness,
                           float lacunarity,
                           float offset,
                           float gain,
                           float distortion,
                           float normalize,
                           out float value,
                           out vec4 color)
{
  detail = clamp(detail, 0.0, 15.0);
  roughness = max(roughness, 0.0);

  vec4 p = vec4(co, w) * scale;

  NOISE_FRACTAL_DISTORTED_4D(noise_fbm)
}

/* Noise Multi-fractal. */

// void node_noise_tex_multi_fractal_1d(vec3 co,
//                                      float w,
//                                      float scale,
//                                      float detail,
//                                      float roughness,
//                                      float lacunarity,
//                                      float offset,
//                                      float gain,
//                                      float distortion,
//                                      float normalize,
//                                      out float value,
//                                      out vec4 color)
// {
//   detail = clamp(detail, 0.0, 15.0);
//   roughness = max(roughness, 0.0);

//   float p = w * scale;

//   NOISE_FRACTAL_DISTORTED_1D(noise_multi_fractal)
// }

// void node_noise_tex_multi_fractal_2d(vec3 co,
//                                      float w,
//                                      float scale,
//                                      float detail,
//                                      float roughness,
//                                      float lacunarity,
//                                      float offset,
//                                      float gain,
//                                      float distortion,
//                                      float normalize,
//                                      out float value,
//                                      out vec4 color)
// {
//   detail = clamp(detail, 0.0, 15.0);
//   roughness = max(roughness, 0.0);

//   vec2 p = co.xy * scale;

//   NOISE_FRACTAL_DISTORTED_2D(noise_multi_fractal)
// }

// void node_noise_tex_multi_fractal_3d(vec3 co,
//                                      float w,
//                                      float scale,
//                                      float detail,
//                                      float roughness,
//                                      float lacunarity,
//                                      float offset,
//                                      float gain,
//                                      float distortion,
//                                      float normalize,
//                                      out float value,
//                                      out vec4 color)
// {
//   detail = clamp(detail, 0.0, 15.0);
//   roughness = max(roughness, 0.0);

//   vec3 p = co * scale;

//   NOISE_FRACTAL_DISTORTED_3D(noise_multi_fractal)
// }

// void node_noise_tex_multi_fractal_4d(vec3 co,
//                                      float w,
//                                      float scale,
//                                      float detail,
//                                      float roughness,
//                                      float lacunarity,
//                                      float offset,
//                                      float gain,
//                                      float distortion,
//                                      float normalize,
//                                      out float value,
//                                      out vec4 color)
// {
//   detail = clamp(detail, 0.0, 15.0);
//   roughness = max(roughness, 0.0);

//   vec4 p = vec4(co, w) * scale;

//   NOISE_FRACTAL_DISTORTED_4D(noise_multi_fractal)
// }

// /* Noise Hetero Terrain */

// void node_noise_tex_hetero_terrain_1d(vec3 co,
//                                       float w,
//                                       float scale,
//                                       float detail,
//                                       float roughness,
//                                       float lacunarity,
//                                       float offset,
//                                       float gain,
//                                       float distortion,
//                                       float normalize,
//                                       out float value,
//                                       out vec4 color)
// {
//   detail = clamp(detail, 0.0, 15.0);
//   roughness = max(roughness, 0.0);

//   float p = w * scale;

//   NOISE_FRACTAL_DISTORTED_1D(noise_hetero_terrain)
// }

// void node_noise_tex_hetero_terrain_2d(vec3 co,
//                                       float w,
//                                       float scale,
//                                       float detail,
//                                       float roughness,
//                                       float lacunarity,
//                                       float offset,
//                                       float gain,
//                                       float distortion,
//                                       float normalize,
//                                       out float value,
//                                       out vec4 color)
// {
//   detail = clamp(detail, 0.0, 15.0);
//   roughness = max(roughness, 0.0);

//   vec2 p = co.xy * scale;

//   NOISE_FRACTAL_DISTORTED_2D(noise_hetero_terrain)
// }

// void node_noise_tex_hetero_terrain_3d(vec3 co,
//                                       float w,
//                                       float scale,
//                                       float detail,
//                                       float roughness,
//                                       float lacunarity,
//                                       float offset,
//                                       float gain,
//                                       float distortion,
//                                       float normalize,
//                                       out float value,
//                                       out vec4 color)
// {
//   detail = clamp(detail, 0.0, 15.0);
//   roughness = max(roughness, 0.0);

//   vec3 p = co * scale;

//   NOISE_FRACTAL_DISTORTED_3D(noise_hetero_terrain)
// }

// void node_noise_tex_hetero_terrain_4d(vec3 co,
//                                       float w,
//                                       float scale,
//                                       float detail,
//                                       float roughness,
//                                       float lacunarity,
//                                       float offset,
//                                       float gain,
//                                       float distortion,
//                                       float normalize,
//                                       out float value,
//                                       out vec4 color)
// {
//   detail = clamp(detail, 0.0, 15.0);
//   roughness = max(roughness, 0.0);

//   vec4 p = vec4(co, w) * scale;

//   NOISE_FRACTAL_DISTORTED_4D(noise_hetero_terrain)
// }

// /* Noise Hybrid Multi-fractal. */

// void node_noise_tex_hybrid_multi_fractal_1d(vec3 co,
//                                             float w,
//                                             float scale,
//                                             float detail,
//                                             float roughness,
//                                             float lacunarity,
//                                             float offset,
//                                             float gain,
//                                             float distortion,
//                                             float normalize,
//                                             out float value,
//                                             out vec4 color)
// {
//   detail = clamp(detail, 0.0, 15.0);
//   roughness = max(roughness, 0.0);

//   float p = w * scale;

//   NOISE_FRACTAL_DISTORTED_1D(noise_hybrid_multi_fractal)
// }

// void node_noise_tex_hybrid_multi_fractal_2d(vec3 co,
//                                             float w,
//                                             float scale,
//                                             float detail,
//                                             float roughness,
//                                             float lacunarity,
//                                             float offset,
//                                             float gain,
//                                             float distortion,
//                                             float normalize,
//                                             out float value,
//                                             out vec4 color)
// {
//   detail = clamp(detail, 0.0, 15.0);
//   roughness = max(roughness, 0.0);

//   vec2 p = co.xy * scale;

//   NOISE_FRACTAL_DISTORTED_2D(noise_hybrid_multi_fractal)
// }

// void node_noise_tex_hybrid_multi_fractal_3d(vec3 co,
//                                             float w,
//                                             float scale,
//                                             float detail,
//                                             float roughness,
//                                             float lacunarity,
//                                             float offset,
//                                             float gain,
//                                             float distortion,
//                                             float normalize,
//                                             out float value,
//                                             out vec4 color)
// {
//   detail = clamp(detail, 0.0, 15.0);
//   roughness = max(roughness, 0.0);

//   vec3 p = co * scale;

//   NOISE_FRACTAL_DISTORTED_3D(noise_hybrid_multi_fractal)
// }

// void node_noise_tex_hybrid_multi_fractal_4d(vec3 co,
//                                             float w,
//                                             float scale,
//                                             float detail,
//                                             float roughness,
//                                             float lacunarity,
//                                             float offset,
//                                             float gain,
//                                             float distortion,
//                                             float normalize,
//                                             out float value,
//                                             out vec4 color)
// {
//   detail = clamp(detail, 0.0, 15.0);
//   roughness = max(roughness, 0.0);

//   vec4 p = vec4(co, w) * scale;

//   NOISE_FRACTAL_DISTORTED_4D(noise_hybrid_multi_fractal)
// }

// /* Noise Ridged Multi-fractal. */

// void node_noise_tex_ridged_multi_fractal_1d(vec3 co,
//                                             float w,
//                                             float scale,
//                                             float detail,
//                                             float roughness,
//                                             float lacunarity,
//                                             float offset,
//                                             float gain,
//                                             float distortion,
//                                             float normalize,
//                                             out float value,
//                                             out vec4 color)
// {
//   detail = clamp(detail, 0.0, 15.0);
//   roughness = max(roughness, 0.0);

//   float p = w * scale;

//   NOISE_FRACTAL_DISTORTED_1D(noise_ridged_multi_fractal)
// }

// void node_noise_tex_ridged_multi_fractal_2d(vec3 co,
//                                             float w,
//                                             float scale,
//                                             float detail,
//                                             float roughness,
//                                             float lacunarity,
//                                             float offset,
//                                             float gain,
//                                             float distortion,
//                                             float normalize,
//                                             out float value,
//                                             out vec4 color)
// {
//   detail = clamp(detail, 0.0, 15.0);
//   roughness = max(roughness, 0.0);

//   vec2 p = co.xy * scale;

//   NOISE_FRACTAL_DISTORTED_2D(noise_ridged_multi_fractal)
// }

// void node_noise_tex_ridged_multi_fractal_3d(vec3 co,
//                                             float w,
//                                             float scale,
//                                             float detail,
//                                             float roughness,
//                                             float lacunarity,
//                                             float offset,
//                                             float gain,
//                                             float distortion,
//                                             float normalize,
//                                             out float value,
//                                             out vec4 color)
// {
//   detail = clamp(detail, 0.0, 15.0);
//   roughness = max(roughness, 0.0);

//   vec3 p = co * scale;

//   NOISE_FRACTAL_DISTORTED_3D(noise_ridged_multi_fractal)
// }

// void node_noise_tex_ridged_multi_fractal_4d(vec3 co,
//                                             float w,
//                                             float scale,
//                                             float detail,
//                                             float roughness,
//                                             float lacunarity,
//                                             float offset,
//                                             float gain,
//                                             float distortion,
//                                             float normalize,
//                                             out float value,
//                                             out vec4 color)
// {
//   detail = clamp(detail, 0.0, 15.0);
//   roughness = max(roughness, 0.0);

//   vec4 p = vec4(co, w) * scale;

//   NOISE_FRACTAL_DISTORTED_4D(noise_ridged_multi_fractal)
// }

`;
