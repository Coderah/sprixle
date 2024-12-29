import { glsl } from '../../../../shader/util';

export default glsl`
/* SPDX-FileCopyrightText: 2019-2020 Blender Authors
 *
 * SPDX-License-Identifier: GPL-2.0-or-later */

float clamp_value(float value, float min, float max)
{
  return clamp(value, min, max);
}

float clamp_minmax(float value, float min_allowed, float max_allowed)
{
  return min(max(value, min_allowed), max_allowed);
}

float clamp_range(float value, float min, float max)
{
  return (max > min) ? clamp(value, min, max) : clamp(value, max, min);
}
`;
