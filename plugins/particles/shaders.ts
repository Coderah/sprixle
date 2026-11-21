import { glsl } from '../../shader/util';
import { CURVE_TEXTURE_WIDTH } from './curves';

/**
 * One vertex-program family covers every particle, because every kind is a quad expanded in the
 * vertex shader. The `KIND_*` / `ORIENT_*` defines pick the expansion; `#define` specialization
 * keeps the fragment path identical and avoids per-vertex branching.
 *
 * Motion is analytic (closed form), evaluated from the instance's spawn state — no state texture,
 * no feedback, no per-frame upload. With `dv/dt = a - k·v`:
 *
 *     v(t) = (v0 - a/k)·e^(-kt) + a/k
 *     p(t) = p0 + (a/k)·t + ((v0 - a/k)/k)·(1 - e^(-kt))
 *
 * Turbulence (`NOISE`) is a displacement field added to that path, sampled at the instance's own
 * `(seed, age)` — still a pure function of two numbers, so it needs no accumulation either and the
 * arc is identical at 30 and 144 fps. See `noiseOffset` below.
 *
 * Trails come out of the same function: segment `k` evaluates the *same* particle at `t - k·Δ`,
 * which is why a tail needs no history buffer.
 *
 * **Attachment.** When a particle belongs to a bone-bound node (`aMeta.z >= 0`) its `p0` is node
 * local and the pose ring supplies the node's world matrix at a chosen time:
 *
 * - a free particle uses the pose **at its birth**, so a swing does not drag emitted sparks along;
 * - a trail segment uses the pose at t - k·Δ, so the ribbon *is* the swept path of the bone —
 *   weapon trails that follow the skin animation, with no CPU work per particle.
 */
