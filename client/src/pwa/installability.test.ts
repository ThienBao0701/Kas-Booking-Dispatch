/**
 * The rule that decides whether Kas can be installed.
 *
 * This is the Phase 6.1 root cause encoded as a test. Kas is documented to be
 * opened at `http://<lan-ip>:3001`, which Chrome and Edge do not treat as a
 * secure context; there is no service worker on such an origin and therefore no
 * install prompt, ever. The product's job is to SAY so rather than render an
 * empty corner and let an operator conclude the feature is broken.
 */
import { describe, expect, it } from 'vitest';
import {
  installBlockMessage,
  installBlockReason,
  type InstallEnvironment,
} from './installability';

const env = (over: Partial<InstallEnvironment> = {}): InstallEnvironment => ({
  isSecureContext: true,
  hasServiceWorker: true,
  isStandalone: false,
  hasPrompt: true,
  ...over,
});

describe('when installation is possible', () => {
  it('permits it on a secure origin once the browser offers a prompt', () => {
    expect(installBlockReason(env())).toBeNull();
  });
});

describe('when it is not', () => {
  it('blames the insecure origin — the real production cause', () => {
    expect(installBlockReason(env({ isSecureContext: false }))).toBe('INSECURE_ORIGIN');
  });

  it('reports the insecure origin rather than the missing worker it causes', () => {
    // On http://<lan-ip> BOTH are false. Reporting "no service worker" would
    // send someone to debug registration, which is a symptom, not the cause.
    const both = env({ isSecureContext: false, hasServiceWorker: false });
    expect(installBlockReason(both)).toBe('INSECURE_ORIGIN');
  });

  it('reports an unsupported browser when the origin is fine', () => {
    expect(installBlockReason(env({ hasServiceWorker: false }))).toBe('NO_SERVICE_WORKER');
  });

  it('reports that no prompt has been offered yet', () => {
    expect(installBlockReason(env({ hasPrompt: false }))).toBe('PROMPT_NOT_OFFERED');
  });

  it('says nothing at all once the app is already installed', () => {
    // An installed window on an insecure origin must not nag about HTTPS.
    const installed = env({ isStandalone: true, isSecureContext: false, hasPrompt: false });
    expect(installBlockReason(installed)).toBe('ALREADY_INSTALLED');
  });
});

describe('what the operator is told', () => {
  it('names https and localhost for an insecure origin', () => {
    const message = installBlockMessage('INSECURE_ORIGIN');
    expect(message).toContain('https');
    expect(message).toContain('localhost');
    // It must state the cause, not merely that something failed.
    expect(message).toContain('không bảo mật');
  });

  it('names the browsers that do support it', () => {
    const message = installBlockMessage('NO_SERVICE_WORKER');
    expect(message).toContain('Chrome');
    expect(message).toContain('Edge');
  });

  it('stays silent for the two states that are not problems', () => {
    // An installed app has nothing to fix, and "not offered yet" is the normal
    // state for the first seconds of every page load.
    expect(installBlockMessage('ALREADY_INSTALLED')).toBeNull();
    expect(installBlockMessage('PROMPT_NOT_OFFERED')).toBeNull();
    expect(installBlockMessage(null)).toBeNull();
  });
});
