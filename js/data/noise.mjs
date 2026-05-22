function hashInteger(value) {
  let x = value | 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x45d9f3b);
  x ^= x >>> 16;
  x = Math.imul(x, 0x45d9f3b);
  x ^= x >>> 16;
  return x >>> 0;
}

function mixHash(seed, x, y) {
  const mixed = hashInteger(seed)
    ^ hashInteger((x << 16) ^ y)
    ^ hashInteger(seed * 0x9e3779b9 + x * 0x85ebca6b + y * 0xc2b2ae35);
  return (hashInteger(mixed) >>> 0) / 4294967296;
}

function fade(t) {
  return t * t * (3 - 2 * t);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function valueNoise2D(x, y, scale, seed = 0) {
  const scaledX = x / scale;
  const scaledY = y / scale;

  const x0 = Math.floor(scaledX);
  const y0 = Math.floor(scaledY);
  const x1 = x0 + 1;
  const y1 = y0 + 1;

  const tx = fade(scaledX - x0);
  const ty = fade(scaledY - y0);

  const v00 = mixHash(seed, x0, y0);
  const v10 = mixHash(seed, x1, y0);
  const v01 = mixHash(seed, x0, y1);
  const v11 = mixHash(seed, x1, y1);

  const i1 = lerp(v00, v10, tx);
  const i2 = lerp(v01, v11, tx);
  return lerp(i1, i2, ty);
}

export function fbmNoise2D(x, y, settings = {}) {
  const {
    seed = 0,
    amplitudes = [0.18, 0.08, 0.03],
    scales = [900, 350, 120],
    extra = [],
  } = settings;

  let total = 0;
  let weightSum = 0;

  for (let index = 0; index < Math.min(amplitudes.length, scales.length); index += 1) {
    const value = valueNoise2D(x, y, scales[index], seed + index * 9973);
    total += (value * 2 - 1) * amplitudes[index];
    weightSum += amplitudes[index];
  }

  for (const layer of extra) {
    const value = valueNoise2D(x, y, layer.scale, seed + layer.scale * 23);
    total += (value * 2 - 1) * layer.amplitude;
    weightSum += layer.amplitude;
  }

  if (weightSum <= 0) return 0;
  return total;
}
