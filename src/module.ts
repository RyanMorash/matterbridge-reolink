/**
 * @file src/module.ts
 * @description Matterbridge platform for Reolink cameras and doorbells.
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

import path from 'node:path';

import { ReolinkBaichuanApi } from '@apocaliss92/nodelink-js';
import { MatterbridgeDynamicPlatform, type PlatformMatterbridge } from 'matterbridge';
import type { AnsiLogger, LogLevel } from 'matterbridge/logger';

import { normalizeConfig, type NormalizedConfig, type ReolinkPlatformConfig } from './config.js';
import { type HostContext, HostSession } from './hostSession.js';
import { createReolinkLogger, errorText } from './logger.js';
import { loadOrCreatePushCredentials } from './pushCredentials.js';
import { PushService } from './pushService.js';

export type { ReolinkPlatformConfig } from './config.js';

/**
 * Create the Reolink platform.
 *
 * @param {PlatformMatterbridge} matterbridge Matterbridge host
 * @param {AnsiLogger} log Platform logger
 * @param {ReolinkPlatformConfig} config Plugin configuration
 * @returns {ReolinkPlatform} Platform instance
 */
export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: ReolinkPlatformConfig): ReolinkPlatform {
  return new ReolinkPlatform(matterbridge, log, config);
}

/**
 * Dynamic platform that exposes Reolink cameras, doorbells, and NVR channels.
 */
export class ReolinkPlatform extends MatterbridgeDynamicPlatform {
  private readonly sessions: HostSession[] = [];
  private push: PushService | undefined;
  private emailUsername: string | undefined;
  private emailPassword: string | undefined;

  /**
   * Verify the Matterbridge version and store the platform dependencies.
   *
   * @param {PlatformMatterbridge} matterbridge Matterbridge host
   * @param {AnsiLogger} log Platform logger
   * @param {ReolinkPlatformConfig} config Plugin configuration
   * @throws {Error} When Matterbridge is older than 3.11.0
   */
  constructor(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: ReolinkPlatformConfig) {
    super(matterbridge, log, config);
    if (!this.verifyMatterbridgeVersion('3.11.0')) {
      throw new Error(
        `This plugin requires Matterbridge version >= "3.11.0". Please update Matterbridge from ${this.matterbridge.matterbridgeVersion} to the latest version in the frontend.`,
      );
    }
    this.log.info(`Initializing platform ${this.config.name}...`);
  }

  /**
   * Log in to each configured host and register its devices.
   *
   * @param {string | undefined} reason Start reason supplied by Matterbridge
   * @returns {Promise<void>} Resolves when every host has been started or skipped
   */
  override async onStart(reason?: string): Promise<void> {
    this.log.info(`Starting platform ${this.config.name} with reason: ${reason ?? 'no reason provided'}...`);
    await this.ready;
    await this.clearSelect();
    const settings = normalizeConfig(this.config);
    for (const warning of settings.warnings) this.log.warn(warning);
    if (settings.configurePush && settings.push === 'none') this.log.warn('configurePush is enabled but push is none, so camera push settings were not changed');
    await this.startPush(settings);
    const seen = new Set<string>();
    for (const device of settings.devices) {
      const key = `${device.host.toLowerCase()}:${device.port}`;
      if (seen.has(key)) {
        this.log.warn(`Skipped duplicate host ${device.host}`);
        continue;
      }
      seen.add(key);
      const api = new ReolinkBaichuanApi({
        host: device.host,
        port: device.port,
        username: device.username,
        password: device.password,
        logger: createReolinkLogger(this.log),
        ...(device.uid === undefined ? {} : { uid: device.uid }),
        ...(device.transport === undefined ? {} : { transport: device.transport }),
      });
      const session = new HostSession(device, this.hostContext(settings), api);
      this.sessions.push(session);
      await session.start();
    }
    this.log.info(`Platform ${this.config.name} started`);
  }

  /**
   * Refresh battery attributes after Matterbridge restores persisted state.
   *
   * @returns {Promise<void>} Resolves when every battery read has been attempted
   */
  override async onConfigure(): Promise<void> {
    await super.onConfigure();
    this.log.info(`Configuring platform ${this.config.name}...`);
    for (const session of this.sessions) await session.refreshBatteries();
    this.log.info(`Platform ${this.config.name} configured`);
  }

