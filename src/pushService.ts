/**
 * @file src/pushService.ts
 * @description Start the optional email and HaCfg webhook intakes.
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

import { createBaichuanWebhookServer, createEmailPushServer, type BaichuanWebhookServerInstance, type EmailPushServerInstance } from '@apocaliss92/nodelink-js';
import type { AnsiLogger } from 'matterbridge/logger';

import type { PushMode } from './config.js';
import { errorText } from './logger.js';

/** Options for the asleep-camera intakes. */
export interface PushServiceOptions {
  /** Which intakes to start. */
  readonly mode: PushMode;
  /** Platform logger. */
  readonly log: AnsiLogger;
  /** SMTP port. */
  readonly emailPort: number;
  /** Webhook port. */
  readonly webhookPort: number;
  /** Virtual mail domain. */
  readonly domain: string;
  /** SMTP username. */
  readonly username: string;
  /** SMTP password. */
  readonly password: string;
  /** Bridge IPv4 address reachable by the cameras. */
  readonly ipv4Address?: string;
}

/**
 * Email and webhook intakes shared by every camera on the bridge.
 */
export class PushService {
  private readonly ids = new Set<string>();
  private email: EmailPushServerInstance | undefined;
  private webhook: BaichuanWebhookServerInstance | undefined;

  /**
   * Create a push service. Call start before cameras subscribe.
   *
   * @param {PushServiceOptions} options Listen ports, credentials, and logger
   */
  constructor(private readonly options: PushServiceOptions) {}

  /**
   * Bind the intakes selected by the config.
   *
   * @returns {Promise<void>} Resolves when every requested server has been started or its failure has been logged
   */
  async start(): Promise<void> {
    if (this.options.mode === 'email' || this.options.mode === 'both') await this.startEmail();
    if (this.options.mode === 'webhook' || this.options.mode === 'both') await this.startWebhook();
  }

  /**
   * Remember a camera id so later messages for it are accepted.
   *
   * @param {string} cameraId Stable id used in the recipient and webhook path
   * @returns {void}
   */
  register(cameraId: string): void {
    this.ids.add(cameraId);
  }

  /**
   * Map an SMTP local part to a registered camera id.
   *
   * @param {string} localPart Recipient local part, including the cam- prefix
   * @returns {string | undefined} Camera id, or undefined when the recipient is unknown
   */
  resolveEmail(localPart: string): string | undefined {
    const prefix = 'cam-';
    if (!localPart.startsWith(prefix)) return undefined;
    const cameraId = localPart.slice(prefix.length);
    return this.ids.has(cameraId) ? cameraId : undefined;
  }

  /**
   * Build the HaCfg URL for a camera.
   *
   * @param {string} cameraId Stable camera id
   * @returns {string | undefined} Absolute URL, when the webhook is running and the bridge has an IPv4 address
   */
  webhookUrl(cameraId: string): string | undefined {
    if (this.webhook === undefined || this.options.ipv4Address === undefined) return undefined;
    const route = this.webhook.getCameraWebhookPath(cameraId);
    const path = route.startsWith('/') ? route : `/${route}`;
    return `http://${this.options.ipv4Address}:${this.options.webhookPort}${path}`;
  }

  /**
   * True when the email intake is listening.
   *
   * @returns {boolean} Whether email push started
   */
  get emailRunning(): boolean {
    return this.email !== undefined;
  }

  /**
   * True when the webhook intake is listening.
   *
   * @returns {boolean} Whether webhook push started
   */
  get webhookRunning(): boolean {
    return this.webhook !== undefined;
  }

  /**
   * Stop both intakes.
   *
   * @returns {Promise<void>} Resolves when both stops have been attempted
   */
  async stop(): Promise<void> {
    await this.stopOne('Email push', this.email);
    await this.stopOne('Webhook push', this.webhook);
    this.email = undefined;
    this.webhook = undefined;
  }

  /**
   * Start the SMTP intake.
   *
   * @returns {Promise<void>} Resolves after start, or after logging a failure
   */
  private async startEmail(): Promise<void> {
    try {
      this.email = createEmailPushServer({
        config: {
          port: this.options.emailPort,
          bindHost: '0.0.0.0',
          domain: this.options.domain,
          requireAuth: true,
          authUsername: this.options.username,
          authPassword: this.options.password,
          tls: false,
          maxMessageBytes: 2_000_000,
        },
        cameraResolver: (localPart) => this.resolveEmail(localPart),
        logger: this.libraryLogger(),
      });
      await this.email.start();
      this.options.log.info(`Email push listening on port ${this.options.emailPort}`);
    } catch (error) {
      this.email = undefined;
      this.options.log.error(`Email push failed to start: ${errorText(error)}`);
    }
  }

  /**
   * Start the HaCfg webhook intake.
   *
   * @returns {Promise<void>} Resolves after start, or after logging a failure
   */
  private async startWebhook(): Promise<void> {
    try {
      this.webhook = createBaichuanWebhookServer({
        config: { port: this.options.webhookPort, bindHost: '0.0.0.0', pathPrefix: '/webhook' },
        cameraResolver: (cameraId) => (this.ids.has(cameraId) ? cameraId : undefined),
        logger: this.libraryLogger(),
      });
      await this.webhook.start();
      this.options.log.info(`Webhook push listening on port ${this.options.webhookPort}`);
    } catch (error) {
      this.webhook = undefined;
      this.options.log.error(`Webhook push failed to start: ${errorText(error)}`);
    }
  }

  /**
   * Stop one intake and log a failure without throwing.
   *
   * @param {string} label Intake name used in the log
   * @param {{ stop: () => Promise<void> } | undefined} server Server to stop
   * @returns {Promise<void>} Resolves when stop has been attempted
   */
  private async stopOne(label: string, server: { stop: () => Promise<void> } | undefined): Promise<void> {
    if (server === undefined) return;
    try {
      await server.stop();
    } catch (error) {
      this.options.log.warn(`${label} failed to stop: ${errorText(error)}`);
    }
  }

  /**
   * Logger adapter for the push servers.
   *
   * @returns {object} Logger with optional level methods
   */
  private libraryLogger(): { debug: (message: string) => void; info: (message: string) => void; warn: (message: string) => void; error: (message: string) => void } {
    return {
      debug: (message) => {
        this.options.log.debug(message);
      },
      info: (message) => {
        this.options.log.info(message);
      },
      warn: (message) => {
        this.options.log.warn(message);
      },
      error: (message) => {
        this.options.log.error(message);
      },
    };
  }
}
