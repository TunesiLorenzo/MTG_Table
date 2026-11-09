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
                 'roar', 'heartbeat', 'frost', 'toxic', 'void', 'inferno', 'ghost', 'snow', 'quake',
                 'blood', 'vines', 'time', 'rain', 'mana', 'cosmic', 'treasure', 'clockwork'];
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

    /* The five colours of mana, for the mana orbit. */
    'vec3 manaColor(int i) {',
    '  if (i == 0) return vec3(1., .93, .7);',
    '  if (i == 1) return vec3(.3, .55, 1.);',
    '  if (i == 2) return vec3(.6, .32, .8);',
    '  if (i == 3) return vec3(1., .32, .14);',
    '  return vec3(.3, .9, .38);',
    '}',

    /* A gear seen face on, for clockwork: its centre c and pitch radius r on */
    /* the round2 scale, n teeth, turned by a. Two gears mesh when their n / r */
    /* match and their centres sit r1 + r2 apart. Returns how much of the */
    /* point is metal, and how brightly it is lit (above 1 is a highlight). */
    'vec2 gear(vec2 p, vec2 c, float r, float n, float a) {',
    '  vec2 d = p - c; float rr = length(d); float wa = atan(d.y, d.x); float ang = wa + a;',
    '  float h = r * 6.2832 / n * .42; float root = r - h * .5;',
    '  float edge = root + h * smoothstep(-.35, .35, sin(ang * n));',
    '  float aa = .0025;',
    '  float body = 1. - smoothstep(edge - aa, edge, rr);',
    '  float off = abs(fract(ang * 5. / 6.2832) - .5) * 6.2832 / 5.;',
    '  float sd = rr * sin(off) - r * .09;',
    '  float spoke = 1. - smoothstep(0., aa, sd);',
    '  float ring = smoothstep(r * .3, r * .3 + aa, rr) * (1. - smoothstep(r * .64 - aa, r * .64, rr));',
    '  float window = ring * (1. - spoke);',
    '  float axle = 1. - smoothstep(r * .1, r * .1 + aa, rr);',
    '  float lit = .5 + .5 * dot(d / max(rr, .0001), vec2(-.6, -.8));',
    /* Light on turned metal: a bright cross that stays put while the gear turns. */
    '  float lathe = pow(abs(cos(wa * 2. + .9)), 8.);',
    '  float outer = 1. - smoothstep(0., .008, edge - rr);',
    '  float inner = exp(-pow((rr - r * .64) / .005, 2.)) + exp(-pow((rr - r * .3) / .005, 2.));',
    '  float sideBevel = ring * exp(-pow(sd / .004, 2.));',
    '  float line = 1. - smoothstep(0., .0025, edge - rr);',
    '  float groove = exp(-pow((rr - root + .009) / .0018, 2.));',
    '  float boss = 1. - smoothstep(r * .26, r * .26 + aa, rr);',
    '  float shade = .38 + .26 * lit + .32 * lathe;',
    '  shade += outer * (lit - .5) * 1.4 + inner * (.5 - lit) + boss * (.08 + .5 * pow(abs(cos(wa * 2. + .9)), 24.));',
    '  shade *= (.9 + .14 * noise(vec2(rr * 300., 1.))) * (1. - .45 * groove) * (1. - .6 * line) * (1. - .35 * sideBevel);',
    '  shade *= 1. - .12 * step(root, rr);',
    '  return vec2(body * (1. - window) * (1. - axle), shade);',
    '}',
    /* Metal from a gear's shade: dark to bright, with a white-hot highlight. */
    'vec3 metal(float sh, vec3 lo, vec3 hi) {',
    '  return mix(lo, hi, clamp(sh, 0., 1.)) + vec3(1., .95, .82) * max(sh - 1., 0.) * .9;',
    '}',
    /* A burst of sparks for clockwork, at p (round2, from the source): each is */
    /* thrown within dirA +- spread / 2, falls, and cools from white to red. */
    /* bt is the time into burst bk; amount thins the sparks out. */
    'vec3 sparkBurst(vec2 p, float bt, float bk, float dirA, float spread, float speed, float amount) {',
    '  vec3 c = vec3(0.);',
    '  for (int i = 0; i < 14; i++) {',
    '    float fi = float(i);',
    '    float life = .5 + .6 * hash(vec2(fi, bk + 2.2));',
    '    float age = bt - hash(vec2(bk + fi * 1.7, 21.)) * .7;',
    '    if (hash(vec2(fi, bk + 6.6)) < amount && age > 0. && age < life) {',
    '      float a = dirA + (hash(vec2(fi, bk + 4.3)) - .5) * spread;',
    '      vec2 v = vec2(cos(a), sin(a)) * speed * (.4 + .75 * hash(vec2(fi, bk + 9.1)));',
    '      vec2 g = vec2(0., .65);',
    '      vec2 pos = v * age + .5 * g * age * age;',
    '      vec2 tail = pos - (v + g * age) * .06;',
    '      vec2 pa = p - tail; vec2 ba = pos - tail;',
    '      float k = clamp(dot(pa, ba) / max(dot(ba, ba), .000001), 0., 1.);',
    '      vec2 q = pa - ba * k; float r2 = dot(q, q);',
    '      float heat = 1. - age / life;',
    '      float b = (exp(-r2 / .00002) + .3 * exp(-r2 / .0002)) * (.25 + .75 * k) * heat * (.75 + .25 * sin(age * 50. + fi * 7.));',
    '      c += mix(vec3(.85, .16, .02), mix(vec3(1., .55, .1), vec3(1., .96, .78), smoothstep(.6, .95, heat)), smoothstep(.1, .5, heat)) * b;',
    '    }',
    '  }',
    '  return c;',
    '}',
    /* A welding arc at p for the first .8 s of a burst, flickering, then the */
    /* weld left glowing orange as it cools. */
    'vec3 weldArc(vec2 p, float bt, float t, float size) {',
    '  float r2 = dot(p, p) / size;',
    '  float arc = (1. - smoothstep(.75, .9, bt)) * (.55 + .45 * hash(vec2(floor(t * 40.), size * 7.)));',
    '  float cool = smoothstep(.1, .5, bt) * exp(-max(bt - .8, 0.) * 2.);',
    '  return vec3(1., .92, .72) * (exp(-r2 / .0003) * 1.4 + exp(-r2 / .005) * .3) * arc + vec3(1., .38, .06) * exp(-r2 / .0004) * cool * .8;',
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

    /* Blood drain, overgrowth, time, rain: how they bend the art. */
    '  float drop = 0.; float tr = 0.; float edgeDist = min(min(ap.x, 1. - ap.x) * 1.3, 1. - ap.y);',
    /* Overgrowth: the art near the vines sways with them. */
    '  if (fx == 22) {',
    '    suv.x += sin(t * 1.2 + ap.y * 7.) * .0025 * s * m * (1. - smoothstep(0., .35, edgeDist));',
    '  }',
    /* Time ripple: rings run out from the focus, now forward, now back. */
    '  if (fx == 23) {',
    '    vec2 d = round2(uv - u_focus); tr = length(d);',
    '    float dirT = sin(t * .45) > 0. ? 1. : -1.;',
    '    suv = uv - (d / max(tr, .0001)) / vec2(u_aspect, 1.) * sin(tr * 48. - t * 2.4 * dirT) * .0035 * s * m * exp(-tr * 2.5);',
    '  }',
    /* Rain: drops sit on the glass, bend the art behind them and fade. */
    '  if (fx == 24) {',
    '    vec2 q = ap * vec2(16., 9.); vec2 c = floor(q); vec2 f = fract(q) - .5;',
    '    float h = hash(c + 21.);',
    '    float life = fract(t * .22 + h * 7.);',
    '    drop = step(.72, h) * (1. - smoothstep(.16, .24, length(f * vec2(1., 1.25)))) * (1. - life);',
    '    suv = uv - f * drop * .012 * s * m;',
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
    /* Blood drain: crimson veins creep in from the edges, colour drains to red on */
    /* a slow pulse, and drips run down from the top of the art. */
    '  if (fx == 21) {',
    '    float pulse = .5 + .5 * sin(t * 1.3);',
    '    float edge = smoothstep(.55, 1.25, length((ap - .5) * 2.));',
    '    float vn = 1. - abs(fbm(ap * vec2(5., 4.) + vec2(t * .03, -t * .02)) * 2. - 1.);',
    '    float vein = pow(vn, 14.) * edge * (.6 + .4 * pulse);',
    '    float cx = floor(ap.x * 26.); float hc = hash(vec2(cx, 3.));',
    '    float run = fract(t * (.05 + .07 * hc) + hc);',
    '    float tipY = run * .65;',
    '    float within = abs(fract(ap.x * 26.) - .5);',
    '    float alive = step(.72, hc) * (1. - smoothstep(.85, 1., run));',
    '    float drip = alive * (1. - smoothstep(.1, .28, within)) * (1. - smoothstep(tipY - .02, tipY, ap.y));',
    '    float bead = alive * exp(-pow((ap.y - tipY) / .012, 2.)) * (1. - smoothstep(.15, .45, within));',
    '    vec3 red = vec3(luma(col)) * vec3(1.25, .32, .32);',
    '    col = mix(col, red, clamp((.25 + .25 * pulse) * s, 0., 1.) * (.1 + .9 * edge) * m);',
    '    col = mix(col, vec3(.42, 0., .03), clamp((vein + drip * .9 + bead) * s, 0., 1.) * m);',
    '    add += vec3(1., .2, .2) * bead * .25 * s * m;',
    '    add += vec3(.6, 0., .02) * edge * pulse * .12 * s * m;',
    '  }',
    /* Overgrowth: vines and leaves grow in from the sides and the bottom, reaching */
    /* further and drawing back, with spores drifting up. */
    '  if (fx == 22) {',
    '    float reach = .2 + .07 * sin(t * .35) + .03 * sin(t * 1.1);',
    '    vec2 w = vec2(fbm(ap * 3.2 + vec2(t * .04, 0.)), fbm(ap * 3.2 + vec2(4.3, t * .03))) - .5;',
    '    float front = edgeDist + (fbm(ap * 7. + w * 2.) - .5) * .18;',
    '    float grow = 1. - smoothstep(reach - .06, reach + .02, front);',
    '    float strand = pow(1. - abs(noise(ap * vec2(14., 10.) + w * 4.) * 2. - 1.), 9.);',
    '    float strand2 = pow(1. - abs(noise(ap * vec2(25., 19.) - w * 3. + 7.) * 2. - 1.), 12.);',
    '    vec2 lq = ap * vec2(16., 12.) + w * 2.;',
    '    vec2 lc = floor(lq); vec2 lf = fract(lq) - .5;',
    '    float lh = hash(lc + 11.);',
    '    float la = lh * 6.2832 + sin(t * 1.2 + lh * 9.) * .25;',
    '    vec2 lr = vec2(cos(la) * lf.x + sin(la) * lf.y, -sin(la) * lf.x + cos(la) * lf.y);',
    '    float leaf = step(.55, lh) * (1. - smoothstep(.85, 1., length(lr * vec2(2.6, 5.2))));',
    '    float vine = clamp((strand + .6 * strand2) * 1.4 + leaf, 0., 1.) * grow;',
    '    vec3 green = mix(vec3(.07, .26, .05), vec3(.36, .66, .2), clamp(strand2 + leaf * .6 + lr.x, 0., 1.));',
    '    col = mix(col, col * vec3(.88, 1.06, .85), .3 * clamp(s, 0., 1.) * m);',
    '    col = mix(col, green, clamp(vine * s, 0., 1.) * m);',
    '    add += vec3(.85, 1., .5) * particles(vec2(ap.x * 1.4, ap.y), 14., vec2(.08 * sin(t * .5), -.18), .12, t) * .5 * s * m;',
    '  }',
    /* Time ripple: a clock dial round the focus with its hand sweeping a trail of */
    /* light, faint ripples, and the art aged towards sepia. */
    '  if (fx == 23) {',
    '    vec2 d = round2(uv - u_focus);',
    '    float a = atan(d.y, d.x);',
    '    float behind = mod(a - t * .9, 6.2832);',
    '    float sweep = exp(-behind * 1.6) * (1. - smoothstep(.145, .165, tr)) * (.4 + .6 * smoothstep(0., .15, tr));',
    '    float dial = exp(-pow((tr - .16) / .006, 2.));',
    '    float ticks = smoothstep(.94, .99, cos(a * 12.)) * exp(-pow((tr - .16) / .016, 2.));',
    '    float ripple = .5 + .5 * sin(tr * 48. - t * 2.4);',
    '    col = mix(col, vec3(luma(col)) * vec3(1.12, .96, .72), .35 * clamp(s, 0., 1.) * m);',
    '    add += vec3(1., .85, .5) * (sweep * .45 + dial * .5 + ticks * .7) * s * m;',
    '    add += vec3(1., .9, .65) * ripple * exp(-tr * 4.) * .08 * s * m;',
    '  }',
    /* Rain: three depths of streaks slanting down, a cool wet tint, and the drops */
    /* on the glass catching the light. */
    '  if (fx == 24) {',
    '    vec2 rp2 = vec2(ap.x * 1.4 + ap.y * .22, ap.y);',
    '    float streak = 0.;',
    '    for (int k = 0; k < 3; k++) {',
    '      float fk = float(k);',
    '      vec2 q = rp2 * vec2(38. + fk * 22., 5. + fk * 2.) + vec2(fk * 3.7, -t * (2.4 + fk * .7));',
    '      vec2 c = floor(q); vec2 f = fract(q);',
    '      float h = hash(c + fk * 5.);',
    '      streak += step(.8, h) * (1. - smoothstep(0., .09, abs(f.x - .5))) * smoothstep(0., .6, f.y) * (1. - smoothstep(.65, 1., f.y)) * (.45 + .25 * fk);',
    '    }',
    '    col = mix(col, col * vec3(.78, .86, .98), .45 * clamp(s, 0., 1.) * m);',
    '    add += vec3(.75, .85, 1.) * min(streak, 1.) * .55 * s * m;',
    '    add += vec3(.8, .9, 1.) * drop * .22 * s * m;',
    '  }',
    /* Mana orbit: the five colours of mana circle the focus, dimmer as they pass */
    /* behind it, each trailing light. */
    '  if (fx == 25) {',
    '    vec2 d0 = round2(uv - u_focus);',
    '    for (int k = 0; k < 5; k++) {',
    '      float a = t * .55 + float(k) * 1.2566;',
    '      float depth = .55 + .45 * sin(a);',
    '      vec3 mc = manaColor(k);',
    '      vec2 d = d0 - vec2(cos(a) * .2, sin(a) * .07);',
    '      float r2 = dot(d, d);',
    '      add += mc * (exp(-r2 / .0011) * .95 + exp(-r2 / .009) * .35) * depth * s * m;',
    '      for (int j = 1; j < 4; j++) {',
    '        float b = a - float(j) * .09;',
    '        vec2 e = d0 - vec2(cos(b) * .2, sin(b) * .07);',
    '        add += mc * exp(-dot(e, e) / (.0008 + float(j) * .0003)) * (.3 - float(j) * .07) * depth * s * m;',
    '      }',
    '    }',
    '  }',
    /* Cosmic: a nebula drifts through the dark parts of the art, stars twinkle, */
    /* and now and then one shoots across. */
    '  if (fx == 26) {',
    '    float dark = 1. - smoothstep(.15, .55, lum0);',
    '    vec2 np = ap * 2.5 + vec2(t * .015, -t * .01);',
    '    float neb = fbm(np + fbm(np * 1.7 + t * .02));',
    '    vec3 nc = mix(vec3(.3, .1, .6), vec3(.1, .45, .85), smoothstep(.3, .7, fbm(np * .8 + 3.)));',
    '    add += nc * smoothstep(.35, .8, neb) * dark * .5 * s * m;',
    '    vec2 sp = vec2(ap.x * 1.4, ap.y);',
    '    float stars = particles(sp, 30., vec2(0.), .07, t) + particles(sp + 9.1, 55., vec2(0.), .05, t * 1.3);',
    '    add += vec3(.9, .95, 1.) * stars * (.6 + .6 * dark) * 1.4 * s * m;',
    '    float k = floor(t / 3.5); float pt = t - k * 3.5;',
    '    vec2 dir = normalize(vec2(1., .45));',
    '    vec2 head = vec2(hash(vec2(k, 1.)) * .8 - .3, hash(vec2(k, 2.)) * .45) + dir * pt * 1.1;',
    '    vec2 rel = vec2(ap.x * 1.4, ap.y) - vec2(head.x * 1.4, head.y);',
    '    float along = dot(rel, dir); float across = dot(rel, vec2(-dir.y, dir.x));',
    '    float shoot = step(along, 0.) * exp(along * 12.) * exp(-pow(across / .004, 2.)) * step(pt, .7) * step(.35, hash(vec2(k, 5.)));',
    '    add += vec3(1.) * shoot * s * m;',
    '  }',
    /* Treasure: a warm gold cast, star glints on the bright parts, and coins */
    /* spinning as they fall. */
    '  if (fx == 27) {',
    '    float bright = smoothstep(.4, .85, lum0);',
    '    col = mix(col, col * vec3(1.12, 1., .72), .35 * clamp(s, 0., 1.) * m);',
    '    vec2 q = vec2(ap.x * 1.4, ap.y) * 11.; vec2 c = floor(q); vec2 f = fract(q) - .5;',
    '    float h = hash(c + 31.);',
    '    float tw = pow(max(0., sin(t * (1.5 + h * 2.) + h * 40.)), 12.);',
    '    float flare = exp(-abs(f.x) * 60.) * exp(-abs(f.y) * 8.) + exp(-abs(f.y) * 60.) * exp(-abs(f.x) * 8.);',
    '    float glint = step(.6, h) * tw * (flare * .8 + exp(-dot(f, f) * 80.));',
    '    add += vec3(1., .85, .45) * glint * (.35 + .65 * bright) * 1.3 * s * m;',
    '    vec2 cq = vec2(ap.x * 1.4, ap.y) * 5. - vec2(0., t * .6);',
    '    vec2 cc = floor(cq); vec2 cf = fract(cq) - .5;',
    '    float ch = hash(cc + 17.);',
    '    float spin = abs(cos(t * 3. + ch * 20.));',
    '    float coin = step(.84, ch) * (1. - smoothstep(.19, .22, length(cf / vec2(max(spin, .12), 1.))));',
    '    vec3 gold = mix(vec3(.62, .4, .08), vec3(1., .88, .45), spin);',
    '    col = mix(col, gold, clamp(coin * s, 0., 1.) * .9 * m);',
    '  }',
    /* Clockwork: brass and copper gears mesh and turn in the corners of the */
    /* art, grinding out sparks where they meet; a welding arc at the focus and */
    /* two more wandering over the art throw fountains of sparks. */
    '  if (fx == 28) {',
    '    vec2 gp = round2(uv);',
    '    float w = t * .35;',
    '    float r1 = .11; float n1 = 16.; float n2 = 10.; float r2 = r1 * n2 / n1;',
    '    float th = -.12;',
    '    float a1 = w; float a2 = -w * n1 / n2 - th * n1 / n2 - th - 3.1416; float a3 = -w * 1.3 + 1.;',
    '    vec2 c1 = round2(vec2(u_art.x, u_art.w)) + vec2(.01, -.01);',
    '    vec2 c2 = c1 + vec2(cos(th), sin(th)) * (r1 + r2);',
    '    vec2 c3 = round2(vec2(u_art.z, u_art.y)) + vec2(-.005, .01);',
    '    vec2 g1 = gear(gp, c1, r1, n1, a1);',
    '    vec2 g2 = gear(gp, c2, r2, n2, a2);',
    '    vec2 g3 = gear(gp, c3, .085, 13., a3);',
    '    float cov = clamp(g1.x + g2.x + g3.x, 0., 1.);',
    '    float ga = .95 * clamp(s, 0., 1.) * m;',
    /* A drop shadow: the same gears a little down and right, darkening the art. */
    '    vec2 so = vec2(-.008, -.011);',
    '    float shadow = clamp(gear(gp + so, c1, r1, n1, a1).x + gear(gp + so, c2, r2, n2, a2).x + gear(gp + so, c3, .085, 13., a3).x, 0., 1.);',
    '    col *= 1. - shadow * (1. - cov) * .55 * clamp(s, 0., 1.) * m;',
    '    vec3 brassLo = vec3(.2, .12, .035); vec3 brassHi = vec3(1., .82, .46);',
    '    col = mix(col, metal(g1.y, brassLo, brassHi), g1.x * ga);',
    '    col = mix(col, metal(g2.y * .95, brassLo, brassHi), g2.x * ga);',
    '    col = mix(col, metal(g3.y, vec3(.22, .08, .04), vec3(1., .66, .48)), g3.x * ga);',
    '    vec3 spk = vec3(0.);',
    /* The weld at the focus. */
    '    float bk = floor(t / 2.8); float bt = t - bk * 2.8;',
    '    vec2 fd = round2(uv - u_focus);',
    '    spk += weldArc(fd, bt, t, 1.) + sparkBurst(fd, bt, bk, -1.5708, 3.4, .5, 1.);',
    /* Two more welds, each somewhere new on every burst. */
    '    for (int j = 0; j < 2; j++) {',
    '      float fj = float(j);',
    '      float per = 3.3 + fj * .8; float tj = t + 1.1 + fj * 1.9;',
    '      float wk = floor(tj / per); float wt = tj - wk * per; wk += 100. + fj * 50.;',
    '      vec2 wp = mix(u_art.xy, u_art.zw, vec2(.12 + .76 * hash(vec2(wk, 31.)), .1 + .6 * hash(vec2(wk, 37.))));',
    '      vec2 wd = round2(uv - wp);',
    '      spk += weldArc(wd, wt, t, .5) + sparkBurst(wd, wt, wk, -1.5708 + (hash(vec2(wk, 3.)) - .5) * 1.2, 2.6, .38, .75);',
    '    }',
    /* Grinding where the bottom gears mesh: sparks thrown up along the teeth. */
    '    float gk = floor(t / 1.9); float gt = t - gk * 1.9;',
    '    vec2 cd = gp - (c1 + vec2(cos(th), sin(th)) * r1);',
    '    spk += sparkBurst(cd, gt, gk + 300., atan(-cos(th), sin(th)), .8, .6, .65);',
    '    spk += vec3(1., .6, .2) * exp(-dot(cd, cd) / .0004) * (.4 + .3 * hash(vec2(floor(t * 25.), 5.)));',
    /* Sparks darken what is under them a little, so they read on bright art too. */
    '    col *= 1. - clamp(luma(spk), 0., 1.) * .35 * s * m;',
    '    add += min(spk * 1.6, vec3(2.)) * s * m;',
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
