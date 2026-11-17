/**
 * Fragment shaders (GLSL ES 1.0) for the effects catalog. Each shader declares
 * `u_resolution`, `u_time` (already multiplied by the speed) and one `uniform` per param (`u_<name>`).
 * Colors arrive as `vec4` rgba (0..1); `select` arrives as the option index (float).
 */

const PRELUDE = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 u_resolution;
uniform float u_time;

float hash21(vec2 p) {
  p = fract(p * vec2(0.3183099, 0.3678794)) + 0.71;
  p += dot(p, p.yx + 19.19);
  return fract(p.x * p.y * 95.4337);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

float fbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * vnoise(p);
    p = mat2(1.6, 1.2, -1.2, 1.6) * p + vec2(7.3, 2.9);
    a *= 0.5;
  }
  return s / 0.9375;
}

mat2 rot(float a) {
  float c = cos(a);
  float s = sin(a);
  return mat2(c, -s, s, c);
}

// Minimal dither to avoid banding in soft gradients.
vec3 finish(vec3 c, vec2 frag) {
  return clamp(c + (hash21(frag) - 0.5) / 255.0, 0.0, 1.0);
}
`;

export const MESH_GRADIENT_FRAGMENT = `${PRELUDE}
uniform vec4 u_color1;
uniform vec4 u_color2;
uniform vec4 u_color3;
uniform vec4 u_color4;
uniform float u_speed;
uniform float u_distortion;
uniform float u_swirl;
uniform float u_grain;

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  float asp = u_resolution.x / u_resolution.y;
  vec2 p = (uv - 0.5) * vec2(asp, 1.0);
  float t = u_time * 0.18;

  // swirl around the center, stronger near it
  float r = length(p);
  p = rot(u_swirl * 3.0 * (1.0 - smoothstep(0.0, 1.1, r)) + t * u_swirl * 0.5) * p;

  // noise warp
  vec2 q = vec2(fbm(p * 1.4 + vec2(t, -t * 0.7)), fbm(p * 1.4 + vec2(4.1 - t * 0.6, 2.3 + t * 0.5)));
  p += (q - 0.5) * u_distortion * 1.8;

  // four blobs orbiting near the corners
  vec2 c1 = vec2(-0.30 * asp + 0.20 * asp * sin(t * 1.10), 0.25 + 0.18 * cos(t * 0.90 + 1.0));
  vec2 c2 = vec2(0.30 * asp + 0.20 * asp * cos(t * 0.80 + 2.0), 0.22 + 0.18 * sin(t * 1.20));
  vec2 c3 = vec2(0.28 * asp + 0.20 * asp * sin(t * 0.70 + 4.0), -0.25 + 0.18 * cos(t * 1.00 + 3.0));
  vec2 c4 = vec2(-0.28 * asp + 0.20 * asp * cos(t * 1.30 + 1.0), -0.22 + 0.18 * sin(t * 0.85 + 5.0));
  float k = 3.2;
  float w1 = exp(-dot(p - c1, p - c1) * k);
  float w2 = exp(-dot(p - c2, p - c2) * k);
  float w3 = exp(-dot(p - c3, p - c3) * k);
  float w4 = exp(-dot(p - c4, p - c4) * k);
  vec3 col = (u_color1.rgb * w1 + u_color2.rgb * w2 + u_color3.rgb * w3 + u_color4.rgb * w4) / (w1 + w2 + w3 + w4 + 0.00001);

  // soft glow following the noise
  col += (q.x - 0.5) * 0.10;

  float n = hash21(gl_FragCoord.xy + floor(u_time * 30.0) * vec2(13.7, 7.1));
  col += (n - 0.5) * u_grain * 0.35;
  gl_FragColor = vec4(finish(col, gl_FragCoord.xy), 1.0);
}
`;

export const GRAIN_FRAGMENT = `${PRELUDE}
uniform vec4 u_color1;
uniform vec4 u_color2;
uniform float u_intensity;
uniform float u_size;
uniform float u_speed;

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  float asp = u_resolution.x / u_resolution.y;
  float t = u_time * 0.12;

  // base: slightly wavy diagonal gradient
  float m = fbm(vec2(uv.x * asp, uv.y) * 1.3 + vec2(t, t * 0.6));
  float g = clamp(uv.y * 0.65 + uv.x * 0.25 + (m - 0.5) * 0.9, 0.0, 1.0);
  vec3 base = mix(u_color1.rgb, u_color2.rgb, smoothstep(0.0, 1.0, g));

  // film grain: cells in pixels (relative to height), new frame ~14x per second
  float cell = max(1.0, u_size * u_resolution.y / 720.0);
  vec2 id = floor(gl_FragCoord.xy / cell);
  float frame = floor(u_time * 14.0);
  float n1 = hash21(id + frame * vec2(37.1, 17.3));
  float n2 = hash21(id * 1.7 + frame * vec2(11.3, 53.7) + 9.0);
  float n = (n1 + n2) * 0.5 - 0.5;

  vec3 col = base * (1.0 + n * u_intensity * 1.2) + n * u_intensity * 0.4;
  gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
