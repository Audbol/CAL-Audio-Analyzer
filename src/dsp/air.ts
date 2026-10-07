/**
 * Sound absorption by air (ISO 9613-1): how much treble the air takes over a distance, from the temperature,
 * relative humidity and air pressure. Over long throws it is several dB at 10 kHz; compensating it shows the
 * loudspeaker's own response rather than the air's.
 */

/** Attenuation in dB per metre at frequency f (Hz). */
export function airAbsorption(f: number, tempC: number, humidity: number, kPa = 101.325): number {
  const T = tempC + 273.15;
  const T0 = 293.15;
  const T01 = 273.16;
  const pr = 101.325;
  const pa = kPa / pr;
  // Molar concentration of water vapour (%) from the relative humidity
  const psat = Math.pow(10, -6.8346 * Math.pow(T01 / T, 1.261) + 4.6151);
  const h = (humidity * psat) / pa;
  // Relaxation frequencies of oxygen and nitrogen
  const frO = pa * (24 + (4.04e4 * h * (0.02 + h)) / (0.391 + h));
  const frN = pa * Math.pow(T / T0, -0.5) * (9 + 280 * h * Math.exp(-4.17 * (Math.pow(T / T0, -1 / 3) - 1)));
  const f2 = f * f;
  return (
    8.686 *
    f2 *
    (1.84e-11 * (1 / pa) * Math.sqrt(T / T0) +
      Math.pow(T / T0, -2.5) * ((0.01275 * Math.exp(-2239.1 / T)) / (frO + f2 / frO) + (0.1068 * Math.exp(-3352 / T)) / (frN + f2 / frN)))
  );
}

/** Air loss (dB, positive) over a distance at each frequency. */
export function airLoss(freqs: ArrayLike<number>, distance: number, tempC: number, humidity: number): Float64Array {
  return Float64Array.from(freqs, (f) => airAbsorption(f, tempC, humidity) * distance);
}
