// node --test examples/02-fintech/scripts/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convert, redact, secretValuesFromEnv } from './transcript-to-md.mjs';

const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ2YXpxdWV6Lm4uZ0BnbWFpbC5jb20ifQ.abcdefghijklmnopqrstuvwxyz012345';

test('redacta tokens de GitHub, JWT, Bearer y private keys', () => {
  const input = [
    'token ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'pat github_pat_11AAAAAAA0abcdefghijklmnopqrstuvwxyz',
    `jwt ${JWT}`,
    'Authorization: Bearer abcdefghijklmnop.qrstuvwxyz',
    '{"private_key": "-----BEGIN PRIVATE KEY-----\\nMIIE\\n-----END PRIVATE KEY-----\\n"}',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----',
  ].join('\n');
  const out = redact(input);
  assert.doesNotMatch(out, /ghp_[A-Za-z0-9]{20}/);
  assert.doesNotMatch(out, /github_pat_1/);
  assert.doesNotMatch(out, /eyJzdWIi/);
  assert.doesNotMatch(out, /abcdefghijklmnop\.qrst/);
  assert.doesNotMatch(out, /MIIE/);
});

test('redacta literalmente los SECRET_* y OAUTH_SIGNING_SECRET del entorno', () => {
  const literals = secretValuesFromEnv({
    SECRET_GITHUB_TOKEN: 'plain-token-without-prefix',
    OAUTH_SIGNING_SECRET: 'super-secret-signing-key',
    SECRET_SHORT: 'x',
    PATH: '/usr/bin',
  });
  assert.deepEqual(literals.sort(), ['plain-token-without-prefix', 'super-secret-signing-key']);
  const out = redact('a plain-token-without-prefix b super-secret-signing-key c /usr/bin', literals);
  assert.equal(out, 'a [REDACTED:secret] b [REDACTED:secret] c /usr/bin');
});

test('no toca texto normal', () => {
  const s = 'flow default:transferencias:alias-cvu, sha256:' + 'a'.repeat(64);
  assert.equal(redact(s), s);
});

test('convert: extrae las tool calls del MCP, marca fallas y guarda prompts', () => {
  const lines = [
    { type: 'user', timestamp: 't0', message: { content: 'arrancá el PRD <system-reminder>ruido</system-reminder>' } },
    {
      type: 'assistant',
      timestamp: 't1',
      message: {
        content: [
          { type: 'text', text: 'Pido mi prompt.' },
          { type: 'tool_use', id: 'a', name: 'mcp__sdlc__get_role_prompt', input: { role: 'product-manager', phase: 'prd-draft' } },
        ],
      },
    },
    {
      type: 'user',
      timestamp: 't2',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'a',
            content: [{ type: 'text', text: JSON.stringify({ ok: true, data: { role: 'product-manager', phase: 'prd-draft', system_prompt: 'x' } }) }],
          },
        ],
      },
    },
    {
      type: 'assistant',
      timestamp: 't3',
      message: { content: [{ type: 'tool_use', id: 'b', name: 'mcp__sdlc__submit_prd', input: { flow_id: 'f', auth: `Bearer ${JWT}` } }] },
    },
    {
      type: 'user',
      timestamp: 't4',
      message: { content: [{ type: 'tool_result', tool_use_id: 'b', content: JSON.stringify({ ok: false, error: 'falta Goals' }) }] },
    },
    {
      type: 'assistant',
      timestamp: 't5',
      message: { content: [{ type: 'tool_use', id: 'c', name: 'Bash', input: { command: 'ls' } }] },
    },
    { type: 'user', timestamp: 't6', message: { content: [{ type: 'tool_result', tool_use_id: 'c', content: 'README.md' }] } },
    { type: 'assistant', isSidechain: true, timestamp: 't7', message: { content: 'subagente: ignorar' } },
  ];
  const { markdown, toolCalls, prompts } = convert(lines, { persona: 'nicolas', sessionId: 's1' });

  assert.deepEqual(
    toolCalls.map((c) => [c.seq, c.tool, c.ok]),
    [
      [1, 'get_role_prompt', true],
      [2, 'submit_prd', false],
    ],
  );
  assert.equal(prompts.length, 1);
  assert.doesNotMatch(JSON.stringify(toolCalls), /eyJzdWIi/);
  assert.match(markdown, /❌ resultado \(falla\)/);
  assert.match(markdown, /🛠 `Bash`/);
  assert.doesNotMatch(markdown, /ruido|subagente/);
});