`;

export const HALFTONE_FRAGMENT = `${PRELUDE}
uniform vec4 u_color;
uniform vec4 u_background;
uniform float u_dotSize;
uniform float u_angle;
uniform float u_speed;
uniform float u_shape;

void main() {
  float asp = u_resolution.x / u_resolution.y;
  float cell = max(2.0, u_dotSize * u_resolution.y / 720.0);
  float a = radians(u_angle);
  vec2 px = gl_FragCoord.xy - 0.5 * u_resolution;
  vec2 q = rot(a) * px / cell;
  vec2 id = floor(q);
  vec2 f = fract(q) - 0.5;

  // tone field sampled at the cell center (the whole dot has a single size)
  vec2 cp = rot(-a) * ((id + 0.5) * cell);
  vec2 uvc = cp / u_resolution + 0.5;
  float t = u_time * 0.15;
  float m = fbm(vec2(uvc.x * asp, uvc.y) * 1.6 + vec2(t, -t * 0.6));
  vec2 focus = vec2(0.5 + 0.25 * sin(t * 1.7), 0.5 + 0.2 * cos(t * 1.3));
  float lin = 1.0 - length((uvc - focus) * vec2(asp, 1.0)) * 1.1;
  float v = clamp(smoothstep(0.1, 0.9, mix(m, lin, 0.55)), 0.0, 1.0);

  float aa = 1.2 / cell;
  float d;
  float r;
  if (u_shape < 0.5) {
    d = length(f);
    r = sqrt(v) * 0.72;
  } else if (u_shape < 1.5) {
    d = max(abs(f.x), abs(f.y));
    r = sqrt(v) * 0.5;
  } else {
    d = abs(f.y);
    r = v * 0.5;
  }
  float mask = 1.0 - smoothstep(r - aa, r + aa, d);
  vec3 col = mix(u_background.rgb, u_color.rgb, mask);
  gl_FragColor = vec4(col, 1.0);
}
`;

export const WAVES_FRAGMENT = `${PRELUDE}
uniform vec4 u_color1;
uniform vec4 u_color2;
uniform vec4 u_background;
uniform float u_frequency;
uniform float u_amplitude;
uniform float u_lines;
uniform float u_speed;

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  float asp = u_resolution.x / u_resolution.y;
  float x = uv.x * asp;
  float t = u_time * 0.5;
  float n = max(u_lines, 1.0);
  float th = mix(0.0045, 0.0014, clamp(n / 40.0, 0.0, 1.0));
  float aa = 1.5 / u_resolution.y;

  vec3 col = u_background.rgb;
  for (int i = 0; i < 40; i++) {
    float fi = float(i);
    if (fi >= n) break;
    float k = (fi + 0.5) / n;
    float ph = fi * 0.55;
    float y = 0.1 + 0.8 * k
      + u_amplitude * 0.16 * (
          sin(x * u_frequency + t + ph)
        + 0.5 * sin(x * u_frequency * 2.3 - t * 0.8 + ph * 1.7)
        + 0.3 * sin(x * u_frequency * 0.5 + t * 0.4 - k * 3.0));
    float d = abs(uv.y - y);
    float line = 1.0 - smoothstep(th, th + aa, d);
    float glow = exp(-d * d / (th * th * 60.0)) * 0.22;
    vec3 lc = mix(u_color1.rgb, u_color2.rgb, k);
    col = mix(col, lc, clamp(line + glow, 0.0, 1.0));
  }
  gl_FragColor = vec4(finish(col, gl_FragCoord.xy), 1.0);
}
`;

export const LIQUID_METAL_FRAGMENT = `${PRELUDE}
uniform vec4 u_tint;
uniform vec4 u_highlight;
uniform float u_contrast;
uniform float u_speed;
uniform float u_scale;

