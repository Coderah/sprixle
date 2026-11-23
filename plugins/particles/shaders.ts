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
    attribute vec4 aCurves; // curve-atlas rows: x = sizeX, y = sizeY, z = colour, w = alpha
    attribute vec4 aColor;  // base colour (linear RGBA)
    /**
     * Per-instance RGB multiply — the playback's tint (ParticlePlayback.tint). (1, 1, 1) is the
     * identity, which is what an un-tinted playback carries. Per instance rather than per material
     * for the same reason aScale is: one pool is shared by every playback of a draw identity, and a
     * fire hit and a water hit of the same burst are tinted differently in the same frame.
     */
    attribute vec3 aTint;
    /**
     * Per-instance uniform size multiplier — Ryzom's ScaleFX (ParticlePlayback.scale), 1 = as
     * authored. An attribute rather than a uniform because a pool is shared by every playback of a
     * draw identity and two of them can ask for different sizes in the same frame. It multiplies the
     * sprite's world size only: the z-bias below is a clip-space depth translation and the soft fade
     * is per-fragment, so neither depends on how big the quad is.
     */
    attribute float aScale;
    /**
     * Per-instance ground kill plane: the **world** Y of the plane this particle dies at
     * ('ParticleAssetLayer.killBelowY' through the node matrix that placed the effect), written at
     * spawn. 'NO_FLOOR' ('pools.ts', -1e20) = no plane, which is every layer that never asked for
     * one, so the compare in 'main()' is simply false and no program variant is needed for the
     * layers that did. Finite on purpose: GLSL ES has no -Infinity (see 'NO_FLOOR').
     *
     * A per-instance attribute, not a pool uniform: one pool is shared by every playback of a draw
     * identity and two playbacks can stand on two different floors (a bone-anchored burst, a
     * ground-anchored one, a bolt in flight).
     */
    attribute float aFloor;

    uniform float uTime;
    uniform float uCurveRows;
    // The authored plane of a fixed layer (two unit vectors in world axes).
    uniform vec3 uBasisX;
    uniform vec3 uBasisY;
    /**
     * Depth nudge toward the camera, in NeL's unit: the material value divided by the camera's depth
     * extent and applied as a window-depth translation (see main()). Lifts a coplanar effect off the
     * surface it sits on.
     */
    uniform float uZBias;
    /** The camera's depth extent, which is what turns uZBias into that translation (see main()). */
    uniform float uCameraNear;
    uniform float uCameraFar;

    uniform sampler2D uCurves;
    uniform vec2 uGrid;
    /**
     * The number of grid cells the sheet actually uses ('ParticleAssetLayer.spriteCount'). Not
     * 'uGrid.x * uGrid.y': a partly-filled sheet must wrap on its own frame count, or the flipbook
     * renders the empty tail of the grid once per cycle.
     */
    uniform float uSpriteCount;
    /**
     * Sprite cells per second, for an animated sheet: 0 = the cell the particle was born with is
     * kept for its whole life (every asset written before this uniform existed).
     */
    uniform float uSpriteFps;

    uniform sampler2D uPose;
    /**
     * 0 = sample the pose **at each particle's birth** (the shipping behaviour: an emitter gives
     * birth, the particle is then free); 1 = sample it **now**, which glues every live particle to
     * the bone and is what "attached" looks like when it is wrong. A debug switch, so the difference
     * is a click instead of an argument.
     */
    uniform float uPoseLive;
    // Seconds of pose history the ring actually holds (PoseTable.window).
    uniform float uPoseWindow;
    uniform float uPoseFrames;
    uniform float uPoseHz;
    /** Pose texture height: one texel per node slot. */
    uniform float uPoseRows;
    /** Pose texture width: four matrix columns per frame (frames * 4). */
    uniform float uPoseCols;

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

    // The pose ring is 2D: rows are node slots, columns are frame * 4 + matrixColumn texels, so
    // four vec4 *columns* per (node, frame) in mat4 constructor order with no transpose. Frame index
    // must match the CPU (PoseTable.beginFrame): floor(time * hz) mod frames.
    vec4 poseColumn(float node, float frame, float column) {
        float x = frame * 4.0 + column;
        // Half-texel offsets: the ring is NearestFilter, so each sample must land on a texel centre.
        return texture2D(uPose, vec2((x + 0.5) / uPoseCols, (node + 0.5) / uPoseRows));
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

        // The pose time this vertex is posed at. Hoisted above the kill test because the plane has to
        // be evaluated on the same world position the sprite is drawn at, and it is this pair the two
        // share (see 'worldAt').
        //
        // A free particle keeps the pose it was emitted with; a trail segment asks for the pose at
        // its own offset back in time, which is what turns a bone's swing into a ribbon.
        #ifdef KIND_QUAD
            // A particle older than the pose ring would ask for a frame the ring has already
            // overwritten — and would then be posed by a *recent* matrix, i.e. it would appear to
            // follow the bone. Clamping to the oldest surviving frame keeps such a particle frozen
            // (slightly stale) instead of gluing it to the emitter. uPoseLive is the debug switch.
            float birthTime = max(aVel.w, uTime - uPoseWindow);
            float poseTime = mix(birthTime, uTime, clamp(uPoseLive, 0.0, 1.0));
        #else
            float poseTime = uTime - segment * aTrail.y;
        #endif

        // The ground kill plane ('ParticleAssetLayer.killBelowY'). Collapsing the *vertex* rather than
        // the instance is what makes a plane a plane: a sprite straddling the floor is cut, not
        // deleted whole. It compares the *evaluated world Y of this vertex*, not the instance's spawn
        // point, because gravity is an acceleration the analytic path integrates — the fall only
        // shows in the evaluated position. 'mag_def_impact_resist.ps' fell 11.48 m below its own floor
        // before this existed (its 'CPSZoneRectangle' was decoded and ignored).
        //
        // Wrapped in a branch on the plane itself, not only on its value: the sentinel a layer without
        // a zone carries is 'NO_FLOOR' (-1e20), so such a layer skips the compare entirely. The
        // branch is per instance, and a pool's instances almost always agree (one layer, one plane).
        // The threshold sits between the sentinel and the lowest real plane: -1.0e19 is 1e19 metres
        // below the sea, and -1e20 is the sentinel, so nothing real is ever mistaken for it. (A
        // literal -Infinity would be undefined behaviour here: GLSL ES has no infinity.)
        float t = min(sampleAge, life);
        float lifeRatio = clamp(t / life, 0.0, 1.0);

        // **One** evaluation of the particle's world position per vertex, shared by the kill plane and
        // by every expansion below. 'worldAt' is up to eight pose fetches (plus the noise field), and
        // it used to run twice per vertex: the plane sampled
        // 'worldAt(min(max(sampleAge, 0.0), life), poseTime)', which is exactly 't', because a
        // not-yet-born vertex already returned above.
        vec3 world = worldAt(t, poseTime);

        if (aFloor > -1.0e19) {
            if (world.y < aFloor) {
                gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
                vUv = vec2(0.0);
                vColor = vec4(0.0);
                return;
            }
        }

        float sizeX = aSize.x * aScale * curveFetch(aCurves.x, lifeRatio).r;
        float sizeY = aSize.y * aScale * curveFetch(aCurves.y, lifeRatio).r;

        vec4 colour = aColor * curveFetch(aCurves.z, lifeRatio);
        // The authored alpha curve is its own row (aCurves.w), *not* the colour curve's alpha: a
        // gradient that happens to carry an alpha must not silently become the life fade.
        colour.a *= curveFetch(aCurves.w, lifeRatio).r;
        // The playback tint, RGB only — it is a colour override, not an opacity one.
        colour.rgb *= aTint;

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
        // An animated sheet advances its cell over the particle's own life ('uSpriteFps' cells per
        // second, wrapping inside the *used* cells of the grid — 'uSpriteCount', not the grid's
        // capacity), which is what 'CTextureGrouped''s frame list means. At 0 the cell is the one the
        // particle was born with, exactly as before the uniform existed.
        float cell = aMeta.x;
        if (uSpriteFps > 0.0) {
            cell = mod(cell + floor(t * uSpriteFps), max(uSpriteCount, 1.0));
        }
        vec2 cellOrigin = vec2(mod(cell, cols), floor(cell / cols));
        vUv = (cellOrigin + vec2(position.x + 0.5, 0.5 - position.y)) * cellSize;
        vColor = colour;

        #ifdef KIND_TRAIL_STRIP
            // Stretch this segment between two samples of the same path, in view space, so a chain
            // of independent quads reads as one continuous ribbon (tiny overlap at the joins).
            float tB = clamp(sampleAge - aTrail.y, 0.0, life);
            vec3 pA = world;
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
            vec4 mv = modelViewMatrix * vec4(world, 1.0);

            #ifdef ORIENT_BASIS
                // A fixed quad expands along its authored plane, not toward the camera: a floor sigil
                // lies flat and foreshortens with the view, a wall decal stands upright. angle spins
                // it *within* the plane, which is how Ryzom animates a rotating ground ring.
                float bc = cos(angle);
                float bs = sin(angle);
                vec2 basisCorner = vec2(
                    position.x * bc - position.y * bs,
                    position.x * bs + position.y * bc
                );
                vec3 worldCorner =
                    uBasisX * (basisCorner.x * sizeX) + uBasisY * (basisCorner.y * sizeY);
                mv += modelViewMatrix * vec4(worldCorner, 0.0);
            #elif defined(ORIENT_VELOCITY)
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

        // Ryzom's z-bias, in Ryzom's own unit. CMaterial::setZBias does not reach the driver as a
        // distance: it is multiplied by 1/(zfar-znear) and then added to the whole window depth range
        // (getZBias() * _OODeltaZ at driver_opengl3_material.cpp:533, _OODeltaZ = 1/(zfar-znear) at
        // driver_opengl3_matrix.cpp:37, spent as glDepthRange(near + d, far + d) with
        // d = zbias*(far-near) at driver_opengl3_states.cpp:653-658). Net: the window-depth shift is
        // uZBias / (cameraFar - cameraNear) — one number for the whole scene, whatever the fragment's
        // distance, which is what a depth-range translation is. Window depth translates by d => NDC z
        // by 2d, hence the factor. So a corpus value of -2 is NOT "draw over everything": with a
        // 0.1..500 camera it is a 0.8% NDC nudge, about 4 cm of pull at 1 m and 0.6 m at 4 m.
        //
        // Applied after the branch, so a trail gets it too (it used to be a mv.z shift on the
        // billboard path only). Negative is toward the camera.
        //
        // The lower clamp is the near plane, and it only bites when the shift pushed the fragment in
        // front of it: glDepthRange clamps window depth rather than culling geometry, so a large
        // authored bias must draw over everything instead of being clipped by the near plane. A vertex
        // already in front of the near plane keeps its own z, so genuine near-clipping is untouched.
        if (uZBias != 0.0) {
            float range = max(uCameraFar - uCameraNear, 1e-4);
            float biased = gl_Position.z + 2.0 * (uZBias / range) * gl_Position.w;

            if (gl_Position.z >= -gl_Position.w) {
                gl_Position.z = max(biased, -gl_Position.w);
            }
        }
    }
