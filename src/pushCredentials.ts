/**
 * @file src/pushCredentials.ts
 * @description Load or create the SMTP credentials used by email push.
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

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { isValidString } from 'matterbridge/utils';

/** SMTP username and password stored beside the Matterbridge data directory. */
export interface PushCredentials {
  /** AUTH username. */
  readonly username: string;
  /** AUTH password. */
  readonly password: string;
  /** True when this call created the file. */
  readonly created: boolean;
}

/**
 * Read a username and password from parsed JSON.
 *
 * @param {unknown} value Parsed file contents
 * @returns {Pick<PushCredentials, 'username' | 'password'> | undefined} Credentials when both fields are non-empty strings
 */
function readStoredCredentials(value: unknown): Pick<PushCredentials, 'username' | 'password'> | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  if (!Object.hasOwn(value, 'username') || !Object.hasOwn(value, 'password')) return undefined;
  const username = Reflect.get(value, 'username');
  const password = Reflect.get(value, 'password');
  if (!isValidString(username, 1) || !isValidString(password, 1)) return undefined;
  return { username, password };
}

/**
 * Load SMTP credentials, creating them when the file is missing or invalid.
 *
 * The password is not returned to the log by this function. Callers should log the path only.
 *
 * @param {string} filePath Absolute path of the JSON credential file
 * @returns {Promise<PushCredentials>} Stored or newly created credentials
 */
export async function loadOrCreatePushCredentials(filePath: string): Promise<PushCredentials> {
  try {
    const stored = readStoredCredentials(JSON.parse(await readFile(filePath, 'utf8')));
    if (stored !== undefined) return { ...stored, created: false };
  } catch {
    // A missing or unreadable file is created below.
  }
  const credentials = { username: 'reolink-push', password: randomBytes(18).toString('base64url'), created: true };
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify({ username: credentials.username, password: credentials.password }), { mode: 0o600 });
  return credentials;
}
