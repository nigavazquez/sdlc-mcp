import * as oidcClient from 'openid-client';

/**
 * Generic OIDC Identity Provider interface.
 * Replaces the Google-specific GoogleIdentityProvider.
 * The AS (routes.ts) uses only authUrl and exchangeCode.
 */
export interface IdentityProvider {
  authUrl(input: { state: string; redirectUri: string }): string;
  /**
   * `iss` es el parámetro del callback (RFC 9207). Si el proveedor anuncia
   * `authorization_response_iss_parameter_supported` (Google lo hace), es obligatorio.
   */
  exchangeCode(input: { code: string; redirectUri: string; iss?: string }): Promise<{ email: string }>;
}

export interface OidcMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  authorization_response_iss_parameter_supported?: boolean;
  [key: string]: unknown;
}

export interface OidcProviderOptions {
  clientId: string;
  clientSecret: string;
  scopes: string[];
}

export interface FromDiscoveryOptions extends OidcProviderOptions {
  discoveryUrl: string;
}

export interface FromMetadataOptions extends OidcProviderOptions {
  metadata: OidcMetadata;
}

/**
 * OIDC Identity Provider using openid-client v6.
 * Supports any OpenID Connect provider via discovery or injected metadata.
 *
 * authUrl builds the authorization redirect URL directly from the metadata,
 * without PKCE (PKCE is already handled by the AS in crypto.ts).
 *
 * exchangeCode calls the token endpoint, validates the id_token claims,
 * and returns { email }. Requires email_verified.
 */
export class OidcIdentityProvider implements IdentityProvider {
  private readonly config: oidcClient.Configuration;
  private readonly scopes: string[];

  private constructor(config: oidcClient.Configuration, scopes: string[]) {
    this.config = config;
    this.scopes = scopes;
  }

  /**
   * Performs real OIDC discovery via the well-known endpoint.
   * This is the PRODUCTION path.
   */
  static async fromDiscovery(opts: FromDiscoveryOptions): Promise<OidcIdentityProvider> {
    const config = await oidcClient.discovery(
      new URL(opts.discoveryUrl),
      opts.clientId,
      opts.clientSecret,
    );
    // Security-sensitive broker: openid-client v6 skips id_token signature
    // verification by default. Enable non-repudiation checks so id_tokens are
    // cryptographically verified against the provider's JWKS.
    oidcClient.enableNonRepudiationChecks(config);
    return new OidcIdentityProvider(config, opts.scopes);
  }

  /**
   * Builds from injected metadata — TEST-ONLY path, no network required.
   * Deliberately does NOT call enableNonRepudiationChecks: that would force a
   * real JWKS fetch and break the no-network unit tests. Production always uses
   * fromDiscovery (which enables signature-via-JWKS verification).
   */
  static async fromMetadata(opts: FromMetadataOptions): Promise<OidcIdentityProvider> {
    const server: oidcClient.ServerMetadata = {
      issuer: opts.metadata.issuer,
      authorization_endpoint: opts.metadata.authorization_endpoint,
      token_endpoint: opts.metadata.token_endpoint,
      jwks_uri: opts.metadata.jwks_uri,
      ...(opts.metadata.authorization_response_iss_parameter_supported !== undefined
        ? { authorization_response_iss_parameter_supported: opts.metadata.authorization_response_iss_parameter_supported }
        : {}),
    };
    const config = new oidcClient.Configuration(server, opts.clientId, opts.clientSecret);
    return new OidcIdentityProvider(config, opts.scopes);
  }

  /**
   * Builds the authorization redirect URL.
   * State is provided by the AS (already signed); no PKCE here (AS owns it).
   */
  authUrl(input: { state: string; redirectUri: string }): string {
    const url = oidcClient.buildAuthorizationUrl(this.config, new URLSearchParams({
      redirect_uri: input.redirectUri,
      scope: this.scopes.join(' '),
      state: input.state,
      response_type: 'code',
    }));
    return url.toString();
  }

  /**
   * Exchanges the authorization code for an id_token, validates it,
   * and returns the email. Requires email_verified claim to be true.
   */
  async exchangeCode(input: { code: string; redirectUri: string; iss?: string }): Promise<{ email: string }> {
    // Build a URL that simulates the callback with the code and state
    // openid-client's authorizationCodeGrant expects the full callback URL
    const callbackUrl = new URL(input.redirectUri);
    callbackUrl.searchParams.set('code', input.code);
    // Sin esto, un proveedor que anuncia el parámetro `iss` (Google) rechaza todo login:
    // openid-client lo exige y valida que coincida con el issuer del discovery.
    if (input.iss !== undefined) callbackUrl.searchParams.set('iss', input.iss);

    const tokens = await oidcClient.authorizationCodeGrant(this.config, callbackUrl, {
      // We skip state check here because it's already validated by the AS (verifyState in routes.ts)
      // We skip PKCE here because the AS does not pass pkce through the IdP interface
      idTokenExpected: true,
    });

    const claims = tokens.claims();
    if (!claims) {
      throw new Error('OIDC token response missing id_token');
    }
    if (!claims.email || !claims.email_verified) {
      throw new Error('OIDC id_token missing verified email');
    }

    return { email: claims.email as string };
  }
}