`;

export const particleFragmentShader = glsl`
    uniform sampler2D uMap;
    uniform float uAlphaTest;

    #ifdef SOFT_DEPTH
        // Soft particles: fade a fragment out as it approaches the opaque surface behind it, so a
        // quad intersecting the character reads as a soft edge instead of a hard slice.
        //
        // This is the difference between "the sparks are inside the mesh" and "the sparks wash over
        // the sleeve": with depth testing alone, a quad whose centre is behind the skin is gone, and
        // a quad straddling the surface is cut in half along a pixel-exact line. Reading the scene's
        // own depth and feathering over uSoftDistance metres turns that cut into a fade.
        //
        // The depth texture is a pass the project renders (the engine cannot own a render pass); it
        // is the same camera, so the comparison is exact. Both values are converted to view distance
        // (three's perspectiveDepthToViewZ, inverted) rather than compared in window space, because
        // the conversion is what makes the fade width constant in metres instead of vanishing at
        // distance.
        uniform sampler2D uSceneDepth;
        uniform vec2 uResolution;
        uniform float uCameraNear;
        uniform float uCameraFar;
        uniform float uSoftDistance;

        // Positive distance from the camera. three's perspectiveDepthToViewZ returns a *negative*
        // view-space Z, so the result is negated here; comparing distances is what keeps the maths
        // readable (and what the first version got wrong: the subtraction had the sign reversed,
        // which faded out every particle instead of the ones near a surface).
        float viewDistance(float depth) {
            return -(uCameraNear * uCameraFar) / ((uCameraFar - uCameraNear) * depth - uCameraFar);
        }
    #endif

    varying vec2 vUv;
    varying vec4 vColor;

    void main() {
        vec4 texel = texture2D(uMap, vUv);
        vec4 colour = texel * vColor;

        #ifdef SOFT_DEPTH
            float sceneDistance = viewDistance(
                texture2D(uSceneDepth, gl_FragCoord.xy / uResolution).x
            );
            float fragmentDistance = viewDistance(gl_FragCoord.z);
            // 0 at the surface, 1 at uSoftDistance in front of it; behind it is depth-test-culled.
            colour.a *= smoothstep(0.0, uSoftDistance, sceneDistance - fragmentDistance);
        #endif

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
