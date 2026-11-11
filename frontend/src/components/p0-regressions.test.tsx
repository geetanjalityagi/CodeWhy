import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import fs from 'fs';
import path from 'path';

import { DecisionHistoryView } from './DecisionHistoryView';
import { IntelligenceWorkspace } from './IntelligenceWorkspace';
import { DecisionDrawer } from './DecisionDrawer';
import { RepositoryStatusView } from './RepositoryStatusView';
import type { Repository, AskResponse } from '../types';

const fixturesDir = path.resolve(__dirname, '..', '..', 'fixtures', 'recorded');
const repositoriesFixture = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'repositories.json'), 'utf-8'));
const decisionsUrllib3Fixture = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'decisions_urllib3.json'), 'utf-8'));
const decisionActiveFixture = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'decision_active_superseding.json'), 'utf-8'));
const refusalUnknownFileFixture: AskResponse = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'ask_refusal_unknown_file.json'), 'utf-8'));

const repoA: Repository = repositoriesFixture.items[0];
const repoB: Repository = repositoriesFixture.items[1];

describe('P0 interaction regressions', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  });

  it('loads the repository decision history when no question was asked', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(decisionsUrllib3Fixture),
    });
    global.fetch = fetchMock;

    render(
      <DecisionHistoryView selectedRepo={repoB} questionContext={null} onAskQuestion={() => {}} />,
    );

    await waitFor(() => {
      expect(screen.getByText(/Make active SSL backend accessible to users/i)).toBeTruthy();
    });

    expect(screen.getByText(/Showing every decision recorded/i)).toBeTruthy();
    expect(screen.queryByText(/Ask a question to inspect decision history/i)).toBeNull();

    const firstUrl = String(fetchMock.mock.calls[0][0]);
    expect(firstUrl).toContain('/repositories/urllib3-urllib3/decisions');
    expect(firstUrl).not.toContain('entity_id');
  });

  it('clears the previous answer when the repository changes', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(refusalUnknownFileFixture),
    });

    const { rerender } = render(
      <IntelligenceWorkspace selectedRepo={repoA} onQuestionAnswered={() => {}} />,
    );

    fireEvent.change(screen.getByPlaceholderText(/Ask why code is like this/i), {
      target: { value: 'Why does this code exist?' },
    });
    fireEvent.click(screen.getByRole('button', { name: /investigate/i }));

    await waitFor(() => {
      expect(screen.getByText(refusalUnknownFileFixture.answer!)).toBeTruthy();
    });

    rerender(<IntelligenceWorkspace selectedRepo={repoB} onQuestionAnswered={() => {}} />);

    await waitFor(() => {
      expect(screen.queryByText(refusalUnknownFileFixture.answer!)).toBeNull();
    });
    expect(screen.getByText('Decision Investigation Console')).toBeTruthy();
  });

  it('drops an answer that resolves after the repository changed', async () => {
    let resolveAsk: ((value: unknown) => void) | null = null;
    global.fetch = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveAsk = resolve;
        }),
    );

    const onQuestionAnswered = vi.fn();
    const { rerender } = render(
      <IntelligenceWorkspace selectedRepo={repoA} onQuestionAnswered={onQuestionAnswered} />,
    );

    fireEvent.change(screen.getByPlaceholderText(/Ask why code is like this/i), {
      target: { value: 'Why does this code exist?' },
    });
    fireEvent.click(screen.getByRole('button', { name: /investigate/i }));

    rerender(<IntelligenceWorkspace selectedRepo={repoB} onQuestionAnswered={onQuestionAnswered} />);
    expect(resolveAsk).not.toBeNull();
    resolveAsk!({
      ok: true,
      json: () => Promise.resolve(refusalUnknownFileFixture),
    });

    await waitFor(() => {
      expect(screen.queryByText(refusalUnknownFileFixture.answer!)).toBeNull();
    });
    expect(onQuestionAnswered).not.toHaveBeenCalled();
    expect(screen.queryByTestId('backend-error-state')).toBeNull();
  });

  it('does not keep the previous decision visible after a failed detail load', async () => {
    let callCount = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(decisionActiveFixture),
        });
      }
      return Promise.resolve({ ok: false, statusText: 'Not Found' });
    });
    global.fetch = fetchMock;

    const { rerender } = render(
      <DecisionDrawer decisionId="dec_first" onClose={() => {}} />,
    );

    await waitFor(() => {
      expect(screen.getByText(decisionActiveFixture.summary)).toBeTruthy();
    });

    rerender(<DecisionDrawer decisionId="dec_second" onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText(/Failed to load decision/i)).toBeTruthy();
    });
    expect(screen.queryByText(decisionActiveFixture.summary)).toBeNull();
    // Two loads only: the parent re-render must not trigger a third fetch.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('re-enables the status refresh button when the repository poll fails', async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/health/dependencies')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ services: [], data_source: 'graph' }),
        });
      }
      if (url.includes('/api/v1/health')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: 'ok', version: '0.1.0', data_source: 'graph' }),
        });
      }
      return Promise.reject(new Error('Repository lookup failed'));
    });

    render(<RepositoryStatusView selectedRepo={repoB} />);

    await waitFor(() => {
      expect(screen.getByText(/Telemetry poll failed/i)).toBeTruthy();
    });

    const pollButton = screen.getByRole('button', { name: /poll now/i }) as HTMLButtonElement;
    expect(pollButton.disabled).toBe(false);

    fireEvent.click(pollButton);

    await waitFor(() => {
      expect((screen.getByRole('button', { name: /poll now/i }) as HTMLButtonElement).disabled).toBe(false);
    });
  });
});
