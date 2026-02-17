import { glsl } from '../../../../shader/util';

export default glsl`/* SPDX-FileCopyrightText: 2019-2022 Blender Authors
*
* SPDX-License-Identifier: GPL-2.0-or-later */

#include "gpu_shader_common_color_utils.glsl"

vec4 mix_blend(float fac, vec4 col1, vec4 col2)
{
    vec4 outcol = mix(col1, col2, fac);
    outcol.a = col1.a;
    return outcol;
}

vec4 mix_add(float fac, vec4 col1, vec4 col2)
{
    vec4 outcol = mix(col1, col1 + col2, fac);
    outcol.a = col1.a;
    return outcol;
}

vec4 mix_mult(float fac, vec4 col1, vec4 col2)
{
    vec4 outcol = mix(col1, col1 * col2, fac);
    outcol.a = col1.a;
    return outcol;
}

vec4 mix_screen(float fac, vec4 col1, vec4 col2)
{
    float facm = 1.0f - fac;
    vec4 outcol = vec4(1.0f) - (vec4(facm) + fac * (vec4(1.0f) - col2)) * (vec4(1.0f) - col1);
    outcol.a = col1.a;
    return outcol;
}

vec4 mix_overlay(float fac, vec4 col1, vec4 col2)
{
    float facm = 1.0f - fac;
    vec4 outcol = col1;

    if (outcol.r < 0.5f) {
        outcol.r *= facm + 2.0f * fac * col2.r;
    }
    else {
        outcol.r = 1.0f - (facm + 2.0f * fac * (1.0f - col2.r)) * (1.0f - outcol.r);
    }

    if (outcol.g < 0.5f) {
        outcol.g *= facm + 2.0f * fac * col2.g;
    }
    else {
        outcol.g = 1.0f - (facm + 2.0f * fac * (1.0f - col2.g)) * (1.0f - outcol.g);
    }

    if (outcol.b < 0.5f) {
        outcol.b *= facm + 2.0f * fac * col2.b;
    }
    else {
        outcol.b = 1.0f - (facm + 2.0f * fac * (1.0f - col2.b)) * (1.0f - outcol.b);
    }
    
    return outcol;
}

vec4 mix_sub(float fac, vec4 col1, vec4 col2)
{
    vec4 outcol = mix(col1, col1 - col2, fac);
    outcol.a = col1.a;
    return outcol;
}

vec4 mix_div(float fac, vec4 col1, vec4 col2)
{
    float facm = 1.0f - fac;
    vec4 outcol = vec4(vec3(0.0f), col1.a);

    if (col2.r != 0.0f) {
        outcol.r = facm * col1.r + fac * col1.r / col2.r;
    }
    if (col2.g != 0.0f) {
        outcol.g = facm * col1.g + fac * col1.g / col2.g;
    }
    if (col2.b != 0.0f) {
        outcol.b = facm * col1.b + fac * col1.b / col2.b;
    }
    
    return outcol;
}

/* A variant of mix_div that fallback to the first color upon zero division. */
vec4 mix_div_fallback(float fac, vec4 col1, vec4 col2)
{
    float facm = 1.0f - fac;
    vec4 outcol = col1;

    if (col2.r != 0.0f) {
        outcol.r = facm * outcol.r + fac * outcol.r / col2.r;
    }
    if (col2.g != 0.0f) {
        outcol.g = facm * outcol.g + fac * outcol.g / col2.g;
    }
    if (col2.b != 0.0f) {
        outcol.b = facm * outcol.b + fac * outcol.b / col2.b;
    }
    
    return outcol;
}

vec4 mix_diff(float fac, vec4 col1, vec4 col2)
{
    vec4 outcol = mix(col1, abs(col1 - col2), fac);
    outcol.a = col1.a;
    return outcol;
}

vec4 mix_exclusion(float fac, vec4 col1, vec4 col2)
{
    vec4 outcol = max(mix(col1, col1 + col2 - 2.0f * col1 * col2, fac), 0.0f);
    outcol.a = col1.a;
    return outcol;
}

vec4 mix_dark(float fac, vec4 col1, vec4 col2)
{
    vec4 outcol = col1;
    outcol.rgb = mix(col1.rgb, min(col1.rgb, col2.rgb), fac);
    outcol.a = col1.a;
    return outcol;
}

vec4 mix_light(float fac, vec4 col1, vec4 col2)
{
    vec4 outcol = col1;
    outcol.rgb = mix(col1.rgb, max(col1.rgb, col2.rgb), fac);
    outcol.a = col1.a;
    return outcol;
}

vec4 mix_dodge(float fac, vec4 col1, vec4 col2)
{
    vec4 outcol = col1;

    if (outcol.r != 0.0f) {
        float tmp = 1.0f - fac * col2.r;
        if (tmp <= 0.0f) {
            outcol.r = 1.0f;
        }
        else if ((tmp = outcol.r / tmp) > 1.0f) {
            outcol.r = 1.0f;
        }
        else {
            outcol.r = tmp;
        }
    }
    if (outcol.g != 0.0f) {
        float tmp = 1.0f - fac * col2.g;
        if (tmp <= 0.0f) {
            outcol.g = 1.0f;
        }
        else if ((tmp = outcol.g / tmp) > 1.0f) {
            outcol.g = 1.0f;
        }
        else {
            outcol.g = tmp;
        }
    }
    if (outcol.b != 0.0f) {
        float tmp = 1.0f - fac * col2.b;
        if (tmp <= 0.0f) {
            outcol.b = 1.0f;
        }
        else if ((tmp = outcol.b / tmp) > 1.0f) {
            outcol.b = 1.0f;
        }
        else {
            outcol.b = tmp;
        }
    }
    
    return outcol;
}

vec4 mix_burn(float fac, vec4 col1, vec4 col2)
{
    float tmp, facm = 1.0f - fac;
    vec4 outcol = col1;

    tmp = facm + fac * col2.r;
    if (tmp <= 0.0f) {
        outcol.r = 0.0f;
    }
    else if ((tmp = (1.0f - (1.0f - outcol.r) / tmp)) < 0.0f) {
        outcol.r = 0.0f;
    }
    else if (tmp > 1.0f) {
        outcol.r = 1.0f;
    }
    else {
        outcol.r = tmp;
    }

    tmp = facm + fac * col2.g;
    if (tmp <= 0.0f) {
        outcol.g = 0.0f;
    }
    else if ((tmp = (1.0f - (1.0f - outcol.g) / tmp)) < 0.0f) {
        outcol.g = 0.0f;
    }
    else if (tmp > 1.0f) {
        outcol.g = 1.0f;
    }
    else {
        outcol.g = tmp;
    }

    tmp = facm + fac * col2.b;
    if (tmp <= 0.0f) {
        outcol.b = 0.0f;
    }
    else if ((tmp = (1.0f - (1.0f - outcol.b) / tmp)) < 0.0f) {
        outcol.b = 0.0f;
    }
    else if (tmp > 1.0f) {
        outcol.b = 1.0f;
    }
    else {
        outcol.b = tmp;
    }
    
    return outcol;
}

vec4 mix_hue(float fac, vec4 col1, vec4 col2)
{
    float facm = 1.0f - fac;
    vec4 outcol = col1;

    vec4 hsv, hsv2, tmp;
    rgb_to_hsv(col2, hsv2);

    if (hsv2.y != 0.0f) {
        rgb_to_hsv(outcol, hsv);
        hsv.x = hsv2.x;
        hsv_to_rgb(hsv, tmp);

        outcol = mix(outcol, tmp, fac);
        outcol.a = col1.a;
    }
    
    return outcol;
}

vec4 mix_sat(float fac, vec4 col1, vec4 col2)
{
    float facm = 1.0f - fac;
    vec4 outcol = col1;

    vec4 hsv, hsv2;
    rgb_to_hsv(outcol, hsv);

    if (hsv.y != 0.0f) {
        rgb_to_hsv(col2, hsv2);
        hsv.y = facm * hsv.y + fac * hsv2.y;
        hsv_to_rgb(hsv, outcol);
    }
    
    return outcol;
}

vec4 mix_val(float fac, vec4 col1, vec4 col2)
{
    float facm = 1.0f - fac;

    vec4 hsv, hsv2;
    rgb_to_hsv(col1, hsv);
    rgb_to_hsv(col2, hsv2);

    hsv.z = facm * hsv.z + fac * hsv2.z;
    vec4 outcol;
    hsv_to_rgb(hsv, outcol);
    
    return outcol;
}

vec4 mix_color(float fac, vec4 col1, vec4 col2)
{
    float facm = 1.0f - fac;
    vec4 outcol = col1;

    vec4 hsv, hsv2, tmp;
    rgb_to_hsv(col2, hsv2);

    if (hsv2.y != 0.0f) {
        rgb_to_hsv(outcol, hsv);
        hsv.x = hsv2.x;
        hsv.y = hsv2.y;
        hsv_to_rgb(hsv, tmp);

        outcol = mix(outcol, tmp, fac);
        outcol.a = col1.a;
    }
    
    return outcol;
}

vec4 mix_soft(float fac, vec4 col1, vec4 col2)
{
    float facm = 1.0f - fac;
    vec4 one = vec4(1.0f);
    vec4 scr = one - (one - col2) * (one - col1);
    vec4 outcol = facm * col1 + fac * ((one - col1) * col2 * col1 + col1 * scr);
    outcol.a = col1.a;
    return outcol;
}

vec4 mix_linear(float fac, vec4 col1, vec4 col2)
{
    vec4 outcol = col1 + fac * (2.0f * (col2 - vec4(0.5f)));
    outcol.a = col1.a;
    return outcol;
}

vec4 clamp_color(vec4 vec, const vec4 min, const vec4 max)
{
    return clamp(vec, min, max);
}

float multiply_by_alpha(float factor, vec4 color)
{
    return factor * color.a;
}`;
