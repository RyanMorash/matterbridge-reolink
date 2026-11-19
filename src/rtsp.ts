/**
 * @file src/rtsp.ts
 * @description Read the listen port from a Baichuan RTSP URL.
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

/**
 * Read the TCP port from an RTSP URL.
 *
 * @param {string} url URL returned by BaichuanRtspServer.getRtspUrl
 * @returns {number | undefined} Port from 1 to 65535, when the URL has one
 */
export function rtspPort(url: string): number | undefined {
  try {
    const port = Number(new URL(url).port);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) return port;
  } catch {
    return undefined;
  }
  return undefined;
}
