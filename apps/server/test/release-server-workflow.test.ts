import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

/**
 * Historia C2 (#77): contrato del workflow que publica las imágenes en GHCR. La
 * prueba de verdad es el primer tag server-v*; esto cuida que nadie lo cambie a
 * `latest`, saque una arquitectura o la attestation sin que se note en un PR.
 */
const ROOT = resolve(__dirname, '../../..');
const wf = parse(readFileSync(resolve(ROOT, '.github/workflows/release-server.yml'), 'utf8'));
const publish = wf.jobs.publish;
const step = (uses: string) => publish.steps.find((s: { uses?: string }) => s.uses?.startsWith(uses));

describe('release-server.yml', () => {
  it('corre sólo con tags server-v*', () => {
    expect(wf.on).toEqual({ push: { tags: ['server-v*'] } });
  });

  it('exige que el tag coincida con la versión de @sdlc/server', () => {
    const check = wf.jobs.version.steps.find((s: { id?: string }) => s.id === 'v');
    expect(check.run).toContain("require('./apps/server/package.json').version");
    expect(check.run).toContain('exit 1');
  });

  it('publica server y diagramas', () => {
    expect(publish.strategy.matrix.include.map((m: { image: string }) => m.image)).toEqual([
      'sdlc-mcp',
      'sdlc-diagrams',
    ]);
  });

  it('tags: la semver y el git-sha, nunca latest', () => {
    const meta = step('docker/metadata-action').with;
    expect(meta.flavor).toBe('latest=false');
    expect(meta.tags).toContain('type=raw,value=${{ needs.version.outputs.version }}');
    expect(meta.tags).toContain('type=sha,format=long,prefix=');
    expect(meta.tags).not.toMatch(/latest/);
  });

  it('amd64 y arm64, con la versión inyectada en la imagen', () => {
    const build = step('docker/build-push-action').with;
    expect(build.platforms).toBe('linux/amd64,linux/arm64');
    expect(build['build-args']).toBe('SDLC_VERSION=${{ needs.version.outputs.version }}');
    expect(build.push).toBe(true);
  });

  it('firma la provenance sobre el digest publicado', () => {
    const attest = step('actions/attest-build-provenance').with;
    expect(attest['subject-digest']).toBe('${{ steps.build.outputs.digest }}');
    expect(attest['push-to-registry']).toBe(true);
    expect(publish.permissions).toMatchObject({ 'id-token': 'write', attestations: 'write', packages: 'write' });
  });

  it('todas las actions están fijadas por sha', () => {
    for (const job of Object.values(wf.jobs) as { steps: { uses?: string }[] }[]) {
      for (const s of job.steps) if (s.uses) expect(s.uses, s.uses).toMatch(/@[0-9a-f]{40}$/);
    }
  });
});
