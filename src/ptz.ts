/**
 * @file src/ptz.ts
 * @description Turn Matter mechanical PTZ targets into Reolink start/stop moves.
 * @author RyanMorash
 * @created 2026-11-19
 * @version 1.0.0
 * @license Apache-2.0
 *
 * Copyright 2026 RyanMorash.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { PtzCommand } from '@apocaliss92/nodelink-js';

/** Mechanical position tracked for one camera. */
export interface PtzPosition {
  /** Pan in degrees. */
  readonly pan: number;
  /** Tilt in degrees. */
  readonly tilt: number;
  /** Zoom factor. */
  readonly zoom: number;
}

/** One Baichuan pan, tilt, or zoom pulse. */
export interface PtzMove {
  /** Reolink direction. */
  readonly command: PtzCommand['command'];
  /** Speed from 1 to 64. */
  readonly speed: number;
  /** Pulse length in milliseconds. */
  readonly autoStopMs: number;
}

/** Default mechanical limits used by the Matter camera cluster. */
export const PTZ_LIMITS = { panMin: -170, panMax: 170, tiltMin: -20, tiltMax: 90, zoomMin: 1, zoomMax: 10 } as const;

/** Position used until the camera reports a move. */
export const PTZ_HOME: PtzPosition = { pan: 0, tilt: 0, zoom: 1 };

/**
 * Clamp a finite number into an inclusive range.
 *
 * @param {number} value Candidate
 * @param {number} min Inclusive lower bound
 * @param {number} max Inclusive upper bound
 * @returns {number} Clamped value
 */
export function clampAxis(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Apply a partial target to the current position and clamp it to the cluster limits.
 *
 * @param {PtzPosition} current Last commanded position
 * @param {Partial<PtzPosition>} target Fields to change
 * @returns {PtzPosition} Next position
 */
export function nextPosition(current: PtzPosition, target: Partial<PtzPosition>): PtzPosition {
  return {
    pan: target.pan === undefined ? current.pan : clampAxis(target.pan, PTZ_LIMITS.panMin, PTZ_LIMITS.panMax),
    tilt: target.tilt === undefined ? current.tilt : clampAxis(target.tilt, PTZ_LIMITS.tiltMin, PTZ_LIMITS.tiltMax),
    zoom: target.zoom === undefined ? current.zoom : clampAxis(target.zoom, PTZ_LIMITS.zoomMin, PTZ_LIMITS.zoomMax),
  };
}

/**
 * Build start/stop pulses that move from the current position toward a target.
 *
 * Baichuan pan and tilt are directions, not degree targets. A larger delta uses a higher speed and a longer pulse.
 *
 * @param {PtzPosition} current Last commanded position
 * @param {Partial<PtzPosition>} target Requested absolute position. Omitted axes are left alone.
 * @returns {{ position: PtzPosition, moves: PtzMove[] }} Clamped position and the pulses to send
 */
export function movesForTarget(current: PtzPosition, target: Partial<PtzPosition>): { position: PtzPosition; moves: PtzMove[] } {
  const position = nextPosition(current, target);
  const moves = [
    moveForDelta('Right', 'Left', position.pan - current.pan, PTZ_LIMITS.panMax - PTZ_LIMITS.panMin, 0.5),
    moveForDelta('Up', 'Down', position.tilt - current.tilt, PTZ_LIMITS.tiltMax - PTZ_LIMITS.tiltMin, 0.5),
    moveForDelta('ZoomIn', 'ZoomOut', position.zoom - current.zoom, PTZ_LIMITS.zoomMax - PTZ_LIMITS.zoomMin, 0.05),
  ].filter((move): move is PtzMove => move !== undefined);
  return { position, moves };
}

/**
 * Convert one axis delta into a timed direction command.
 *
 * @param {PtzCommand['command']} positive Direction used when the delta is positive
 * @param {PtzCommand['command']} negative Direction used when the delta is negative
 * @param {number} delta Target minus current
 * @param {number} span Full travel of the axis, used to scale speed
 * @param {number} threshold Absolute delta that is too small to move
 * @returns {PtzMove | undefined} Pulse, or undefined when the delta is below the threshold
 */
function moveForDelta(positive: PtzCommand['command'], negative: PtzCommand['command'], delta: number, span: number, threshold: number): PtzMove | undefined {
  if (!Number.isFinite(delta) || Math.abs(delta) < threshold) return undefined;
  const speed = Math.round(Math.min(64, Math.max(1, (Math.abs(delta) / span) * 64)));
  const autoStopMs = Math.round(Math.min(2000, Math.max(200, Math.abs(delta) * 20)));
  return { command: delta > 0 ? positive : negative, speed, autoStopMs };
}
