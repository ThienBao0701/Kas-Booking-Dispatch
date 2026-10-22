/**
 * THE WORKSPACE USES THE SCREEN. Every page used to sit in a 1024px column
 * (max-w-5xl) whatever the monitor, which left a third of a 1920px screen empty
 * beside tables that then scrolled sideways. The shell now spans the width
 * between the sidebar and the edge, capped only for very wide monitors, and
 * lets a wide table's own scroll box shrink instead of widening the page.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { ADMIN_USER, installApiMock, renderApp } from '../test/utils';

afterEach(() => vi.unstubAllGlobals());

describe('the app workspace', () => {
  it('is not held to a narrow column, and can shrink around a wide table', async () => {
    installApiMock({ 'GET /api/auth/me': () => ({ status: 200, body: { user: ADMIN_USER } }) });
    renderApp('/app/reports');
    const workspace = await screen.findByTestId('app-workspace');
    expect(workspace.className).not.toMatch(/\bmax-w-(5xl|6xl|7xl)\b/);
    expect(workspace.className).toMatch(/\bw-full\b/);
    expect(workspace.className).toMatch(/\bmin-w-0\b/);
    expect(workspace.closest('main')!.className).toMatch(/\bmin-w-0\b/);
  });
});
