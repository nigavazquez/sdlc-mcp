import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TenantCtx } from '@sdlc/adapters-contracts';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createHttpRenderer,
  embedMermaidDiagrams,
  type DiagramRenderer,
} from '../src/docs/mermaid.js';

// Historia #55 (épica #54). Seams: `embedMermaidDiagrams` (qué se reemplaza en el markdown),
// `GoogleDriveDocStoreAdapter.publish` (qué se sube a Drive) y `createMmdcRenderer` (cuándo
// hay renderer: `createHttpRenderer` contra un servicio HTTP de prueba). El render real con
// mermaid-cli se prueba en la imagen del servicio de diagramas.

vi.mock('googleapis', () => {
  const files = { list: vi.fn(), create: vi.fn(), update: vi.fn(), get: vi.fn() };
  return {
    google: {
      auth: { GoogleAuth: vi.fn().mockImplementation(() => ({})) },
      drive: vi.fn().mockImplementation(() => ({ files })),
    },
  };
});

import { google } from 'googleapis';
import { GoogleDriveDocStoreAdapter } from '../src/adapters/google-drive-docstore.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
/** Cabecera PNG con el ancho dado (IHDR): alcanza para la guarda de ancho. */
function pngOfWidth(width: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(300, 20);
  return b;
}

const DATA_URI = `data:image/png;base64,${PNG.toString('base64')}`;

const MD = [
  '# RFC',
  '',
  '```mermaid',
  'flowchart LR',
  '  a --> b',
  '```',
  '',
  'Texto en el medio.',
  '',
  '```ts',
  'const x = 1;',
  '```',
  '',
  '```mermaid',
  'sequenceDiagram',
  '  A->>B: hola',
  '```',
  '',
].join('\n');

const okRenderer = (): DiagramRenderer & { calls: string[] } => {
  const calls: string[] = [];
  return { calls, render: async (src) => (calls.push(src), PNG) };
};

describe('embedMermaidDiagrams', () => {
  it('reemplaza cada bloque mermaid por su PNG embebido y deja el resto intacto', async () => {
    const r = okRenderer();
    const out = await embedMermaidDiagrams(MD, r);
    expect(r.calls).toEqual(['flowchart LR\n  a --> b', 'sequenceDiagram\n  A->>B: hola']);
    expect(out.rendered).toBe(2);
    expect(out.failed).toEqual([]);
    expect(out.markdown).toContain(`![Diagrama 1](${DATA_URI})`);
    expect(out.markdown).toContain(`![Diagrama 2](${DATA_URI})`);
    expect(out.markdown).not.toContain('```mermaid');
    expect(out.markdown).toContain('```ts\nconst x = 1;\n```');
    expect(out.markdown).toContain('Texto en el medio.');
  });

  it('si un diagrama falla, deja ese bloque como código y sigue con los demás', async () => {
    let n = 0;
    const flaky: DiagramRenderer = {
      render: async () => {
        n++;
        if (n === 1) throw new Error('sintaxis inválida');
        return PNG;
      },
    };
    const out = await embedMermaidDiagrams(MD, flaky);
    expect(out.rendered).toBe(1);
    expect(out.failed).toEqual([{ index: 1, error: 'sintaxis inválida' }]);
    expect(out.markdown).toContain('```mermaid\nflowchart LR\n  a --> b\n```');
    expect(out.markdown).toContain(`![Diagrama 2](${DATA_URI})`);
  });

  it('un PNG más ancho que la página del Doc no se embebe: queda como código', async () => {
    const out = await embedMermaidDiagrams(MD, { render: async () => pngOfWidth(1568) });
    expect(out.rendered).toBe(0);
    expect(out.failed).toEqual([
      {
        index: 1,
        error: 'el diagrama mide 1568 px y la página 624: simplificalo o hacelo vertical',
      },
      {
        index: 2,
        error: 'el diagrama mide 1568 px y la página 624: simplificalo o hacelo vertical',
      },
    ]);
    expect(out.markdown).toBe(MD);

    const ok = await embedMermaidDiagrams(MD, { render: async () => pngOfWidth(624) });
    expect(ok.rendered).toBe(2);
  });

  it('sin bloques mermaid no llama al renderer y devuelve el mismo texto', async () => {
    const r = okRenderer();
    const md = '# PRD\n\n```ts\nx\n```\n';
    const out = await embedMermaidDiagrams(md, r);
    expect(r.calls).toEqual([]);
    expect(out.markdown).toBe(md);
  });
});

