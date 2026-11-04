import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GitHubRepoDocStoreAdapter } from '../src/adapters/github-repo-docstore.js';

const mockFetch = vi.fn();
beforeEach(() => {
  mockFetch.mockReset();
  vi.stubGlobal('fetch', mockFetch);
});
afterEach(() => vi.unstubAllGlobals());

function resp(body: unknown, status = 200) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const ctx = { tenantId: 't1', userId: 'alice', roles: [], resolveSecret: async () => '' };
const TOKEN = 'ghp_supersecret_token_value';
const adapter = new GitHubRepoDocStoreAdapter({ token: TOKEN, owner: 'acme', repo: 'fintech' });

const BASE = 'https://api.github.com/repos/acme/fintech/contents';

function putResponse(path: string) {
  return resp({
    content: { path, html_url: `https://github.com/acme/fintech/blob/main/${path}` },
    commit: { sha: 'c0ffee' },
  });
}

describe('GitHubRepoDocStoreAdapter', () => {
  describe('publish', () => {
    it('crea el archivo bajo basePath/folder_path/flow_folder y devuelve el path como id', async () => {
      mockFetch
        .mockResolvedValueOnce(resp({ message: 'Not Found' }, 404)) // no existe todavía
        .mockResolvedValueOnce(putResponse('docs/sdlc/fintech/auth/login/prd.md'));

      const ref = await adapter.publish(
        { title: 'PRD: Login', markdown: '# PRD\n', doc_kind: 'prd', folder_path: ['fintech', 'auth'], flow_folder: 'login' },
        ctx,
      );

      expect(ref).toEqual({
        id: 'docs/sdlc/fintech/auth/login/prd.md',
        url: 'https://github.com/acme/fintech/blob/main/docs/sdlc/fintech/auth/login/prd.md',
        version: 'c0ffee',
      });
      const [getUrl] = mockFetch.mock.calls[0]!;
      expect(getUrl).toBe(`${BASE}/docs/sdlc/fintech/auth/login/prd.md`);
      const [putUrl, putInit] = mockFetch.mock.calls[1]!;
      expect(putUrl).toBe(`${BASE}/docs/sdlc/fintech/auth/login/prd.md`);
      expect(putInit.method).toBe('PUT');
      const body = JSON.parse(putInit.body as string);
      expect(Buffer.from(body.content, 'base64').toString('utf8')).toBe('# PRD\n');
      expect(body.message).toBe('docs(sdlc): PRD: Login');
      expect(body.sha).toBeUndefined();
      expect(body.branch).toBeUndefined();
    });

    it('actualiza un archivo existente pasando su sha', async () => {
      mockFetch
        .mockResolvedValueOnce(resp({ sha: 'old-blob-sha', path: 'docs/sdlc/auth/login/rfc.md' }))
        .mockResolvedValueOnce(putResponse('docs/sdlc/auth/login/rfc.md'));

      await adapter.publish(
        { title: 'RFC', markdown: '# RFC v2', doc_kind: 'rfc', folder_path: ['auth'], flow_folder: 'login' },
        ctx,
      );
      const body = JSON.parse(mockFetch.mock.calls[1]![1].body as string);
      expect(body.sha).toBe('old-blob-sha');
    });

    it('pone los ADR en adr/ con su filename', async () => {
      mockFetch
        .mockResolvedValueOnce(resp({ message: 'Not Found' }, 404))
        .mockResolvedValueOnce(putResponse('docs/sdlc/auth/login/adr/0001-ledger.md'));
      await adapter.publish(
        {
          title: 'Ledger',
          markdown: '# ADR',
          doc_kind: 'adr',
          folder_path: ['auth'],
          flow_folder: 'login',
          adr_filename: '0001-ledger.md',
        },
        ctx,
      );
      expect(mockFetch.mock.calls[1]![0]).toBe(`${BASE}/docs/sdlc/auth/login/adr/0001-ledger.md`);
    });

    it('exige adr_filename para un ADR, sin hacer I/O', async () => {
      await expect(
        adapter.publish({ title: 'x', markdown: '#', doc_kind: 'adr', folder_path: ['a'], flow_folder: 'f' }, ctx),
      ).rejects.toThrow(/adr_filename/);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('sin folder_path publica directo bajo basePath/flow_folder', async () => {
      mockFetch.mockResolvedValueOnce(resp({}, 404)).mockResolvedValueOnce(putResponse('docs/sdlc/login/prd.md'));
      await adapter.publish({ title: 'x', markdown: '#', doc_kind: 'prd', flow_folder: 'login' }, ctx);
      expect(mockFetch.mock.calls[1]![0]).toBe(`${BASE}/docs/sdlc/login/prd.md`);
    });

    it('respeta branch, basePath y apiBaseUrl, y escapa cada segmento', async () => {
      const custom = new GitHubRepoDocStoreAdapter({
        token: TOKEN,
        owner: 'acme',
        repo: 'fintech',
        branch: 'sdlc-docs',
        basePath: '/specs/',
        apiBaseUrl: 'https://ghe.example.org/api/v3/',
      });
      mockFetch.mockResolvedValueOnce(resp({}, 404)).mockResolvedValueOnce(putResponse('specs/x/prd.md'));
      await custom.publish({ title: 'x', markdown: '#', doc_kind: 'prd', folder_path: ['Mi Tribu'], flow_folder: 'a#b' }, ctx);

      expect(mockFetch.mock.calls[0]![0]).toBe(
        'https://ghe.example.org/api/v3/repos/acme/fintech/contents/specs/Mi%20Tribu/a%23b/prd.md?ref=sdlc-docs',
      );
      expect(JSON.parse(mockFetch.mock.calls[1]![1].body as string).branch).toBe('sdlc-docs');
    });

    it('rechaza segmentos que escapan del basePath', async () => {
      await expect(
        adapter.publish({ title: 'x', markdown: '#', doc_kind: 'prd', folder_path: ['..'], flow_folder: 'f' }, ctx),
      ).rejects.toThrow(/segmento/);
      await expect(
        adapter.publish({ title: 'x', markdown: '#', doc_kind: 'prd', folder_path: ['a/b'], flow_folder: 'f' }, ctx),
      ).rejects.toThrow(/segmento/);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('un error de auth no filtra el token', async () => {
      mockFetch.mockResolvedValueOnce(resp({ message: 'Bad credentials' }, 401));
      const err = await adapter
        .publish({ title: 'x', markdown: '#', doc_kind: 'prd', folder_path: ['a'], flow_folder: 'f' }, ctx)
        .catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/auth failed \(HTTP 401\)/);
      expect((err as Error).message).not.toContain(TOKEN);
    });

    it('un 409 (sha desactualizado) se reporta como conflicto', async () => {
      mockFetch.mockResolvedValueOnce(resp({ sha: 's1' })).mockResolvedValueOnce(resp({ message: 'conflict' }, 409));
      await expect(
        adapter.publish({ title: 'x', markdown: '#', doc_kind: 'prd', folder_path: ['a'], flow_folder: 'f' }, ctx),
      ).rejects.toThrow(/409/);
    });
  });

  describe('fetch', () => {
    it('baja los bytes crudos del archivo en la rama configurada', async () => {
      mockFetch.mockResolvedValueOnce(new Response('# PRD\r\nexacto\n', { status: 200 }));
      const doc = await adapter.fetch('docs/sdlc/auth/login/prd.md', ctx);

      expect(doc).toEqual({ markdown: '# PRD\r\nexacto\n', version: 'docs/sdlc/auth/login/prd.md' });
      const [url, init] = mockFetch.mock.calls[0]!;
      expect(url).toBe(`${BASE}/docs/sdlc/auth/login/prd.md`);
      expect((init.headers as Record<string, string>).Accept).toBe('application/vnd.github.raw+json');
    });

    it('un archivo que ya no existe falla con un mensaje claro', async () => {
      mockFetch.mockResolvedValueOnce(resp({ message: 'Not Found' }, 404));
      await expect(adapter.fetch('docs/sdlc/x/prd.md', ctx)).rejects.toThrow(/no existe.*docs\/sdlc\/x\/prd\.md/);
    });
  });
});
