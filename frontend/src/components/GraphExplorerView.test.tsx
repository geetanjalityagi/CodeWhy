import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GraphExplorerView } from './GraphExplorerView';
import type { Repository, QuestionContext } from '../types';

beforeAll(() => {
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

describe('GraphExplorerView visual refinement', () => {
  const mockRepo: Repository = {
    id: 'urllib3/urllib3',
    name: 'urllib3',
    url: 'https://github.com/urllib3/urllib3',
    counts: { decisions: 12, entities: 8, pull_requests: 4, commits: 20 },
    fixture: false,
  };

  const mockQuestion: QuestionContext = {
    repositoryId: 'urllib3/urllib3',
    question: 'Why was SSL certificate validation enabled by default?',
    response: {
      outcome: 'full',
      answer: 'SSL certificate verification was made mandatory to eliminate MITM vulnerabilities.',
      entity: {
        id: 'file:src/urllib3/util/ssl_.py',
        label: 'ssl_.py',
        type: 'File',
        path: 'src/urllib3/util/ssl_.py',
      },
      confidence: {
        score: 0.94,
        label: 'HIGH',
        signals: {
          directness: 0.9,
          provenance: 1,
          agreement: 0.9,
          relevance: 0.95,
          temporal_consistency: 1,
          contradiction: 0,
        },
      },
      candidates: [],
      decisions: [],
      citations: [],
      evidence_gaps: [],
      who_to_ask: [],
      fixture: false,
    },
  };

  it('loads the repository graph and its controls with no question asked', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ nodes: [], edges: [], truncated: false, fixture: false }),
    });

    render(
      <GraphExplorerView
        selectedRepo={mockRepo}
        questionContext={null}
        onAskQuestion={vi.fn()}
      />
    );
    expect(screen.getByText('Connected Knowledge Graph')).toBeDefined();
    expect(screen.queryByText('Ask a question to explore its graph')).toBeNull();
    expect(screen.getByPlaceholderText('Search entities (e.g. retry, config)...')).toBeDefined();
    expect(screen.getByText('Decisions')).toBeDefined();
    expect(screen.getByText('Pull Requests')).toBeDefined();
  });

  it('renders header, legend and filter controls when question context is provided', () => {
    render(
      <GraphExplorerView
        selectedRepo={mockRepo}
        questionContext={mockQuestion}
        onAskQuestion={vi.fn()}
      />
    );
    expect(screen.getByText('Connected Knowledge Graph')).toBeDefined();
    expect(screen.getByText('GRAPH FOR LATEST QUESTION', { exact: false })).toBeDefined();
    expect(screen.getByText(mockQuestion.question)).toBeDefined();
    expect(screen.getByPlaceholderText('Search entities (e.g. retry, config)...')).toBeDefined();
    expect(screen.getByText('Visual')).toBeDefined();
    expect(screen.getByText('Accessible List')).toBeDefined();
    expect(screen.getByText('Decisions')).toBeDefined();
    expect(screen.getByText('Entities (File/Module/Key)')).toBeDefined();
    expect(screen.getByText('Pull Requests')).toBeDefined();
  });
});
