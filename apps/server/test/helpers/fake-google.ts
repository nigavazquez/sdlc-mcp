import type { IdentityProvider } from '../../src/oauth/oidc.js';

/**
 * Fake identity provider for OAuth tests.
 * Replaces the old FakeGoogleIdentityProvider; implements the generic IdentityProvider interface.
 *
 * Seeds accept { email, hostedDomain? } for backwards compatibility with existing tests
 * that seeded hostedDomain — but exchangeCode now returns only { email } per the
 * IdentityProvider contract. hostedDomain enforcement is task B2.
 */
export interface FakeIdentity {
  email: string;
  hostedDomain?: string | undefined;
}

export class FakeGoogleIdentityProvider implements IdentityProvider {
  private readonly identities = new Map<string, FakeIdentity>();

  /** Siembra un code falso que canjea a la identidad dada. */
  seed(code: string, identity: FakeIdentity): void {
    this.identities.set(code, identity);
  }

  authUrl(input: { state: string; redirectUri: string }): string {
    const params = new URLSearchParams({
      state: input.state,
      redirect_uri: input.redirectUri,
      client_id: 'fake-client',
      response_type: 'code',
      scope: 'openid email',
    });
    return `https://fake-google.test/auth?${params.toString()}`;
  }

  async exchangeCode(input: { code: string; redirectUri: string }): Promise<{ email: string }> {
    const identity = this.identities.get(input.code);
    if (!identity) throw new Error(`unknown fake code: ${input.code}`);
    return { email: identity.email };
  }
}