// "liquid" height: noise warped by noise
float height(vec2 p, float t) {
  vec2 q = vec2(fbm(p * 0.9 + vec2(t, 0.0)), fbm(p * 0.9 + vec2(3.7, -t)));
  return fbm(p + 2.2 * (q - 0.5) + vec2(0.0, t * 0.5));
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  float asp = u_resolution.x / u_resolution.y;
  vec2 p = (uv - 0.5) * vec2(asp, 1.0) * u_scale * 2.2;
  float t = u_time * 0.15;

  float e = 0.012;
  float f0 = height(p, t);
  float fx = height(p + vec2(e, 0.0), t);
  float fy = height(p + vec2(0.0, e), t);
  vec3 nrm = normalize(vec3((f0 - fx) / e * 2.4, (f0 - fy) / e * 2.4, 1.0));

  // reflected procedural environment: light and dark bands like in a studio
  vec3 rd = reflect(vec3(0.0, 0.0, -1.0), nrm);
  float e1 = 0.5 + 0.5 * sin(rd.x * 6.0 + rd.y * 3.5 + 1.0);
  float e2 = 0.5 + 0.5 * cos(rd.y * 8.0 - rd.x * 2.5);
  float tone = smoothstep(0.2, 0.8, e1 * 0.62 + e2 * 0.38);
  tone = clamp((tone - 0.5) * u_contrast + 0.5, 0.0, 1.0);

  vec3 metal = mix(vec3(0.02, 0.024, 0.034), u_tint.rgb, tone);
  float spec = pow(clamp(dot(nrm, normalize(vec3(-0.4, 0.6, 0.7))), 0.0, 1.0), 24.0);
  vec3 col = metal + u_highlight.rgb * (spec * 1.1 + pow(tone, 6.0) * 0.35);
  gl_FragColor = vec4(finish(col, gl_FragCoord.xy), 1.0);
}
`;

export const GLASS_FRAGMENT = `${PRELUDE}
uniform vec4 u_color1;
uniform vec4 u_color2;
uniform float u_ribs;
uniform float u_refraction;
uniform float u_blur;
uniform float u_speed;

// backdrop seen through the glass: gradient with moving light blobs
vec3 backdrop(vec2 uv, float asp, float t) {
  float m = fbm(vec2(uv.x * asp * 1.5, uv.y * 2.5) + vec2(t * 0.3, -t * 0.2));
  float g = clamp(m + (uv.y - 0.5) * 0.6 + (uv.x - 0.5) * 0.3, 0.0, 1.0);
  vec3 c = mix(u_color1.rgb, u_color2.rgb, smoothstep(0.15, 0.85, g));
  vec2 lp = vec2(0.5 + 0.35 * sin(t * 0.7), 0.5 + 0.3 * cos(t * 0.5));
  float glow = exp(-dot((uv - lp) * vec2(asp, 1.0), (uv - lp) * vec2(asp, 1.0)) * 5.0);
  return mix(c, vec3(1.0), glow * 0.28);
}

void main() {
  vec2 uv = gl_FragCoord.xy / u_resolution;
  float asp = u_resolution.x / u_resolution.y;
  float t = u_time * 0.2;
  float ribs = max(u_ribs, 1.0);

  // profile of each rib: s goes from -1 to 1 and shifts the sample like a lens
  float s = fract(uv.x * ribs) * 2.0 - 1.0;
  vec2 uvr = uv + vec2(s * u_refraction * 0.9 / ribs, s * s * u_refraction * 0.05);

  float b = u_blur * 0.02;
  vec3 acc = vec3(0.0);
  float wsum = 0.0;
  for (int i = 0; i < 5; i++) {
    float o = float(i) - 2.0;
    float w = 1.0 - abs(o) * 0.22;
    acc += backdrop(uvr + vec2(o * b, o * b * 0.5), asp, t) * w;
    wsum += w;
  }
  vec3 col = acc / wsum;

  float shade = 1.0 - 0.24 * pow(abs(s), 4.0);
  float glint = exp(-pow((s + 0.6) * 3.0, 2.0)) * 0.16;
  col = col * shade + glint;
  gl_FragColor = vec4(finish(col, gl_FragCoord.xy), 1.0);
}
`;
