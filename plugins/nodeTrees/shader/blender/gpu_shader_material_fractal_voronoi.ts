import { glsl } from '../../../../shader/util';

export default glsl`/* SPDX-FileCopyrightText: 2023 Blender Authors
 *
 * SPDX-License-Identifier: GPL-2.0-or-later */

#include "gpu_shader_material_voronoi.glsl"

/* Minimal safe_divide needed by fractal voronoi (replaces gpu_shader_math_vector_safe_lib.glsl) */
vec4 safe_divide(vec4 a, float b) {
  return (b != 0.0) ? (a / b) : vec4(0);
}

/* TODO(jbakker): Deduplicate code when OpenGL backend has been removed.
 * fractal_voronoi_x_fx functions are identical, except for the input parameter.
 * It used to be a macro, but didn't work on legacy drivers. */

/* The fractalization logic is the same as for fBM Noise, except that some additions are replaced
 * by lerps. */
#define FRACTAL_VORONOI_DISTANCE_TO_EDGE_FUNCTION(T) \
  float fractal_voronoi_distance_to_edge(VoronoiParams params, T coord) \
  { \
    float amplitude = 1.0; \
    float max_amplitude = params.max_distance; \
    float scale = 1.0; \
    float dist = 8.0; \
\
    bool zero_input = params.detail == 0.0 || params.roughness == 0.0; \
\
    for (int i = 0; i <= int(ceil(params.detail)); ++i) { \
      float octave_distance = voronoi_distance_to_edge(params, coord * scale); \
\
      if (zero_input) { \
        dist = octave_distance; \
        break; \
      } \
      else if (float(i) <= params.detail) { \
        max_amplitude = mix(max_amplitude, params.max_distance / scale, amplitude); \
        dist = mix(dist, min(dist, octave_distance / scale), amplitude); \
        scale *= params.lacunarity; \
        amplitude *= params.roughness; \
      } \
      else { \
        float remainder = params.detail - floor(params.detail); \
        if (remainder != 0.0) { \
          float lerp_amplitude = mix(max_amplitude, params.max_distance / scale, amplitude); \
          max_amplitude = mix(max_amplitude, lerp_amplitude, remainder); \
          float lerp_distance = mix(dist, min(dist, octave_distance / scale), amplitude); \
          dist = mix(dist, min(dist, lerp_distance), remainder); \
        } \
      } \
    } \
\
    if (params.normalize) { \
      dist /= max_amplitude; \
    } \
\
    return dist; \
  }

/* **** 1D Fractal Voronoi **** */

VoronoiOutput fractal_voronoi_x_fx(VoronoiParams params, float coord)
{
  float amplitude = 1.0;
  float max_amplitude = 0.0;
  float scale = 1.0;

  VoronoiOutput Output;
  Output.Distance = 0.0;
  Output.Color = vec3(0.0, 0.0, 0.0);
  Output.Position = vec4(0.0, 0.0, 0.0, 0.0);
  bool zero_input = params.detail == 0.0 || params.roughness == 0.0;

  for (int i = 0; i <= int(ceil(params.detail)); ++i) {
    VoronoiOutput octave;
    if (params.feature == SHD_VORONOI_F2) {
      octave = voronoi_f2(params, coord * scale);
    }
    else if (params.feature == SHD_VORONOI_SMOOTH_F1 && params.smoothness != 0.0) {
      octave = voronoi_smooth_f1(params, coord * scale);
    }
    else {
      octave = voronoi_f1(params, coord * scale);
    }

    if (zero_input) {
      max_amplitude = 1.0;
      Output = octave;
      break;
    }
    else if (float(i) <= params.detail) {
      max_amplitude += amplitude;
      Output.Distance += octave.Distance * amplitude;
      Output.Color += octave.Color * amplitude;
      Output.Position = mix(Output.Position, octave.Position / scale, amplitude);
      scale *= params.lacunarity;
      amplitude *= params.roughness;
    }
    else {
      float remainder = params.detail - floor(params.detail);
      if (remainder != 0.0) {
        max_amplitude = mix(max_amplitude, max_amplitude + amplitude, remainder);
        Output.Distance = mix(
            Output.Distance, Output.Distance + octave.Distance * amplitude, remainder);
        Output.Color = mix(Output.Color, Output.Color + octave.Color * amplitude, remainder);
        Output.Position = mix(
            Output.Position, mix(Output.Position, octave.Position / scale, amplitude), remainder);
      }
    }
  }

  if (params.normalize) {
    Output.Distance /= max_amplitude * params.max_distance;
    Output.Color /= max_amplitude;
  }

  Output.Position = safe_divide(Output.Position, params.scale);

  return Output;
}

FRACTAL_VORONOI_DISTANCE_TO_EDGE_FUNCTION(float)

/* **** 2D Fractal Voronoi **** */

VoronoiOutput fractal_voronoi_x_fx(VoronoiParams params, vec2 coord)
{
  float amplitude = 1.0;
  float max_amplitude = 0.0;
  float scale = 1.0;

  VoronoiOutput Output;
  Output.Distance = 0.0;
  Output.Color = vec3(0.0, 0.0, 0.0);
  Output.Position = vec4(0.0, 0.0, 0.0, 0.0);
  bool zero_input = params.detail == 0.0 || params.roughness == 0.0;

  for (int i = 0; i <= int(ceil(params.detail)); ++i) {
    VoronoiOutput octave;
    if (params.feature == SHD_VORONOI_F2) {
      octave = voronoi_f2(params, coord * scale);
    }
    else if (params.feature == SHD_VORONOI_SMOOTH_F1 && params.smoothness != 0.0) {
      octave = voronoi_smooth_f1(params, coord * scale);
    }
    else {
      octave = voronoi_f1(params, coord * scale);
    }

    if (zero_input) {
      max_amplitude = 1.0;
      Output = octave;
      break;
    }
    else if (float(i) <= params.detail) {
      max_amplitude += amplitude;
      Output.Distance += octave.Distance * amplitude;
      Output.Color += octave.Color * amplitude;
      Output.Position = mix(Output.Position, octave.Position / scale, amplitude);
      scale *= params.lacunarity;
      amplitude *= params.roughness;
    }
    else {
      float remainder = params.detail - floor(params.detail);
      if (remainder != 0.0) {
        max_amplitude = mix(max_amplitude, max_amplitude + amplitude, remainder);
        Output.Distance = mix(
            Output.Distance, Output.Distance + octave.Distance * amplitude, remainder);
        Output.Color = mix(Output.Color, Output.Color + octave.Color * amplitude, remainder);
        Output.Position = mix(
            Output.Position, mix(Output.Position, octave.Position / scale, amplitude), remainder);
      }
    }
  }

  if (params.normalize) {
    Output.Distance /= max_amplitude * params.max_distance;
    Output.Color /= max_amplitude;
  }

  Output.Position = safe_divide(Output.Position, params.scale);

  return Output;
}

FRACTAL_VORONOI_DISTANCE_TO_EDGE_FUNCTION(vec2)

/* **** 3D Fractal Voronoi **** */

VoronoiOutput fractal_voronoi_x_fx(VoronoiParams params, vec3 coord)
{
  float amplitude = 1.0;
  float max_amplitude = 0.0;
  float scale = 1.0;

  VoronoiOutput Output;
  Output.Distance = 0.0;
  Output.Color = vec3(0.0, 0.0, 0.0);
  Output.Position = vec4(0.0, 0.0, 0.0, 0.0);
  bool zero_input = params.detail == 0.0 || params.roughness == 0.0;

  for (int i = 0; i <= int(ceil(params.detail)); ++i) {
    VoronoiOutput octave;
    if (params.feature == SHD_VORONOI_F2) {
      octave = voronoi_f2(params, coord * scale);
    }
    else if (params.feature == SHD_VORONOI_SMOOTH_F1 && params.smoothness != 0.0) {
      octave = voronoi_smooth_f1(params, coord * scale);
    }
    else {
      octave = voronoi_f1(params, coord * scale);
    }

    if (zero_input) {
      max_amplitude = 1.0;
      Output = octave;
      break;
    }
    else if (float(i) <= params.detail) {
      max_amplitude += amplitude;
      Output.Distance += octave.Distance * amplitude;
      Output.Color += octave.Color * amplitude;
      Output.Position = mix(Output.Position, octave.Position / scale, amplitude);
      scale *= params.lacunarity;
      amplitude *= params.roughness;
    }
    else {
      float remainder = params.detail - floor(params.detail);
      if (remainder != 0.0) {
        max_amplitude = mix(max_amplitude, max_amplitude + amplitude, remainder);
        Output.Distance = mix(
            Output.Distance, Output.Distance + octave.Distance * amplitude, remainder);
        Output.Color = mix(Output.Color, Output.Color + octave.Color * amplitude, remainder);
        Output.Position = mix(
            Output.Position, mix(Output.Position, octave.Position / scale, amplitude), remainder);
      }
    }
  }

  if (params.normalize) {
    Output.Distance /= max_amplitude * params.max_distance;
    Output.Color /= max_amplitude;
  }

  Output.Position = safe_divide(Output.Position, params.scale);

  return Output;
}

FRACTAL_VORONOI_DISTANCE_TO_EDGE_FUNCTION(vec3)

/* **** 4D Fractal Voronoi **** */

VoronoiOutput fractal_voronoi_x_fx(VoronoiParams params, vec4 coord)
{
  float amplitude = 1.0;
  float max_amplitude = 0.0;
  float scale = 1.0;

  VoronoiOutput Output;
  Output.Distance = 0.0;
  Output.Color = vec3(0.0, 0.0, 0.0);
  Output.Position = vec4(0.0, 0.0, 0.0, 0.0);
  bool zero_input = params.detail == 0.0 || params.roughness == 0.0;

  for (int i = 0; i <= int(ceil(params.detail)); ++i) {
    VoronoiOutput octave;
    if (params.feature == SHD_VORONOI_F2) {
      octave = voronoi_f2(params, coord * scale);
    }
    else if (params.feature == SHD_VORONOI_SMOOTH_F1 && params.smoothness != 0.0) {
      octave = voronoi_smooth_f1(params, coord * scale);
    }
    else {
      octave = voronoi_f1(params, coord * scale);
    }

    if (zero_input) {
      max_amplitude = 1.0;
      Output = octave;
      break;
    }
    else if (float(i) <= params.detail) {
      max_amplitude += amplitude;
      Output.Distance += octave.Distance * amplitude;
      Output.Color += octave.Color * amplitude;
      Output.Position = mix(Output.Position, octave.Position / scale, amplitude);
      scale *= params.lacunarity;
      amplitude *= params.roughness;
    }
    else {
      float remainder = params.detail - floor(params.detail);
      if (remainder != 0.0) {
        max_amplitude = mix(max_amplitude, max_amplitude + amplitude, remainder);
        Output.Distance = mix(
            Output.Distance, Output.Distance + octave.Distance * amplitude, remainder);
        Output.Color = mix(Output.Color, Output.Color + octave.Color * amplitude, remainder);
        Output.Position = mix(
            Output.Position, mix(Output.Position, octave.Position / scale, amplitude), remainder);
      }
    }
  }

  if (params.normalize) {
    Output.Distance /= max_amplitude * params.max_distance;
    Output.Color /= max_amplitude;
  }

  Output.Position = safe_divide(Output.Position, params.scale);

  return Output;
}

FRACTAL_VORONOI_DISTANCE_TO_EDGE_FUNCTION(vec4)`;
