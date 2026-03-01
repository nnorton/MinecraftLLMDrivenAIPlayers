// src/utils/pos.js
// Ensure we always have a real Vec3 (with .floored(), .distanceTo(), etc)

const vec3 = require('vec3');

/**
 * Convert "position-like" values into a Vec3.
 * Supports:
 *   - Vec3 (already)
 *   - {x, y, z}
 *   - {position: {x, y, z}}
 *   - [x, y, z]
 */
function toVec3(pos) {
  if (pos == null) {
    throw new Error(`toVec3: pos is ${pos}`);
  }

  // Already Vec3-like
  if (typeof pos.floored === 'function') return pos;

  // Array form: [x, y, z]
  if (Array.isArray(pos) && pos.length >= 3) {
    const [x, y, z] = pos;
    if ([x, y, z].every(n => typeof n === 'number' && Number.isFinite(n))) {
      return vec3(x, y, z);
    }
  }

  // Object form
  if (typeof pos === 'object') {
    // Some code stores { position: {x,y,z} }
    if (pos.position && typeof pos.position === 'object') pos = pos.position;

    const { x, y, z } = pos;
    if ([x, y, z].every(n => typeof n === 'number' && Number.isFinite(n))) {
      return vec3(x, y, z);
    }
  }

  let preview;
  try { preview = JSON.stringify(pos); } catch { preview = String(pos); }
  throw new Error(`toVec3: unsupported pos type: ${preview}`);
}

/** Drop-in replacement for pos.floored() */
function floored(pos) {
  return toVec3(pos).floored();
}

module.exports = { toVec3, floored };