export const particleVertexShader = glsl`
    attribute vec4 aSim;    // p0.xyz (world, or node-local when attached), life (seconds)
    attribute vec4 aVel;    // v0.xyz, bornAt (seconds, same clock as uTime)
    attribute vec4 aSize;   // sizeX, sizeY, angle0 (rad), spin (rad/s)
    attribute vec4 aMeta;   // spriteIdx, noise seed (0..1), nodeId (-1 = unbound), segment index
    attribute vec4 aTrail;  // segments, segmentDelay (s), tailFade (0|1), unused
    attribute vec4 aDyn;    // acceleration.xyz, drag k (1/s)
    attribute vec4 aNoise;  // turbulence amplitude (m), base-octave frequency (cycles/s), unused ×2
    attribute vec4 aCurves; // sizeX row, alpha row, colour row, unused
    attribute vec4 aColor;  // base colour (linear RGBA)

    uniform float uTime;
    uniform float uCurveRows;
    uniform sampler2D uCurves;
    uniform vec2 uGrid;

    uniform sampler2D uPose;
    uniform float uPoseFrames;
    uniform float uPoseHz;
    uniform float uPoseRows;

    varying vec2 vUv;
    varying vec4 vColor;

    const float CURVE_WIDTH = ${CURVE_TEXTURE_WIDTH}.0;

    vec3 evaluate(float t) {
        vec3 p0 = aSim.xyz;
        vec3 v0 = aVel.xyz;
        vec3 a = aDyn.xyz;
        float k = aDyn.w;

        if (k > 1e-4) {
            vec3 ak = a / k;
            float e = exp(-k * t);
            return p0 + ak * t + ((v0 - ak) / k) * (1.0 - e);
        }

        return p0 + v0 * t + 0.5 * a * t * t;
    }

    #ifdef NOISE
        // Stateless turbulence: a 3-octave value-noise displacement, sampled along a line through
        // the field at (seed, age). Nothing accumulates, so the path is a pure function of the
        // instance's own numbers — identical on every replay, at any frame rate, at no per-frame
        // cost beyond this vertex work. Gated by NOISE so assets without turbulence pay nothing.

        // Hash without sine (iq's float hash): 3 decorrelated channels per lattice corner, no
        // integer ops (GLSL ES 1.0), and exact enough over the range we sample (|p| < ~1e3).
        vec3 hash33(vec3 p) {
            p = fract(p * vec3(0.1031, 0.1030, 0.0973));
            p += dot(p, p.yxz + 33.33);
            return fract((p.xxy + p.yxx) * p.zyx);
        }

        vec3 valueNoise(vec3 p) {
            vec3 i = floor(p);
            vec3 f = p - i;
            f = f * f * (3.0 - 2.0 * f);

            vec3 n00 = mix(hash33(i), hash33(i + vec3(1.0, 0.0, 0.0)), f.x);
            vec3 n10 = mix(hash33(i + vec3(0.0, 1.0, 0.0)), hash33(i + vec3(1.0, 1.0, 0.0)), f.x);
            vec3 n01 = mix(hash33(i + vec3(0.0, 0.0, 1.0)), hash33(i + vec3(1.0, 0.0, 1.0)), f.x);
            vec3 n11 = mix(hash33(i + vec3(0.0, 1.0, 1.0)), hash33(i + vec3(1.0, 1.0, 1.0)), f.x);

            return mix(mix(n00, n10, f.y), mix(n01, n11, f.y), f.z);
        }

        vec3 noiseOffset(float t) {
            // The particle is born *on* its spawn point: the offset ramps in over the first 15% of
            // life, or a burst would pop into existence already scattered (NeL's brownian table
            // also starts at zero and wanders from there).
            float fade = smoothstep(0.0, 0.15, clamp(t / max(aSim.w, 1e-4), 0.0, 1.0));
            float age = t * aNoise.y;

            // A line through the field, offset per particle by its seed. The slope is not axis
            // aligned so the three axes do not all cross the same lattice planes at once.
            vec3 p = vec3(aMeta.y * 53.0, aMeta.y * 97.0, aMeta.y * 151.0) +
                     age * vec3(1.0, 1.31, 1.73);

            vec3 total = vec3(0.0);
            float weight = 1.0;
            float norm = 0.0;

            for (int octave = 0; octave < 3; octave++) {
                total += weight * (valueNoise(p) * 2.0 - 1.0);
                norm += weight;
                // Lacunarity 2.03, not 2.0: octaves that land on the same lattice corners would
                // repeat instead of adding detail.
                p = p * 2.03 + 11.0;
                weight *= 0.5;
            }

            return (total / norm) * aNoise.x * fade;
        }
    #endif

    // The pose ring stores four vec4 *columns* per (node, frame) — mat4 constructor order, so no
    // transpose. Frame index must match the CPU (PoseTable.beginFrame): floor(time * hz) mod frames.
    vec4 poseColumn(float node, float frame, float column) {
        float base = (node * uPoseFrames + frame) * 4.0;
        // Half-texel offset: the ring is NearestFilter, so each sample must land on a texel centre.
        return texture2D(uPose, vec2(0.5, (base + column + 0.5) / uPoseRows));
    }

    // Two-frame blend. Sampling single frames quantises the pose at uPoseHz, and on a fast swing
    // that reads as a strobing/stepping trail — the largest source of "flicker" at 30 Hz. Eight
    // fetches only for attached instances, which is cheap next to the per-particle work.
    mat4 poseAt(float node, float time) {
        float exact = time * uPoseHz;
        float frameA = floor(exact);
        float blend = exact - frameA;
        float a = mod(frameA, uPoseFrames);
        float b = mod(frameA + 1.0, uPoseFrames);

        vec4 a0 = poseColumn(node, a, 0.0);
        vec4 a1 = poseColumn(node, a, 1.0);
        vec4 a2 = poseColumn(node, a, 2.0);
        vec4 a3 = poseColumn(node, a, 3.0);

        if (blend < 0.001) return mat4(a0, a1, a2, a3);

        vec4 b0 = poseColumn(node, b, 0.0);
        vec4 b1 = poseColumn(node, b, 1.0);
        vec4 b2 = poseColumn(node, b, 2.0);
        vec4 b3 = poseColumn(node, b, 3.0);

        return mat4(mix(a0, b0, blend), mix(a1, b1, blend), mix(a2, b2, blend), mix(a3, b3, blend));
    }

    // Attached particles are authored in node space; unbound ones are already world space.
    vec3 worldAt(float t, float poseTime) {
        vec3 local = evaluate(t);

        #ifdef NOISE
            local += noiseOffset(t);
        #endif

        if (aMeta.z >= 0.0) {
            return (poseAt(aMeta.z, poseTime) * vec4(local, 1.0)).xyz;
        }

        return local;
    }

    // NearestFilter + manual lerp: RGBA32F linear filtering needs OES_texture_float_linear, which
    // is not guaranteed on WebGL2. Six fetches per instance is cheaper than a capability gate.
    vec4 curveFetch(float row, float lifeRatio) {
        float x = lifeRatio * (CURVE_WIDTH - 1.0);
        float x0 = floor(x);
        float x1 = min(x0 + 1.0, CURVE_WIDTH - 1.0);
        float f = x - x0;
        float v = (row + 0.5) / uCurveRows;

        vec4 a = texture2D(uCurves, vec2((x0 + 0.5) / CURVE_WIDTH, v));
        vec4 b = texture2D(uCurves, vec2((x1 + 0.5) / CURVE_WIDTH, v));

        return mix(a, b, f);
    }

    void main() {
        float life = max(aSim.w, 1e-4);
        float age = uTime - aVel.w;

        #ifdef KIND_QUAD
            float segment = 0.0;
            float sampleAge = age;
        #else
            float segment = aMeta.w;
            float sampleAge = age - segment * aTrail.y;
        #endif

        // Not yet born (a trailing segment ahead of the particle), or dead: collapse off-screen.
        if (sampleAge < 0.0 || age > life) {
            gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
            vUv = vec2(0.0);
            vColor = vec4(0.0);
            return;
        }

        float t = min(sampleAge, life);
        float lifeRatio = clamp(t / life, 0.0, 1.0);

        float sizeX = aSize.x * curveFetch(aCurves.x, lifeRatio).r;
        float sizeY = aSize.y * curveFetch(aCurves.y, lifeRatio).r;

        vec4 colour = aColor * curveFetch(aCurves.z, lifeRatio);
        colour.a *= curveFetch(aCurves.w, lifeRatio).r;

        #ifndef KIND_QUAD
            if (aTrail.z > 0.5) {
                float taper = 1.0 - segment / max(aTrail.x, 1.0);
                sizeX *= taper;
                sizeY *= taper;
                colour.a *= taper;
            }
        #endif

        float angle = aSize.z + aSize.w * age;

        // Sprite cell in the pool's grid; y flipped because texture row 0 is the top.
        vec2 cellSize = 1.0 / uGrid;
        float cols = uGrid.x;
        vec2 cellOrigin = vec2(mod(aMeta.x, cols), floor(aMeta.x / cols));
        vUv = (cellOrigin + vec2(position.x + 0.5, 0.5 - position.y)) * cellSize;
        vColor = colour;

        // A free particle keeps the pose it was emitted with; a trail segment asks for the pose at
        // its own offset back in time, which is what turns a bone's swing into a ribbon.
        #ifdef KIND_QUAD
            float poseTime = aVel.w;
        #else
            float poseTime = uTime - segment * aTrail.y;
        #endif

        #ifdef KIND_TRAIL_STRIP
            // Stretch this segment between two samples of the same path, in view space, so a chain
            // of independent quads reads as one continuous ribbon (tiny overlap at the joins).
            float tB = clamp(sampleAge - aTrail.y, 0.0, life);
            vec3 pA = worldAt(t, poseTime);
            vec3 pB = worldAt(tB, poseTime - aTrail.y);
            vec4 vA = modelViewMatrix * vec4(pA, 1.0);
            vec4 vB = modelViewMatrix * vec4(pB, 1.0);

            vec2 delta = vB.xy - vA.xy;
            float lengthAB = length(delta);
            vec2 dir = lengthAB > 1e-5 ? delta / lengthAB : vec2(0.0, 1.0);
            vec2 nrm = vec2(-dir.y, dir.x);

            vec2 centre = mix(vA.xy, vB.xy, 0.5);
            vec2 offset = dir * (position.y * lengthAB) + nrm * (position.x * sizeX);

            gl_Position = projectionMatrix * vec4(centre + offset, mix(vA.z, vB.z, 0.5), 1.0);
        #else
            vec3 world = worldAt(t, poseTime);
            vec4 mv = modelViewMatrix * vec4(world, 1.0);

            #ifdef ORIENT_VELOCITY
                // Screen-space stretch along the direction of travel: sparks and streaks. A short
                // step forward along the very same path (which includes the noise displacement)
                // rather than the analytic velocity, so a turbulent spark stretches along the arc
                // it actually takes.
                vec4 head = modelViewMatrix * vec4(worldAt(t + 0.01, poseTime), 1.0);
                vec2 screenDir = head.xy - mv.xy;
                float len = length(screenDir);
                vec2 dir = len > 1e-6 ? screenDir / len : vec2(0.0, 1.0);
                vec2 nrm = vec2(-dir.y, dir.x);
                mv.xy += dir * (position.y * sizeY) + nrm * (position.x * sizeX);
            #else
                float c = cos(angle);
                float s = sin(angle);
                vec2 corner = vec2(
                    position.x * c - position.y * s,
                    position.x * s + position.y * c
                );
                mv.xy += corner * vec2(sizeX, sizeY);
            #endif

            gl_Position = projectionMatrix * mv;
        #endif
    }
`;

export const particleFragmentShader = glsl`
    uniform sampler2D uMap;
    uniform float uAlphaTest;

    varying vec2 vUv;
    varying vec4 vColor;

    void main() {
        vec4 texel = texture2D(uMap, vUv);
        vec4 colour = texel * vColor;

        // Explicit threshold rather than three's USE_ALPHATEST injection: one uniform instead of a
        // define, and it keeps this shader independent of three's ShaderMaterial parameter set.
        // The 0.003 floor also drops invisible additive fragments before they cost fill rate.
        if (colour.a < max(uAlphaTest, 0.003)) discard;

        gl_FragColor = colour;

        // Match the rest of the scene: three only applies tone mapping and output colour-space
        // conversion to shaders that include these chunks, and a custom ShaderMaterial has to ask.
        // (Caveat: tone mapping runs per-particle, before additive blending sums them, so stacked
        // glows can still blow out — the same trade-off every additive material in three makes.)
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
    }
`;
