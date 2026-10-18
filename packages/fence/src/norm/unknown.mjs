// Sentinel for a value the normalizer could not determine. It is a unique
// frozen object, so no parsed input can ever be equal to it by accident.
export const UNKNOWN = Object.freeze({ unknown: true });

export function isUnknown(x) {
  return x === UNKNOWN;
}
