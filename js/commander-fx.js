/* Commander card animations.

   Every animated card — the reveal pair, the parked mini cards, the previews
   on the lights page — is drawn through ONE shared WebGL context and copied
   into that card's own 2D canvas. Browsers cap live WebGL contexts at around
   sixteen, and a context per card would hit that on a full table.

   All the effects are procedural in a single fragment shader: no particle
   systems and no hand-made masks. Each card says which effect it runs and
   where its focus point is (the creature's chest, the spell in a hand), plus
   an optional second point for glowing eyes or a breathing mouth. Unless the
   card asks for the whole card, effects stay inside the art window, so the
   name and rules text never ripple.

   Until a card's image has loaded (or if WebGL is unavailable) the canvas is
   simply transparent and the face's own CSS background shows through. */
(function () {
  'use strict';

  /* Shader ids. The labels the lights page shows live on the server, which
     also validates the choice; this list only has to agree on the ids. */
  var EFFECTS = ['foil', 'breath', 'dragon', 'arcane', 'embers', 'storm', 'shadow',
                 'wind', 'radiance', 'caustics', 'glint', 'eyes',
                 'roar', 'heartbeat', 'frost', 'toxic', 'void', 'inferno', 'ghost', 'snow', 'quake'];
  /* The art window of a standard card frame, as fractions of the card image:
     left, top, right, bottom. */
  var ART_BOX = [0.075, 0.1, 0.925, 0.56];
  var WHOLE_CARD = [0, 0, 1, 1];
  var DEFAULT_FOCUS = [0.5, 0.33];
  var MAX_TEXTURE_EDGE = 2048;
  /* A big reveal card at a high pixel ratio is a lot of fill per frame; past
     this many pixels the canvas renders smaller and the browser scales it up. */
  var MAX_CANVAS_PIXELS = 900000;
  var TIME_WRAP = 3600;

  var VERTEX = [
    'attribute vec2 a_pos;',
    'varying vec2 v_uv;',
    'void main() {',
    '  v_uv = vec2(a_pos.x * .5 + .5, .5 - a_pos.y * .5);',
    '  gl_Position = vec4(a_pos, 0., 1.);',
    '}'
  ].join('\n');

  var FRAGMENT = [
    '#ifdef GL_FRAGMENT_PRECISION_HIGH',
    'precision highp float;',
    '#else',
    'precision mediump float;',
    '#endif',
    'varying vec2 v_uv;',
    'uniform sampler2D u_tex;',
    'uniform vec2 u_cover;',
    'uniform vec2 u_res;',
    'uniform float u_time;',
    'uniform float u_strength;',
    'uniform float u_effect;',
    'uniform float u_aspect;',
    'uniform vec2 u_focus;',
    'uniform vec2 u_glow;',
    'uniform float u_hasGlow;',
    'uniform vec4 u_art;',

    'float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }',
    'float noise(vec2 p) {',
    '  vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3. - 2. * f);',
    '  return mix(mix(hash(i), hash(i + vec2(1., 0.)), u.x), mix(hash(i + vec2(0., 1.)), hash(i + vec2(1., 1.)), u.x), u.y);',
    '}',
    'float fbm(vec2 p) { float v = 0., a = .5; for (int i = 0; i < 4; i++) { v += a * noise(p); p *= 2.03; a *= .5; } return v; }',
    'vec3 tex(vec2 uv) { return texture2D(u_tex, clamp(uv, .001, .999)).rgb; }',
    'float luma(vec3 c) { return dot(c, vec3(.299, .587, .114)); }',
    'vec3 hue(float h) { return clamp(abs(fract(h + vec3(0., 2. / 3., 1. / 3.)) * 6. - 3.) - 1., 0., 1.); }',
    /* 1 inside the art window, soft at its edges; the frame and text stay still. */
    'float artMask(vec2 uv) {',
    '  vec2 lo = smoothstep(u_art.xy, u_art.xy + .015, uv);',
    '  vec2 hi = 1. - smoothstep(u_art.zw - .015, u_art.zw, uv);',
    '  return lo.x * lo.y * hi.x * hi.y;',
    '}',
    /* A distance on the card in which circles stay round. */
    'vec2 round2(vec2 d) { return d * vec2(u_aspect, 1.); }',
    /* Soft drifting points: some cells of a scrolling grid hold one each. */
    'float particles(vec2 p, float density, vec2 velocity, float size, float t) {',
    '  vec2 q = p * density - velocity * t;',
    '  vec2 cell = floor(q); vec2 f = fract(q);',
    '  float h = hash(cell);',
    '  vec2 c = vec2(hash(cell + 7.1), hash(cell + 3.7)) * .8 + .1;',
    '  float twinkle = .5 + .5 * sin(t * (2. + h * 4.) + h * 30.);',
    '  return step(.55, h) * (1. - smoothstep(0., size, length(f - c))) * twinkle;',
    '}',
    /* Rising rings, like particles() but hollow: bubbles. */
    'float bubbles(vec2 p, float density, vec2 velocity, float size, float t) {',
    '  vec2 q = p * density - velocity * t;',
    '  vec2 cell = floor(q); vec2 f = fract(q);',
    '  float h = hash(cell + 1.3);',
    '  vec2 c = vec2(hash(cell + 2.1), hash(cell + 5.9)) * .7 + .15;',
    '  float r = size * (.5 + .5 * h);',
    '  float d = length(f - c);',
    '  return step(.6, h) * (1. - smoothstep(r * .8, r, d)) * smoothstep(r * .45, r * .8, d);',
    '}',
    /* A pulsing glow in the colour already at that point, widened sideways to
       take in a pair of eyes. */
    'vec3 eyeGlow(vec2 uv, vec2 p, float t) {',
    '  vec3 c = tex(p); c = normalize(c + .06) * 1.25;',
    '  vec2 d = round2(uv - p) * vec2(.55, 1.);',
    '  float r2 = dot(d, d);',
    '  float pulse = .55 + .45 * sin(t * 2.2);',
    '  return c * (exp(-r2 / .0005) + .35 * exp(-r2 / .006)) * pulse;',
    '}',

    'void main() {',
    '  vec2 uv = (v_uv - .5) * u_cover + .5;',
    '  float t = u_time; float s = u_strength;',
    '  int fx = int(u_effect + .5);',
    /* Roar and quake shake the whole card. The picture is zoomed in a touch
       while it shakes, so the jitter never shows past an edge. */
    '  float env = 0.; float rp = 0.;',
    '  if (fx == 12) {',
    '    rp = mod(t, 4.6);',
    '    env = smoothstep(0., .08, rp) * (1. - smoothstep(1.15, 1.7, rp));',
    '    vec2 jit = vec2(noise(vec2(t * 41., 1.)), noise(vec2(t * 41., 9.))) - .5;',
    '    uv = (uv - .5) * (1. - .04 * env * s) + .5 + jit * .016 * env * s;',
    '  }',
    '  if (fx == 20) {',
    '    rp = mod(t, 6.);',
    '    env = smoothstep(0., .3, rp) * (1. - smoothstep(1.6, 2.6, rp));',
    '    vec2 jit = vec2(noise(vec2(t * 13., 3.)) - .5, (noise(vec2(t * 17., 7.)) - .5) * 1.4);',
    '    uv = (uv - .5) * (1. - .05 * env * s) + .5 + jit * .018 * env * s;',
    '  }',
    '  float m = artMask(uv);',
    '  vec2 ap = (uv - u_art.xy) / (u_art.zw - u_art.xy);',
    '  vec2 suv = uv; vec3 add = vec3(0.); float gain = 1.;',
    '  bool glowAddOn = u_hasGlow > .5;',
    '  float lum0 = luma(tex(uv));',

    /* Bellows: the art swells and settles around the focus on a slow breath;
       on the exhale a puff leaves the second point (mist, or fire). */
    '  if (fx == 1 || fx == 2) {',
    '    float ph = fract(t / 3.8);',
    '    float b = .5 - .5 * cos(ph * 6.2832);',
    '    vec2 d = round2(uv - u_focus);',
    '    float fall = exp(-dot(d, d) / .07);',
    '    suv = u_focus + (uv - u_focus) * (1. - .075 * s * b * fall * m);',
    '    gain = 1. + .07 * s * b * fall * m;',
    '    glowAddOn = false;',
    '    if (u_hasGlow > .5) {',
    '      float ex = smoothstep(.5, .6, ph) * (1. - smoothstep(.86, 1., ph));',
    '      float e = clamp((ph - .5) / .45, 0., 1.);',
    '      vec2 dir = normalize(round2(u_glow - u_focus) + vec2(.0001));',
    '      vec2 g = round2(uv - u_glow);',
    '      vec2 rc = vec2(dot(g, dir), dot(g, vec2(-dir.y, dir.x)));',
    '      vec2 pc = rc - vec2(e * .12, 0.);',
    '      float puff = exp(-dot(pc, pc) / (.002 + e * .014)) * ex;',
    '      if (fx == 1) {',
    '        add += vec3(.85, .9, 1.) * puff * .75 * s;',
    '      } else {',
    '        add += mix(vec3(1., .85, .45), vec3(1., .32, .06), e) * puff * 1.1 * s;',
    '        float cone = smoothstep(-.01, .04, rc.x) * (1. - smoothstep(0., max(.01, .05 + rc.x * .6), abs(rc.y))) * (1. - smoothstep(.16, .34, rc.x));',
    '        float sparks = particles(rc, 22., vec2(1.4, 0.), .14, t) + particles(rc + 3.1, 34., vec2(1.9, 0.), .1, t);',
    '        add += vec3(1., .5, .15) * sparks * cone * ex * 1.6 * s;',
    '      }',
    '      add *= m;',
    '    }',
    '  }',

    /* Arcane flow: only the bright parts (spells, glowing eyes) ripple and
       shift colour; dark areas stay still. Motes drift upward. */
    '  if (fx == 3) {',
    '    float bright = smoothstep(.45, .85, lum0);',
    '    vec2 flow = vec2(fbm(uv * 4. + vec2(t * .12, 0.)), fbm(uv * 4. + vec2(5.2, -t * .1))) - .5;',
    '    suv = uv + flow * .03 * s * bright * m;',
    '    vec3 shift = .6 + .8 * hue(fract(t * .05 + flow.x * 1.5 + uv.y * .3));',
    '    add += (shift - 1.) * tex(suv) * .35 * bright * s * m;',
    '    add += tex(suv) * bright * .18 * (.5 + .5 * sin(t * 1.7 + uv.y * 6.)) * s * m;',
    '    float motes = particles(vec2(ap.x * 1.4, ap.y), 14., vec2(.05, -.35), .16, t) + particles(vec2(ap.x * 1.4, ap.y) + 7.3, 22., vec2(-.04, -.5), .12, t);',
    '    add += (vec3(.55, .75, 1.) + .35 * hue(t * .05)) * motes * .9 * s * m;',
    '  }',

    /* Heat haze and embers: rippling air, stronger at the top; sparks rise
       from the bottom and the light flickers warm. */
    '  if (fx == 4) {',
    '    float top = 1. - clamp(ap.y, 0., 1.);',
    '    vec2 hz = vec2(noise(vec2(uv.x * 14., uv.y * 10. + t * 2.2)), noise(vec2(uv.x * 9. + 3., uv.y * 12. + t * 1.6))) - .5;',
    '    suv = uv + hz * .013 * s * (.35 + .65 * top) * m;',
    '    float flick = noise(vec2(t * 5., 1.));',
    '    gain = 1. + (flick - .5) * .14 * s * m;',
    '    add += vec3(1., .45, .12) * .08 * s * m * (.5 + .5 * flick) * (1. - top);',
    '    float emb = particles(vec2(ap.x * 1.3, ap.y), 16., vec2(sin(t * .7) * .1, -.6), .14, t) + particles(vec2(ap.x * 1.3, ap.y) + 4.7, 26., vec2(.08, -.9), .1, t);',
    '    add += vec3(1., .55, .15) * emb * 1.4 * s * m * (.25 + .75 * clamp(ap.y, 0., 1.));',
    '  }',

    /* Storm: lightning strikes every couple of seconds — a flash (often a double)
       with a colour split and a small shake. */
    '  float flash = 0.;',
    '  if (fx == 5) {',
    /* A strike in most 2.2 s windows, at a random moment in each, so they come
       often but never on a beat; some are a single flash, some a double. */
    '    float k = floor(t / 2.2);',
    '    float dt = t - k * 2.2 - (.15 + hash(vec2(k, 2.)) * 1.5);',
    '    if (dt > 0.) flash += exp(-dt * 10.);',
    '    if (dt > .16) flash += .7 * exp(-(dt - .16) * 12.) * step(.35, hash(vec2(k, 8.)));',
    '    flash *= step(.12, hash(vec2(k, 5.))) * s;',
    '    vec2 shake = (vec2(hash(vec2(floor(t * 30.), 1.)), hash(vec2(floor(t * 30.), 2.))) - .5) * .007 * flash;',
    '    suv = uv + shake * m;',
    '  }',

    /* Shadow and frost creep in from the edges along a rounded distance from
       the art's centre that flowing noise keeps bending, so their front is
       organic rather than the art box's rectangle. */
    '  vec2 sw = vec2(0.); vec2 sc = vec2(0.); float sr = 0.; float tendril = 0.;',
    '  if (fx == 6 || fx == 14) {',
    '    float slow = fx == 14 ? .4 : 1.;',
    '    sw = vec2(fbm(ap * 2.6 + vec2(.06, .02) * t * slow), fbm(ap * 2.6 + vec2(4.1, 1.7) + vec2(-.05, .04) * t * slow)) - .5;',
    '    sc = (ap - .5 + sw * .32) * vec2(1., .9);',
    '    sr = length(sc) * 2.;',
    '    tendril = fbm(sc * 4.5 + vec2(.09, -.11) * t * slow + sw * 2.);',
    '  }',
    '  if (fx == 6) suv = uv + sw * .02 * s * m * smoothstep(.45, 1.1, sr);',

    /* Wind: the upper art sways as if in a breeze, with pollen drifting. */
    '  float gust = noise(vec2(t * .4, 0.)) * .6 + .4;',
    '  if (fx == 7) {',
    '    float h = pow(1. - clamp(ap.y, 0., 1.), 1.5);',
    '    float sway = sin(t * 1.4 + ap.y * 3. + noise(uv * 3. + t * .3) * 2.) * .009 * gust + (noise(vec2(uv.y * 8., t * .8)) - .5) * .005;',
    '    suv.x += sway * h * s * m;',
    '    float pollen = particles(vec2(ap.x * 1.4, ap.y), 12., vec2(.5, .12) * (.6 + gust), .15, t) + particles(vec2(ap.x * 1.4, ap.y) + 2.9, 20., vec2(.7, .2) * (.6 + gust), .1, t);',
    '    add += vec3(.95, .9, .55) * pollen * .75 * s * m;',
    '  }',

    /* Caustics: rippling underwater light. */
    '  if (fx == 9) {',
    '    suv = uv + vec2(sin(ap.y * 20. + t * 1.5), cos(ap.x * 18. + t * 1.2)) * .0028 * s * m;',
    '  }',

    /* Roar: sound-wave rings ripple out from the mouth (the eyes / mouth
       point, or the focus) while the card shakes. */
    '  float wave = 0.;',
    '  if (fx == 12) {',
    '    glowAddOn = false;',
    '    vec2 src = u_hasGlow > .5 ? u_glow : u_focus;',
    '    vec2 d = round2(uv - src); float r = length(d);',
    '    vec2 dir = d / max(r, .0001);',
    '    for (int k = 0; k < 4; k++) {',
    '      float p = rp - float(k) * .17;',
    '      if (p > 0. && p < 1.3) wave += exp(-pow((r - p * .62) / .02, 2.)) * (1. - p / 1.3);',
    '    }',
    '    suv = uv - dir / vec2(u_aspect, 1.) * wave * .013 * s * m;',
    '    gain = 1. + .08 * env * s;',
    '  }',
    /* Heartbeat: a lub-dub throb around the focus. */
    '  float beat = 0.;',
    '  if (fx == 13) {',
    '    float hp = mod(t, 1.15);',
    '    beat = exp(-pow((hp - .08) / .055, 2.)) + .65 * exp(-pow((hp - .33) / .06, 2.));',
    '    vec2 d = round2(uv - u_focus);',
    '    float fall = exp(-dot(d, d) / .12);',
    '    suv = u_focus + (uv - u_focus) * (1. - .045 * beat * s * fall * m);',
    '    gain = 1. + .06 * beat * s * m;',
    '  }',
    /* Frost: ice creeps in from the edges and bends the light a little. */
    '  float frost = 0.;',
    '  if (fx == 14) {',
    '    float reach = 1.16 - .1 * (.5 + .5 * sin(t * .35));',
    '    frost = clamp(smoothstep(reach - .28, reach + .02, sr + (tendril - .5) * .6) * s, 0., 1.);',
    '    suv = uv + (vec2(noise(ap * 24.), noise(ap * 24. + 3.)) - .5) * .007 * frost * m;',
    '  }',
    /* Toxic: the lower art wavers in a sickly haze. */
    '  if (fx == 15) {',
    '    suv = uv + vec2(sin(ap.y * 16. - t * 2.2) * .004, 0.) * smoothstep(.2, 1., ap.y) * s * m;',
    '  }',
    /* Void rift: the art twists into a slowly breathing vortex at the focus. */
    '  float vr = 0.;',
    '  if (fx == 16) {',
    '    vec2 d = round2(uv - u_focus); vr = length(d);',
    '    float ang = s * (1.1 * exp(-vr * vr / .03) + .25 * exp(-vr * vr / .15)) * (.75 + .25 * sin(t * .6));',
    '    float ca = cos(ang), sa = sin(ang);',
    '    vec2 rd = vec2(ca * d.x - sa * d.y, sa * d.x + ca * d.y);',
    '    suv = mix(uv, u_focus + rd / vec2(u_aspect, 1.), m);',
    '  }',
    /* Inferno: hot air above the flames. */
    '  if (fx == 17) {',
    '    vec2 hz = vec2(noise(vec2(uv.x * 12., uv.y * 9. + t * 2.6)), noise(vec2(uv.x * 8. + 3., uv.y * 11. + t * 2.))) - .5;',
    '    suv = uv + hz * .016 * s * m;',
    '  }',
    /* Artifact: a rare glitch shifts a few slices sideways. */
    '  float glitch = 0.;',
    '  if (fx == 10) {',
    '    glitch = step(.985, hash(vec2(floor(t * 12.), 9.))) * step(.5, hash(vec2(floor(uv.y * 28.), floor(t * 12.))));',
    '    suv.x += glitch * .014 * s * m;',
    '  }',

    '  vec3 col = tex(suv);',
    '  if (fx == 5) {',
    '    float split = .005 * flash * m;',
    '    col = vec3(tex(suv + vec2(split, 0.)).r, col.g, tex(suv - vec2(split, 0.)).b);',
    '    col = mix(col, col * .9, m * s * .6);',
    '    col = mix(col, col * 1.6 + vec3(.25, .3, .45) * .6, clamp(flash, 0., 1.) * m);',
    '  }',
    '  if (fx == 12) {',
    '    float split = .005 * env * s * m;',
    '    col = vec3(tex(suv + vec2(split, 0.)).r, col.g, tex(suv - vec2(split, 0.)).b);',
    '    add += vec3(1., .95, .9) * wave * .2 * s * m;',
    '  }',
    '  if (fx == 10 && glitch > 0.) {',
    '    col = vec3(tex(suv + vec2(.004, 0.)).r, col.g, tex(suv - vec2(.004, 0.)).b);',
    '  }',
    '  col *= gain;',

    /* Shadow creep: smoke breathes in from the edges along the bent field,
       with wisps curling ahead of it; colour drains on each pulse. */
    '  if (fx == 6) {',
    '    float pulse = .5 + .5 * sin(t * .9);',
    '    float reach = 1.04 - .2 * pulse;',
    '    float field = sr + (tendril - .5) * .7;',
    '    float dark = smoothstep(reach - .3, reach + .05, field);',
    '    float wisp = smoothstep(.5, .72, fbm(sc * 7. - vec2(.12, .05) * t + sw * 3.)) * smoothstep(reach - .55, reach - .1, field);',
    '    col *= 1. - clamp((.85 * dark + .35 * wisp) * s, 0., 1.) * m;',
    '    col = mix(col, vec3(luma(col)), clamp(.3 * pulse * s, 0., 1.) * m);',
    '  }',

    /* Radiance: slowly turning rays from the focus and a soft glow pulse. */
    '  if (fx == 8) {',
    '    vec2 d = round2(uv - u_focus); float r = length(d); float a = atan(d.y, d.x);',
    '    float rays = (.5 + .5 * sin(a * 9. + t * .25)) * (.5 + .5 * sin(a * 14. - t * .18 + 1.));',
    '    rays *= rays;',
    '    float pulse = .75 + .25 * sin(t * 1.1);',
    '    add += vec3(1., .95, .8) * rays * exp(-r * 2.2) * .5 * s * m * pulse;',
    '    add += vec3(1., .97, .85) * exp(-r * r / .01) * .35 * s * m * pulse;',
    '    col += col * smoothstep(.55, 1., luma(col)) * .25 * pulse * s * m;',
    '  }',

    '  if (fx == 9) {',
    '    vec2 p = ap * 6.; vec2 i = p; float c = 0.;',
    '    for (int n = 0; n < 4; n++) {',
    '      float tt = t * .35 * (1. - 3.5 / float(n + 1));',
    '      i = p + vec2(cos(tt - i.x) + sin(tt + i.y), sin(tt - i.y) + cos(tt + i.x));',
    '      c += 1. / length(vec2(p.x / (sin(i.x + tt) / .005), p.y / (cos(i.y + tt) / .005)));',
    '    }',
    '    c /= 4.; c = 1.17 - pow(c, 1.4); c = pow(abs(c), 8.);',
    '    col = mix(col, col * vec3(.85, 1., 1.1), .25 * s * m);',
    '    add += vec3(.6, .9, 1.) * clamp(c, 0., 1.) * .28 * s * m;',
    '  }',

    /* Artifact glint: a metallic shine sweeps the card, scanlines over the art. */
    '  if (fx == 10) {',
    '    float pos = fract(t / 5.5) * 2.4 - .7;',
    '    float diag = uv.x * .7 + uv.y * .5;',
    '    float band = exp(-pow((diag - pos) * 14., 2.)) + .5 * exp(-pow((diag - pos + .06) * 30., 2.));',
    '    add += vec3(1., .97, .9) * band * (.25 + .6 * smoothstep(.25, .8, luma(col))) * .6 * s;',
    '    col *= 1. - .06 * s * m * (.5 + .5 * sin(v_uv.y * u_res.y * 1.5708));',
    '  }',

    /* Foil: a rainbow sheen and a slow light band across the whole card. */
    '  if (fx == 0) {',
    '    float hh = fract(uv.x * .6 + uv.y * .9 - t * .06);',
    '    float sweep = .5 + .5 * sin((uv.x + uv.y) * 3. - t * .7);',
    '    add += hue(hh) * .1 * s * (.4 + .6 * sweep) * (.3 + .7 * luma(col));',
    '    float band = exp(-pow((uv.x - uv.y * .4 - (fract(t / 7.) * 2. - .5)) * 8., 2.));',
    '    add += vec3(1.) * band * .12 * s;',
    '  }',

    /* Heartbeat: the edges flush red with every beat. */
    '  if (fx == 13) {',
    '    float vig = smoothstep(.45, 1.25, length((ap - .5) * 2.));',
    '    col = mix(col, col * vec3(1.15, .5, .5), clamp(vig * (.25 + .6 * beat) * s, 0., 1.) * m);',
    '    add += vec3(.55, 0., .04) * vig * beat * .3 * s * m;',
    '  }',
    /* Frost: icy crystals, a cold tint and glints in the ice. */
    '  if (fx == 14) {',
    '    float crystal = pow(1. - abs(noise(ap * vec2(22., 18.) + sw * 3.) * 2. - 1.), 10.) + .5 * pow(1. - abs(noise(ap * vec2(41., 35.) - sw * 2.) * 2. - 1.), 12.);',
    '    vec3 ice = mix(col, vec3(.86, .94, 1.), .3 + .45 * frost) + crystal * .14 * frost;',
    '    col = mix(col, ice, frost * m);',
    '    col = mix(col, col * vec3(.9, .98, 1.1), .5 * clamp(s, 0., 1.) * m);',
    '    add += vec3(.9, .97, 1.) * particles(vec2(ap.x * 1.4, ap.y), 26., vec2(0.), .12, t) * (.3 + .7 * frost) * .8 * s * m;',
    '  }',
    /* Toxic: green haze rising from below, and bubbles. */
    '  if (fx == 15) {',
    '    float low = smoothstep(.2, 1., ap.y);',
    '    float haze = fbm(ap * vec2(3., 2.2) + vec2(.05, .22) * t);',
    '    col = mix(col, col * vec3(.78, 1.12, .62), .35 * clamp(s, 0., 1.) * m);',
    '    add += vec3(.35, 1., .25) * smoothstep(.35, .8, haze) * (.3 + .7 * low) * .3 * s * m;',
    '    vec2 bp = vec2(ap.x * 1.4 + sin(t * 1.3 + ap.y * 9.) * .01, ap.y);',
    '    float bub = bubbles(bp, 11., vec2(0., -.45), .3, t) + bubbles(bp + 4.4, 17., vec2(0., -.6), .26, t);',
    '    add += vec3(.6, 1., .45) * bub * (.3 + .7 * low) * .9 * s * m;',
    '  }',
    /* Void rift: a dark core, a pulsing violet rim and turning spiral arms. */
    '  if (fx == 16) {',
    '    vec2 d = round2(uv - u_focus);',
    '    float core = exp(-vr * vr / .005);',
    '    float rim = exp(-pow((vr - .075 - .012 * sin(t * 2.3)) / .018, 2.));',
    '    float arms = .5 + .5 * sin(atan(d.y, d.x) * 3. - vr * 28. + t * 1.6);',
    '    col = mix(col, vec3(.02, 0., .05), clamp(core * 1.2 * s, 0., 1.) * m);',
    '    add += vec3(.55, .2, 1.) * (rim * .7 + exp(-vr * 5.) * arms * .35) * s * m;',
    '    col = mix(col, col * vec3(.85, .75, 1.15), .3 * clamp(s, 0., 1.) * m);',
    '  }',
    /* Inferno: flames lick up from the bottom of the art, with embers. */
    '  if (fx == 17) {',
    '    float n = fbm(vec2(ap.x * 4.5, ap.y * 2.6 + t * 1.7)) + .5 * fbm(vec2(ap.x * 9. + 2., ap.y * 5. + t * 2.6));',
    '    float f = clamp((ap.y - .42) * 1.7 + (n - .75) * 1.1, 0., 1.);',
    '    vec3 fire = mix(vec3(.75, .08, 0.), vec3(1., .55, .08), smoothstep(.1, .6, f));',
    '    fire = mix(fire, vec3(1., .92, .6), smoothstep(.65, 1., f));',
    '    add += fire * f * f * 1.2 * s * m;',
    '    add += vec3(1., .55, .15) * particles(vec2(ap.x * 1.3, ap.y), 18., vec2(.06, -.8), .12, t) * 1.2 * s * m;',
    '  }',
    /* Ghost: cold and drained, with a drifting after-image, flicker and fog. */
    '  if (fx == 18) {',
    '    vec3 ghost = tex(suv + vec2(sin(t * .7) * .014, cos(t * .53) * .009) * m);',
    '    col = mix(col, vec3(luma(col)) * vec3(.82, .95, 1.12), .45 * clamp(s, 0., 1.) * m);',
    '    col = mix(col, max(col, ghost * vec3(.75, .92, 1.15)), .5 * clamp(s, 0., 1.) * m);',
    '    col *= 1. - .18 * step(.92, hash(vec2(floor(t * 12.), 4.))) * s * m;',
    '    add += vec3(.6, .75, .95) * smoothstep(.5, .8, fbm(ap * 3. + vec2(.06, -.03) * t)) * .22 * s * m;',
    '  }',
    /* Snowfall: three depths of flakes drifting down. */
    '  if (fx == 19) {',
    '    vec2 sp = vec2(ap.x * 1.4, ap.y);',
    '    float flakes = particles(sp, 9., vec2(sin(t * .3) * .08 + .05, .28), .24, t) + particles(sp + 3.3, 15., vec2(sin(t * .4 + 1.) * .06 + .04, .4), .2, t) + .7 * particles(sp + 7.1, 24., vec2(.03, .55), .16, t);',
    '    col = mix(col, col * vec3(.92, .97, 1.06), .4 * clamp(s, 0., 1.) * m);',
    '    add += vec3(1.) * min(flakes, 1.) * 1.1 * s * m;',
    '  }',
    /* Quake: dust shaken loose while the card rumbles. */
    '  if (fx == 20) {',
    '    float dust = particles(vec2(ap.x * 1.4, ap.y), 20., vec2(0., .9), .1, t) + particles(vec2(ap.x * 1.4, ap.y) + 5.2, 32., vec2(.05, 1.3), .08, t);',
    '    add += vec3(.85, .75, .6) * dust * env * .8 * s * m;',
    '    col *= 1. - .1 * env * s * m;',
    '  }',
    /* Glowing eyes: the effect itself at the focus, or an add-on at the
       second point for any effect but the breaths (which use it as the mouth). */
    '  if (fx == 11) add += eyeGlow(uv, u_focus, t) * s * m;',
    '  if (glowAddOn) add += eyeGlow(uv, u_glow, t) * s * m;',

    '  col += add * (1. - col * .5);',
    '  gl_FragColor = vec4(clamp(col, 0., 1.), 1.);',
    '}'
  ].join('\n');

  var gl = null;
  var glCanvas = null;
  var program = null;
  var loc = {};
  var failed = false;
  var instances = [];
  var textures = {};
  var frameRequested = false;

  function compile(type, source) {
    var shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      var message = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(message);
    }
    return shader;
  }

  function setupProgram() {
    program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    ['u_tex', 'u_cover', 'u_res', 'u_time', 'u_strength', 'u_effect', 'u_aspect',
     'u_focus', 'u_glow', 'u_hasGlow', 'u_art'].forEach(function (name) {
      loc[name] = gl.getUniformLocation(program, name);
    });
    var buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    var position = gl.getAttribLocation(program, 'a_pos');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    gl.uniform1i(loc.u_tex, 0);
  }

  function init() {
    if (gl) return true;
    if (failed) return false;
    try {
      glCanvas = document.createElement('canvas');
      glCanvas.width = 2;
      glCanvas.height = 2;
      gl = glCanvas.getContext('webgl', { alpha: false, antialias: false, depth: false,
                                          premultipliedAlpha: false, preserveDrawingBuffer: false }) ||
           glCanvas.getContext('experimental-webgl');
      if (!gl) throw new Error('WebGL is not available');
      setupProgram();
      glCanvas.addEventListener('webglcontextlost', function (event) { event.preventDefault(); });
      glCanvas.addEventListener('webglcontextrestored', function () {
        setupProgram();
        Object.keys(textures).forEach(function (url) {
          var entry = textures[url];
          entry.texture = null;
          if (entry.source) upload(entry);
        });
      });
      return true;
    } catch (error) {
      failed = true;
      gl = null;
      if (window.console) console.warn('Commander animations are off:', error.message || error);
      return false;
    }
  }

  function upload(entry) {
    entry.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, entry.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, entry.source);
  }

  /* One texture per picture, shared by every card showing it. */
  function acquireTexture(url) {
    var entry = textures[url];
    if (entry) {
      entry.refs++;
      return entry;
    }
    entry = textures[url] = { refs: 1, texture: null, source: null, width: 0, height: 0 };
    var image = new Image();
    image.decoding = 'async';
    image.onload = function () {
      if (textures[url] !== entry || !gl) return;
      var limit = Math.min(MAX_TEXTURE_EDGE, gl.getParameter(gl.MAX_TEXTURE_SIZE) || MAX_TEXTURE_EDGE);
      var scale = Math.min(1, limit / Math.max(image.naturalWidth, image.naturalHeight));
      var source = image;
      if (scale < 1) {
        source = document.createElement('canvas');
        source.width = Math.round(image.naturalWidth * scale);
        source.height = Math.round(image.naturalHeight * scale);
        source.getContext('2d').drawImage(image, 0, 0, source.width, source.height);
      }
      entry.source = source;
      entry.width = image.naturalWidth;
      entry.height = image.naturalHeight;
      try { upload(entry); } catch (error) { entry.texture = null; }
    };
    image.src = url;
    return entry;
  }

  function releaseTexture(url) {
    var entry = textures[url];
    if (!entry) return;
    entry.refs--;
    if (entry.refs > 0) return;
    if (entry.texture && gl) gl.deleteTexture(entry.texture);
    delete textures[url];
  }

  /* "x% y%" as fractions, or the fallback when blank or malformed. */
  function parsePoint(text, fallback) {
    var match = /^\s*([\d.]+)%\s+([\d.]+)%\s*$/.exec(text || '');
    if (!match) return fallback;
    return [Math.min(1, +match[1] / 100), Math.min(1, +match[2] / 100)];
  }

  function normalise(options) {
    var effect = EFFECTS.indexOf(options.effect);
    return {
      image: options.image || '',
      effect: effect < 0 ? 0 : effect,
      focus: parsePoint(options.focus, DEFAULT_FOCUS),
      glow: parsePoint(options.glow, null),
      art: options.area === 'card' ? WHOLE_CARD : ART_BOX,
      strength: typeof options.strength === 'number' ? options.strength : 1,
      fps: options.fps || 60,
      maxRatio: options.maxRatio || 2
    };
  }

  function sameOptions(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  /* The image's cover crop inside a box, as the scale applied to box uv. */
  function coverScale(entry, width, height) {
    if (!entry.width || !entry.height) return [1, 1];
    var box = width / height;
    var image = entry.width / entry.height;
    return image > box ? [box / image, 1] : [1, image / box];
  }

  function Instance(host, options) {
    var self = this;
    this.host = host;
    this.options = normalise(options);
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'commander-fx';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.context = this.canvas.getContext('2d');
    this.width = 0;
    this.height = 0;
    this.last = 0;
    this.texture = this.options.image ? acquireTexture(this.options.image) : null;
    host.appendChild(this.canvas);
    this.measure = function (width, height) {
      var ratio = Math.min(window.devicePixelRatio || 1, self.options.maxRatio);
      var w = width * ratio;
      var h = height * ratio;
      var shrink = Math.min(1, Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, w * h)));
      self.width = Math.max(0, Math.round(w * shrink));
      self.height = Math.max(0, Math.round(h * shrink));
      if (self.canvas.width !== self.width) self.canvas.width = self.width;
      if (self.canvas.height !== self.height) self.canvas.height = self.height;
    };
    // Layout size, not the on-screen one: the flying reveal card is scaled
    // by a transform, and that must not change how finely it is drawn.
    this.measure(host.clientWidth, host.clientHeight);
    if (window.ResizeObserver) {
      this.observer = new ResizeObserver(function (entries) {
        var box = entries[0].contentRect;
        self.measure(box.width, box.height);
      });
      this.observer.observe(host);
    }
  }

  Instance.prototype.update = function (options) {
    var next = normalise(options);
    if (sameOptions(next, this.options)) return;
    if (next.image !== this.options.image) {
      if (this.options.image) releaseTexture(this.options.image);
      this.texture = next.image ? acquireTexture(next.image) : null;
    }
    this.options = next;
    this.last = 0;
  };

  Instance.prototype.destroy = function () {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.observer) this.observer.disconnect();
    if (this.canvas.parentNode) this.canvas.parentNode.removeChild(this.canvas);
    if (this.options.image) releaseTexture(this.options.image);
    var index = instances.indexOf(this);
    if (index !== -1) instances.splice(index, 1);
  };

  /* A point given on the card box, as a point on the image (and back), so a
     click on a preview lands on the same spot of the picture the shader uses. */
  Instance.prototype.boxToImage = function (x, y) {
    var cover = coverScale(this.texture || {}, this.width || 5, this.height || 7);
    return [(x - 0.5) * cover[0] + 0.5, (y - 0.5) * cover[1] + 0.5];
  };
  Instance.prototype.imageToBox = function (x, y) {
    var cover = coverScale(this.texture || {}, this.width || 5, this.height || 7);
    return [(x - 0.5) / cover[0] + 0.5, (y - 0.5) / cover[1] + 0.5];
  };

  Instance.prototype.draw = function (now) {
    var entry = this.texture;
    if (!entry || !entry.texture || !this.width || !this.height) return;
    if (now - this.last < 1000 / this.options.fps - 2) return;
    this.last = now;
    var w = this.width;
    var h = this.height;
    if (glCanvas.width < w || glCanvas.height < h) {
      glCanvas.width = Math.max(glCanvas.width, w);
      glCanvas.height = Math.max(glCanvas.height, h);
    }
    var o = this.options;
    var cover = coverScale(entry, w, h);
    gl.viewport(0, 0, w, h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, entry.texture);
    gl.uniform2f(loc.u_cover, cover[0], cover[1]);
    gl.uniform2f(loc.u_res, w, h);
    gl.uniform1f(loc.u_time, (now / 1000) % TIME_WRAP);
    gl.uniform1f(loc.u_strength, o.strength);
    gl.uniform1f(loc.u_effect, o.effect);
    gl.uniform1f(loc.u_aspect, entry.width / entry.height);
    gl.uniform2f(loc.u_focus, o.focus[0], o.focus[1]);
    gl.uniform2f(loc.u_glow, o.glow ? o.glow[0] : 0, o.glow ? o.glow[1] : 0);
    gl.uniform1f(loc.u_hasGlow, o.glow ? 1 : 0);
    gl.uniform4f(loc.u_art, o.art[0], o.art[1], o.art[2], o.art[3]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    // The viewport sits at the bottom-left of the shared canvas.
    this.context.globalCompositeOperation = 'copy';
    this.context.drawImage(glCanvas, 0, glCanvas.height - h, w, h, 0, 0, w, h);
  };

  function frame(now) {
    frameRequested = false;
    if (!instances.length) return;
    if (gl && !gl.isContextLost()) {
      instances.slice().forEach(function (instance) {
        // A card thrown away with its element takes its animation with it.
        if (!instance.canvas.isConnected) {
          instance.destroy();
          return;
        }
        instance.draw(now);
      });
    }
    if (instances.length) requestFrame();
  }

  function requestFrame() {
    if (frameRequested) return;
    frameRequested = true;
    window.requestAnimationFrame(frame);
  }

  /* Animate the card face `host` (a positioned element showing the card).
     Returns a handle with update(options) and destroy(), or null when this
     browser cannot animate. Options: image (URL), effect (one of EFFECTS),
     focus and glow ("x% y%" on the card image), area ("art" or "card"),
     strength (1 = normal), fps (frame cap), maxRatio (pixel-ratio cap). */
  function attach(host, options) {
    if (!host || !init()) return null;
    var instance = new Instance(host, options);
    instances.push(instance);
    requestFrame();
    return instance;
  }

  window.CommanderFx = {
    attach: attach,
    effects: EFFECTS.slice(),
    supported: function () { return init(); }
  };
})();
