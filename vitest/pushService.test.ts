/**
 * @file vitest/pushService.test.ts
 * @description Tests for the email and webhook intakes.
 * @author RyanMorash
 */

import type { AnsiLogger } from 'matterbridge/logger';

import { PushService } from '../src/pushService.js';

interface FakeServer {
  params: {
    cameraResolver?: (value: string) => string | undefined;
    logger?: { debug?: (message: string) => void; info?: (message: string) => void; warn?: (message: string) => void; error?: (message: string) => void };
  };
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  getCameraWebhookPath?: (cameraId: string) => string;
}

const harness = vi.hoisted(() => {
  const emailServers: FakeServer[] = [];
  const webhookServers: FakeServer[] = [];
  const control = { failEmail: false, failWebhook: false };
  return { emailServers, webhookServers, control };
});

vi.mock('@apocaliss92/nodelink-js', () => ({
  createEmailPushServer: (params: FakeServer['params']): FakeServer => {
    const server: FakeServer = {
      params,
      start: vi.fn(async () => {
        if (harness.control.failEmail) throw new Error('bind');
        params.logger?.debug?.('debug');
        params.logger?.info?.('info');
        params.logger?.warn?.('warn');
        params.logger?.error?.('error');
      }),
      stop: vi.fn(async () => {}),
    };
    harness.emailServers.push(server);
    return server;
  },
  createBaichuanWebhookServer: (params: FakeServer['params']): FakeServer => {
    const server: FakeServer = {
      params,
      start: vi.fn(async () => {
        if (harness.control.failWebhook) throw new Error('port');
      }),
      stop: vi.fn(async () => {}),
      getCameraWebhookPath: (cameraId: string): string => `/webhook/${cameraId}`,
    };
    harness.webhookServers.push(server);
    return server;
  },
}));

function log(): AnsiLogger {
  return { fatal: vi.fn(), error: vi.fn(), warn: vi.fn(), notice: vi.fn(), info: vi.fn(), debug: vi.fn(), log: vi.fn() } as unknown as AnsiLogger;
}

describe('PushService', () => {
  beforeEach(() => {
    harness.emailServers.length = 0;
    harness.webhookServers.length = 0;
    harness.control.failEmail = false;
    harness.control.failWebhook = false;
  });

  it('accepts registered recipients and builds a webhook url', async () => {
    const service = new PushService({
      mode: 'both',
      log: log(),
      emailPort: 2525,
      webhookPort: 9081,
      domain: 'reolink.local',
      username: 'reolink-push',
      password: 'pw',
      ipv4Address: '192.168.1.1',
    });
    await service.start();
    expect(service.emailRunning).toBe(true);
    expect(service.webhookRunning).toBe(true);
    expect(service.resolveEmail('admin')).toBeUndefined();
    expect(service.resolveEmail('cam-porch')).toBeUndefined();
    service.register('porch');
    expect(service.resolveEmail('cam-porch')).toBe('porch');
    expect(harness.emailServers[0]?.params.cameraResolver?.('cam-porch')).toBe('porch');
    expect(harness.webhookServers[0]?.params.cameraResolver?.('porch')).toBe('porch');
    expect(harness.webhookServers[0]?.params.cameraResolver?.('other')).toBeUndefined();
    expect(service.webhookUrl('porch')).toBe('http://192.168.1.1:9081/webhook/porch');
    const webhook = harness.webhookServers[0];
    if (webhook?.getCameraWebhookPath !== undefined) webhook.getCameraWebhookPath = (): string => 'porch';
    expect(service.webhookUrl('porch')).toBe('http://192.168.1.1:9081/porch');
    await service.stop();
    expect(service.emailRunning).toBe(false);
  });

  it('logs start and stop failures and skips a url without an address', async () => {
    const logger = log();
    const email = new PushService({ mode: 'email', log: logger, emailPort: 2525, webhookPort: 9081, domain: 'reolink.local', username: 'reolink-push', password: 'pw' });
    await email.start();
    await email.stop();
    harness.control.failEmail = true;
    const failing = new PushService({
      mode: 'email',
      log: logger,
      emailPort: 2525,
      webhookPort: 9081,
      domain: 'reolink.local',
      username: 'reolink-push',
      password: 'pw',
      ipv4Address: '192.168.1.1',
    });
    await failing.start();
    expect(failing.emailRunning).toBe(false);
    expect(logger.error).toHaveBeenCalledWith('Email push failed to start: bind');
    expect(failing.webhookUrl('porch')).toBeUndefined();

    const webhook = new PushService({ mode: 'webhook', log: logger, emailPort: 2525, webhookPort: 9081, domain: 'reolink.local', username: 'reolink-push', password: 'pw' });
    await webhook.start();
    harness.webhookServers[0]?.stop.mockRejectedValue(new Error('stop'));
    harness.control.failWebhook = true;
    const broken = new PushService({
      mode: 'webhook',
      log: logger,
      emailPort: 2525,
      webhookPort: 9081,
      domain: 'reolink.local',
      username: 'reolink-push',
      password: 'pw',
      ipv4Address: '192.168.1.1',
    });
    await broken.start();
    expect(logger.error).toHaveBeenCalledWith('Email push failed to start: bind');
    expect(logger.error).toHaveBeenCalledWith('Webhook push failed to start: port');
    await webhook.stop();
    expect(logger.warn).toHaveBeenCalledWith('Webhook push failed to stop: stop');
  });
});
