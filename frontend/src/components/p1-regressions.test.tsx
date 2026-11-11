import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import fs from 'fs';
import path from 'path';

import { RepositorySelectorModal } from './RepositorySelectorModal';
import { DecisionDrawer } from './DecisionDrawer';
import { RepositoryStatusView } from './RepositoryStatusView';
import { FileDecisionBriefView } from './FileDecisionBriefView';
import type { DecisionDetail, Repository } from '../types';

const fixturesDir = path.resolve(__dirname, '..', '..', 'fixtures', 'recorded');
const repositoriesFixture = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'repositories.json'), 'utf-8'));
const decisionActiveFixture: DecisionDetail = JSON.parse(
  fs.readFileSync(path.join(fixturesDir, 'decision_active_superseding.json'), 'utf-8'),
);

const repoA: Repository = repositoriesFixture.items[0];
const repoB: Repository = repositoriesFixture.items[1];

function createTrigger(): HTMLButtonElement {
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.textContent = 'Open selector';
  document.body.appendChild(trigger);
  trigger.focus();
  return trigger;
}

function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn(writeText) },
    configurable: true,
    writable: true,
  });
}

describe('P1 dialog and feedback regressions', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    stubClipboard(() => Promise.resolve());
  });

  describe('Repository selector dialog', () => {
    it('exposes dialog semantics and closes on Escape', () => {
      const onClose = vi.fn();
      createTrigger();

      render(
        <RepositorySelectorModal
          isOpen
          onClose={onClose}
          repositories={[repoA, repoB]}
          selectedRepo={null}
          onSelectRepo={() => {}}
        />,
      );

      const dialog = screen.getByRole('dialog', { name: /select target repository/i });
      expect(dialog.getAttribute('aria-modal')).toBe('true');

      fireEvent.keyDown(document, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('moves initial focus inside and restores it when the dialog closes', () => {
      const trigger = createTrigger();
      const onClose = vi.fn();

      const { rerender } = render(
        <RepositorySelectorModal
          isOpen
          onClose={onClose}
          repositories={[repoA, repoB]}
          selectedRepo={null}
          onSelectRepo={() => {}}
        />,
      );

      const closeButton = screen.getByRole('button', { name: /close repository selector/i });
      expect(document.activeElement).toBe(closeButton);

      rerender(
        <RepositorySelectorModal
          isOpen={false}
          onClose={onClose}
          repositories={[repoA, repoB]}
          selectedRepo={null}
          onSelectRepo={() => {}}
        />,
      );

      expect(document.activeElement).toBe(trigger);
    });

    it('wraps Tab and Shift+Tab inside the dialog', () => {
      createTrigger();

      render(
        <RepositorySelectorModal
          isOpen
          onClose={() => {}}
          repositories={[repoA]}
          selectedRepo={null}
          onSelectRepo={() => {}}
        />,
      );

      const closeButton = screen.getByRole('button', { name: /close repository selector/i });
      const externalLink = screen.getByRole('link', { name: /open .* on github/i });

      externalLink.focus();
      fireEvent.keyDown(document, { key: 'Tab' });
      expect(document.activeElement).toBe(closeButton);

      closeButton.focus();
      fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
      expect(document.activeElement).toBe(externalLink);
    });

    it('activates a repository row with the keyboard', () => {
      const onSelectRepo = vi.fn();
      const onClose = vi.fn();
      createTrigger();

      render(
        <RepositorySelectorModal
          isOpen
          onClose={onClose}
          repositories={[repoA]}
          selectedRepo={null}
          onSelectRepo={onSelectRepo}
        />,
      );

      const row = screen.getByRole('button', { name: new RegExp(`select repository ${repoA.name}`, 'i') });
      expect(row.getAttribute('tabindex')).toBe('0');
      row.focus();
      fireEvent.keyDown(row, { key: 'Enter' });

      expect(onSelectRepo).toHaveBeenCalledWith(repoA);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  describe('Decision drawer dialog', () => {
    it('exposes dialog semantics, closes on Escape, and restores focus', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(decisionActiveFixture),
      });
      const trigger = createTrigger();
      const onClose = vi.fn();

      const { rerender } = render(
        <DecisionDrawer decisionId={decisionActiveFixture.id} onClose={onClose} />,
      );

      const dialog = screen.getByRole('dialog', { name: new RegExp(`decision ${decisionActiveFixture.id}`, 'i') });
      expect(dialog.getAttribute('aria-modal')).toBe('true');

      await screen.findByText(decisionActiveFixture.summary);

      fireEvent.keyDown(document, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledTimes(1);

      rerender(<DecisionDrawer decisionId={null} onClose={onClose} />);
      expect(document.activeElement).toBe(trigger);
    });

    it('reports a successful copy', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(decisionActiveFixture),
      });
      const clipboardWrite = vi.fn().mockResolvedValue(undefined);
      stubClipboard(clipboardWrite);

      render(<DecisionDrawer decisionId={decisionActiveFixture.id} onClose={() => {}} />);
      await screen.findByText(decisionActiveFixture.summary);

      fireEvent.click(screen.getByRole('button', { name: /copy decision summary/i }));

      await waitFor(() => {
        expect(screen.getByText('Copied')).toBeTruthy();
      });
      expect(clipboardWrite).toHaveBeenCalledWith(expect.stringContaining(decisionActiveFixture.summary));
    });

    it('reports a failed copy instead of claiming success', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(decisionActiveFixture),
      });
      stubClipboard(() => Promise.reject(new Error('Clipboard blocked')));

      render(<DecisionDrawer decisionId={decisionActiveFixture.id} onClose={() => {}} />);
      await screen.findByText(decisionActiveFixture.summary);

      fireEvent.click(screen.getByRole('button', { name: /copy decision summary/i }));

      await waitFor(() => {
        expect(screen.getByText('Copy failed')).toBeTruthy();
      });
      expect(screen.queryByText('Copied')).toBeNull();
    });

    it('gives feedback when a citation is clicked without a receipt panel', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(decisionActiveFixture),
      });

      render(<DecisionDrawer decisionId={decisionActiveFixture.id} onClose={() => {}} />);
      await screen.findByText(decisionActiveFixture.summary);

      const citation = decisionActiveFixture.citations[0];
      fireEvent.click(screen.getByTestId(`decision-citation-${citation.id}`));

      await waitFor(() => {
        expect(screen.getByText(/no citation receipt panel/i)).toBeTruthy();
      });
    });
  });

  describe('Repository status honesty', () => {
    it('says it is checking before the first poll resolves', () => {
      global.fetch = vi.fn().mockImplementation(() => new Promise(() => {}));

      render(<RepositoryStatusView selectedRepo={repoB} />);

      expect(screen.getByText('Checking API…')).toBeTruthy();
      expect(screen.getByText('Awaiting first poll')).toBeTruthy();
      expect(screen.queryByText('Operational')).toBeNull();
      expect(screen.queryByText('Available')).toBeNull();
    });

    it('reports operational, available, and active polling after a successful poll', async () => {
      global.fetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/health/dependencies')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ services: [{ name: 'neo4j', status: 'not configured', detail: 'unset' }], data_source: 'sqlite' }),
          });
        }
        if (url.includes('/api/v1/health')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ status: 'ok', version: '0.1.0', data_source: 'sqlite' }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve(repoB) });
      });

      render(<RepositoryStatusView selectedRepo={repoB} />);

      await waitFor(() => {
        expect(screen.getByText('Operational')).toBeTruthy();
      });
      expect(screen.getByText('Available')).toBeTruthy();
      expect(screen.getByText(/auto-poll active \(30s\)/i)).toBeTruthy();
      expect(screen.getByText(/last successful poll:/i)).toBeTruthy();
    });

    it('reports degraded state without claiming a successful poll', async () => {
      global.fetch = vi.fn().mockImplementation((url: string) => {
        if (url.includes('/health/dependencies')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ services: [], data_source: 'sqlite' }),
          });
        }
        if (url.includes('/api/v1/health')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ status: 'ok', version: '0.1.0', data_source: 'sqlite' }),
          });
        }
        return Promise.reject(new Error('Repository lookup failed'));
      });

      render(<RepositoryStatusView selectedRepo={repoB} />);

      await waitFor(() => {
        expect(screen.getByText('Degraded')).toBeTruthy();
      });
      expect(screen.getByText('No successful poll yet')).toBeTruthy();
      expect(screen.getByText('Unknown')).toBeTruthy();
      expect(screen.getByText(/auto-poll retrying every 30s/i)).toBeTruthy();
      expect(screen.queryByText('Operational')).toBeNull();
    });
  });

  describe('Before You Change file search', () => {
    it('never lets an older search response overwrite a newer one', async () => {
      const pending = new Map<string, (value: unknown) => void>();
      global.fetch = vi.fn().mockImplementation(
        (url: string) =>
          new Promise((resolve) => {
            pending.set(String(url), resolve);
          }),
      );

      render(<FileDecisionBriefView selectedRepo={repoB} />);
      const input = screen.getByRole('searchbox', { name: /search files by name/i });

      fireEvent.change(input, { target: { value: 'old' } });
      await waitFor(() => {
        expect([...pending.keys()].some((url) => url.includes('q=old'))).toBe(true);
      });

      fireEvent.change(input, { target: { value: 'new' } });
      await waitFor(() => {
        expect([...pending.keys()].some((url) => url.includes('q=new'))).toBe(true);
      });

      const newUrl = [...pending.keys()].find((url) => url.includes('q=new'))!;
      pending.get(newUrl)!({
        ok: true,
        json: () =>
          Promise.resolve({
            entities: [
              { id: 'file_new', type: 'File', label: 'new-file.ts', path: 'new-file.ts', decision_count: 0 },
            ],
            query: 'new',
            fixture: false,
          }),
      });

      await waitFor(() => {
        expect(screen.getByText('new-file.ts')).toBeTruthy();
      });

      const oldUrl = [...pending.keys()].find((url) => url.includes('q=old'))!;
      pending.get(oldUrl)!({
        ok: true,
        json: () =>
          Promise.resolve({
            entities: [
              { id: 'file_old', type: 'File', label: 'old-file.ts', path: 'old-file.ts', decision_count: 0 },
            ],
            query: 'old',
            fixture: false,
          }),
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(screen.queryByText('old-file.ts')).toBeNull();
      expect(screen.getByText('new-file.ts')).toBeTruthy();
    });
  });
});

afterEach(() => cleanup());
