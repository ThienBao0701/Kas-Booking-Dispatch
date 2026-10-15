/**
 * The collapsible section, and the statistics panel that consumes 7b.
 *
 * The StatisticsPanel half of this file went with the dashboard charts in
 * 5.2c — the pilot does not use operational statistics.
 *
 * Sections start open on purpose: a detail page that opens half-hidden costs a
 * receptionist a click before they can read, on every guest. Collapsing exists
 * for the long tail, and collapsed content is UNMOUNTED — if it stayed in the
 * DOM the collapse would save nothing and there would be little point to it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Section } from './Section';

beforeEach(() => window.localStorage.clear());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  window.localStorage.clear();
});

/* ================================================================== */
/* Section                                                             */
/* ================================================================== */
describe('Section', () => {
  const mount = () =>
    render(
      <Section id="t" title="Mục thử nghiệm" count={3} testId="s">
        <p>nội dung bên trong</p>
      </Section>,
    );

  it('starts open, so nothing needs a click to be read', () => {
    mount();
    expect(screen.getByText('nội dung bên trong')).toBeInTheDocument();
  });

  it('unmounts its children when collapsed', async () => {
    mount();
    await userEvent.click(screen.getByRole('button', { name: /Mục thử nghiệm/ }));
    expect(screen.queryByText('nội dung bên trong')).toBeNull();
  });

  it('reports its expanded state to assistive tech', async () => {
    mount();
    const toggle = screen.getByRole('button', { name: /Mục thử nghiệm/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('links the toggle to the panel it controls', () => {
    mount();
    const toggle = screen.getByRole('button', { name: /Mục thử nghiệm/ });
    const panel = screen.getByRole('region');
    expect(toggle.getAttribute('aria-controls')).toBe(panel.getAttribute('id'));
  });

  it('shows the count beside the title', () => {
    mount();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('is reachable and operable by keyboard alone', async () => {
    mount();
    await userEvent.tab();
    expect(screen.getByRole('button', { name: /Mục thử nghiệm/ })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(screen.queryByText('nội dung bên trong')).toBeNull();
  });

  it('remembers the collapsed choice for next time', async () => {
    const first = mount();
    await userEvent.click(screen.getByRole('button', { name: /Mục thử nghiệm/ }));
    first.unmount();

    mount();
    expect(screen.queryByText('nội dung bên trong')).toBeNull();
  });

  it('still renders when storage is unavailable', () => {
    // Private mode throws on access. A section that cannot render because a
    // preference could not be read would be a far worse failure.
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    mount();
    expect(screen.getByText('nội dung bên trong')).toBeInTheDocument();
    spy.mockRestore();
  });
});