describe('createHttpRenderer', () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((done) => (server ? server.close(() => done()) : done())));

  /** Servicio de diagramas de prueba: responde lo que diga `reply` y guarda lo recibido. */
  async function fakeService(reply: (body: string) => { status: number; body: Buffer | string }) {
    const received: string[] = [];
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = Buffer.concat(chunks).toString('utf8');
      received.push(`${req.method} ${req.url} ${body}`);
      const r = reply(body);
      res.writeHead(r.status).end(r.body);
    });
    await new Promise<void>((done) => server!.listen(0, '127.0.0.1', () => done()));
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}`, received };
  }

  it('sin DIAGRAMS_URL no hay renderer', () => {
    expect(createHttpRenderer({ url: '' })).toBeNull();
  });

  it('manda el fuente a /render y devuelve el PNG', async () => {
    const svc = await fakeService(() => ({ status: 200, body: PNG }));
    const r = createHttpRenderer({ url: `${svc.url}/` })!;
    expect(await r.render('flowchart LR\n a --> b')).toEqual(PNG);
    expect(svc.received).toEqual(['POST /render flowchart LR\n a --> b']);
  });

  it('un error del servicio o una respuesta que no es PNG se informa como falla', async () => {
    const svc = await fakeService((body) =>
      body === 'mal' ? { status: 422, body: 'Parse error' } : { status: 200, body: 'no soy png' },
    );
    const r = createHttpRenderer({ url: svc.url })!;
    await expect(r.render('mal')).rejects.toThrow('servicio de diagramas: 422 Parse error');
    await expect(r.render('ok')).rejects.toThrow('la respuesta no es un PNG');
  });
});

describe('GoogleDriveDocStoreAdapter.publish con diagramas', () => {
  beforeEach(() => vi.clearAllMocks());
  const ctx: TenantCtx = {
    tenantId: 't1',
    userId: 'u',
    roles: [],
    resolveSecret: async () => {
      throw new Error('not used');
    },
  };

  function adapterWith(renderer?: DiagramRenderer) {
    const driveApi = google.drive({ version: 'v3', auth: {} as never });
    (driveApi.files.list as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { files: [] } });
    let seq = 0;
    (driveApi.files.create as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      seq++;
      return { data: { id: `id-${seq}`, webViewLink: `https://drive.google.com/file/id-${seq}` } };
    });
    const adapter = new GoogleDriveDocStoreAdapter({
      credentialsJson: JSON.stringify({ type: 'service_account' }),
      location: { sharedDriveId: 'DRIVE' },
      ...(renderer ? { diagramRenderer: renderer } : {}),
    });
    (adapter as unknown as { drive: unknown }).drive = driveApi;
    return { adapter, driveApi };
  }

  const bodies = async (driveApi: ReturnType<typeof google.drive>) => {
    const calls = (driveApi.files.create as ReturnType<typeof vi.fn>).mock.calls as Array<
      [{ requestBody?: { name?: string }; media?: { body: unknown } }]
    >;
    const read = async (name: string) => {
      const body = calls.find((c) => c[0].requestBody?.name === name)?.[0].media?.body;
      if (typeof body === 'string') return body;
      const chunks: Buffer[] = [];
      for await (const ch of body as AsyncIterable<Buffer | string>) chunks.push(Buffer.from(ch));
      return Buffer.concat(chunks).toString('utf8');
    };
    return { md: await read('rfc.md'), doc: await read('rfc') };
  };

  const input = {
    title: 'RFC: X',
    markdown: MD,
    doc_kind: 'rfc' as const,
    flow_folder: 'f',
    folder_path: ['nigav', 'sdlc-mcp'],
  };

  it('el Google Doc lleva una imagen por bloque y el .md queda igual al original', async () => {
    const { adapter, driveApi } = adapterWith(okRenderer());
    await adapter.publish(input, ctx);
    const { md, doc } = await bodies(driveApi);
    expect(md).toBe(MD);
    expect(doc.match(/!\[Diagrama \d\]\(data:image\/png;base64,/g)).toHaveLength(2);
    expect(doc).not.toContain('```mermaid');
  });

  it('si el renderer falla en todos, publica igual con los bloques como código', async () => {
    const { adapter, driveApi } = adapterWith({
      render: async () => {
        throw new Error('chromium no arrancó');
      },
    });
    await expect(adapter.publish(input, ctx)).resolves.toBeDefined();
    const { doc } = await bodies(driveApi);
    expect(doc).toBe(MD);
  });

  it('sin renderer se publica como siempre', async () => {
    const { adapter, driveApi } = adapterWith();
    await adapter.publish(input, ctx);
    const { md, doc } = await bodies(driveApi);
    expect(md).toBe(MD);
    expect(doc).toBe(MD);
  });
});
