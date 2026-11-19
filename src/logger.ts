/**
 * @file src/logger.ts
 * @description Adapt the Matterbridge logger to nodelink and format errors.
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

import type { Logger } from '@apocaliss92/nodelink-js';
import type { AnsiLogger } from 'matterbridge/logger';

/**
 * Format an unknown thrown value as a single line.
 *
 * @param {unknown} error Caught value
 * @returns {string} Error message, or the string form of the value
 */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error';
}

/**
 * Format logger arguments without dumping objects.
 *
 * Objects are omitted so a library debug dump cannot write credentials into the Matterbridge log.
 *
 * @param {unknown} message First argument
 * @param {unknown[]} rest Remaining arguments
 * @returns {string} Joined text
 */
function formatLog(message: unknown, rest: unknown[]): string {
  const parts: string[] = [];
  for (const part of [message, ...rest]) {
    if (typeof part === 'string' || typeof part === 'number' || typeof part === 'boolean' || typeof part === 'bigint') parts.push(String(part));
    else if (part instanceof Error) parts.push(part.message);
  }
  return parts.join(' ');
}

/**
 * Forward nodelink logs to the platform logger.
 *
 * @param {AnsiLogger} log Platform logger
 * @returns {Logger} Logger accepted by ReolinkBaichuanApi
 */
export function createReolinkLogger(log: AnsiLogger): Logger {
  return {
    log: (message?: unknown, ...rest: unknown[]) => {
      log.info(formatLog(message, rest));
    },
    info: (message?: unknown, ...rest: unknown[]) => {
      log.info(formatLog(message, rest));
    },
    warn: (message?: unknown, ...rest: unknown[]) => {
      log.warn(formatLog(message, rest));
    },
    error: (message?: unknown, ...rest: unknown[]) => {
      log.error(formatLog(message, rest));
    },
    debug: (message?: unknown, ...rest: unknown[]) => {
      log.debug(formatLog(message, rest));
    },
  };
}
