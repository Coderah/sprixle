import { glsl } from '../../../../shader/util';

export default glsl`
/* SPDX-FileCopyrightText: 2019-2022 Blender Authors
 *
 * SPDX-License-Identifier: GPL-2.0-or-later */

#include "gpu_shader_material_fresnel.glsl"

void node_layer_weight(float blend, vec3 N, out float fresnel, out float facing)
{
  N = normalize(N);
  vec3 V = normalize(vViewPosition);

  /* fresnel */
  float eta = max(1.0 - blend, 0.00001);

  fresnel = fresnel_dielectric(V, N, (gl_FrontFacing) ? 1.0 / eta : eta);

  /* facing */
  facing = abs(dot(V, N));
  if (blend != 0.5) {
    blend = clamp(blend, 0.0, 0.99999);
    blend = (blend < 0.5) ? 2.0 * blend : 0.5 / (1.0 - blend);
    facing = pow(facing, blend);
  }
  facing = 1.0 - facing;
}`;
