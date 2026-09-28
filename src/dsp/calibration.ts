import { interpLogF } from './freq';

export interface MicCalibration {
  name: string;
  /** Sensitivity factor line from the file, if present (dB). */
  sensitivity?: number;
  freqs: number[];
  /** Correction in dB: the mic's deviation; the analyzer subtracts it. */
  db: number[];
}

/**
 * Parse common microphone calibration formats (miniDSP / Dayton / REW / FRD):
 * lines of `freq  dB  [phase]`, optional `"Sens Factor =-1.23dB"` header, comments with `*`, `#`, `;` or quotes.
 */
export function parseMicCal(text: string, name = 'Microphone'): MicCalibration {
  const freqs: number[] = [];
  const db: number[] = [];
  let sensitivity: number | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const sens = line.match(/sens(?:itivity)?\s*factor\s*=\s*(-?[\d.]+)/i);
    if (sens) {
      sensitivity = parseFloat(sens[1]);
      continue;
    }
    if (/^[*#;"'a-z]/i.test(line)) continue;
    const parts = line.split(/[\s,;\t]+/).map(Number);
    if (parts.length >= 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1]) && parts[0] > 0) {
      freqs.push(parts[0]);
      db.push(parts[1]);
    }
  }
  if (freqs.length < 2) throw new Error('No calibration data found – expected lines of "frequency dB".');
  const order = freqs.map((_, i) => i).sort((a, b) => freqs[a] - freqs[b]);
  return { name, sensitivity, freqs: order.map((i) => freqs[i]), db: order.map((i) => db[i]) };
}

/** Correction (dB to add to a measurement) at frequency f. */
export function calCorrection(cal: MicCalibration | null | undefined, f: number): number {
  if (!cal) return 0;
  return -interpLogF(cal.freqs, cal.db, f);
}
