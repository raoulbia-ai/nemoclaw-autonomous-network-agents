/**
 * Time-of-day load profile for a typical urban mobile network.
 *
 * Returns a loadFactor in [0, 1] where 1.0 = busy-hour peak.
 * Based on typical 5G RAN diurnal traffic patterns (weekday).
 *
 * Pure function — no side effects, no state.
 */

'use strict';

// [hour (0–24), loadFactor] — piecewise linear
const PROFILE = [
  [0,  0.20],
  [5,  0.18],
  [6,  0.30],
  [8,  0.65],
  [9,  0.82],
  [12, 0.90],
  [13, 0.95],
  [14, 1.00],  // afternoon busy hour
  [17, 0.95],
  [18, 0.98],  // evening peak
  [20, 0.80],
  [22, 0.55],
  [23, 0.35],
  [24, 0.20],
];

/**
 * @param {Date} date
 * @returns {number} loadFactor in [0, 1]
 */
function loadFactor(date) {
  const hour = date.getHours() + date.getMinutes() / 60;
  for (let i = 0; i < PROFILE.length - 1; i++) {
    const [h0, f0] = PROFILE[i];
    const [h1, f1] = PROFILE[i + 1];
    if (hour >= h0 && hour < h1) {
      const t = (hour - h0) / (h1 - h0);
      return f0 + t * (f1 - f0);
    }
  }
  return PROFILE[PROFILE.length - 1][1];
}

module.exports = { loadFactor };