  /**
   * Record a logger level change. Nodelink logs follow the same platform logger.
   *
   * @param {LogLevel} logLevel New logger level
   * @returns {Promise<void>} Resolves immediately
   */
  override async onChangeLoggerLevel(logLevel: LogLevel): Promise<void> {
    this.log.info(`onChangeLoggerLevel called with: ${logLevel}`);
    await Promise.resolve();
  }

  /**
   * Close cameras and push intakes.
   *
   * @param {string | undefined} reason Shutdown reason supplied by Matterbridge
   * @returns {Promise<void>} Resolves when cleanup has been attempted
   */
  override async onShutdown(reason?: string): Promise<void> {
    await super.onShutdown(reason);
    this.log.info(`Shutting down platform ${this.config.name} with reason: ${reason ?? 'no reason provided'}...`);
    for (const session of this.sessions) await session.shutdown();
    this.sessions.length = 0;
    if (this.push !== undefined) {
      await this.push.stop();
      this.push = undefined;
    }
    if (this.config.unregisterOnShutdown) await this.unregisterAllDevices();
    this.log.info(`Platform ${this.config.name} shut down`);
  }

  /**
   * Start email and webhook intakes when the config asks for them.
   *
   * @param {NormalizedConfig} settings Normalized settings
   * @returns {Promise<void>} Resolves when the intakes have started or been skipped
   */
  private async startPush(settings: NormalizedConfig): Promise<void> {
    if (settings.push === 'none') return;
    if (settings.push === 'email' || settings.push === 'both') {
      try {
        const filePath = path.join(this.matterbridge.matterbridgeDirectory, 'matterbridge-reolink-email-push.json');
        const credentials = await loadOrCreatePushCredentials(filePath);
        this.emailUsername = credentials.username;
        this.emailPassword = credentials.password;
        if (credentials.created) this.log.info(`Created email push credentials in ${filePath}`);
      } catch (error) {
        this.log.error(`Email push credentials failed: ${errorText(error)}`);
        if (settings.push === 'email') return;
      }
    }
    const ipv4Address = this.matterbridge.systemInformation.ipv4Address;
    if (settings.configurePush && ipv4Address === undefined) this.log.warn('configurePush was skipped because the bridge IPv4 address is unknown');
    this.push = new PushService({
      mode: settings.push,
      log: this.log,
      emailPort: settings.emailPushPort,
      webhookPort: settings.webhookPort,
      domain: settings.emailPushDomain,
      username: this.emailUsername ?? 'reolink-push',
      password: this.emailPassword ?? 'unused',
      ...(ipv4Address === undefined ? {} : { ipv4Address }),
    });
    await this.push.start();
  }

  /**
   * Build the callbacks shared by every host session.
   *
   * @param {NormalizedConfig} settings Normalized settings
   * @returns {HostContext} Host context
   */
  private hostContext(settings: NormalizedConfig): HostContext {
    const ipv4Address = this.matterbridge.systemInformation.ipv4Address;
    return {
      log: this.log,
      reolinkLogger: createReolinkLogger(this.log),
      vendorId: this.matterbridge.aggregatorVendorId,
      eventHoldSeconds: settings.eventHoldSeconds,
      batteryPollSeconds: settings.batteryPollSeconds,
      restartDelayMs: 250,
      configurePush: settings.configurePush,
      emailPort: settings.emailPushPort,
      domain: settings.emailPushDomain,
      ...(ipv4Address === undefined ? {} : { ipv4Address }),
      ...(this.push === undefined ? {} : { push: this.push }),
      ...(this.emailUsername === undefined || this.emailPassword === undefined ? {} : { pushUsername: this.emailUsername, pushPassword: this.emailPassword }),
      validateDevice: (names) => this.validateDevice(names),
      setSelectDevice: (serial, name) => {
        this.setSelectDevice(serial, name);
      },
      registerDevice: async (device) => {
        await this.registerDevice(device);
      },
    };
  }
}
