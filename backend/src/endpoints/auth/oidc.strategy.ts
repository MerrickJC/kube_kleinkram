import { AuthService } from '@/services/auth.service';
import env from '@kleinkram/backend-common/environment';
import { Providers } from '@kleinkram/shared';
import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import e from 'express';
import OpenIDConnectStrategy, { VerifyCallback } from 'passport-openidconnect';
import logger from '../../logger';

export interface OidcEndpoints {
    issuer: string;
    authorizationURL: string;
    tokenURL: string;
    userInfoURL: string;
}

/**
 * Placeholder endpoints used when OIDC isn't configured (or its issuer
 * couldn't be reached at startup), so the strategy can still be constructed
 * without crashing the app. `/auth/oidc` is never exposed as available in
 * that case (see AuthController#getAvailableProviders), so these URLs are
 * never actually dialed in practice.
 */
const UNCONFIGURED_OIDC_ENDPOINTS: OidcEndpoints = {
    issuer: 'urn:kleinkram:oidc-not-configured',
    authorizationURL: 'http://localhost:0/oidc-not-configured/authorize',
    tokenURL: 'http://localhost:0/oidc-not-configured/token',
    userInfoURL: 'http://localhost:0/oidc-not-configured/userinfo',
};

/**
 * Discovers the authorization/token/userinfo endpoints of a generic OIDC
 * provider (e.g. Dex, Keycloak, Okta, Auth0) from its issuer's
 * `.well-known/openid-configuration` document, so that admins only need to
 * configure the issuer URL rather than each individual endpoint.
 */
export async function discoverOidcEndpoints(): Promise<OidcEndpoints> {
    if (
        !env.OIDC_ISSUER_URL ||
        !env.OIDC_CLIENT_ID ||
        !env.OIDC_CLIENT_SECRET
    ) {
        return UNCONFIGURED_OIDC_ENDPOINTS;
    }

    const discoveryUrl = `${env.OIDC_ISSUER_URL.replace(/\/+$/, '')}/.well-known/openid-configuration`;

    try {
        const response = await fetch(discoveryUrl);
        if (!response.ok) {
            throw new Error(`received status ${String(response.status)}`);
        }

        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        const discoveryDocument = await response.json();

        return {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
            issuer: discoveryDocument.issuer,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
            authorizationURL: discoveryDocument.authorization_endpoint,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
            tokenURL: discoveryDocument.token_endpoint,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
            userInfoURL: discoveryDocument.userinfo_endpoint,
        };
    } catch (error) {
        logger.error(
            `Failed to discover OIDC provider configuration from ${discoveryUrl}. The "oidc" login provider will be unavailable until this is fixed.`,
            error,
        );
        return UNCONFIGURED_OIDC_ENDPOINTS;
    }
}

@Injectable()
export class OidcStrategy extends PassportStrategy(
    OpenIDConnectStrategy,
    Providers.OIDC,
) {
    constructor(
        private authService: AuthService,
        endpoints: OidcEndpoints,
    ) {
        const requestedScopes = env.OIDC_SCOPE.split(/\s+/).filter(Boolean);
        super({
            issuer: endpoints.issuer,
            authorizationURL: endpoints.authorizationURL,
            tokenURL: endpoints.tokenURL,
            userInfoURL: endpoints.userInfoURL,
            clientID: env.OIDC_CLIENT_ID ?? 'dummy',
            clientSecret: env.OIDC_CLIENT_SECRET ?? 'dummy',
            callbackURL: `${env.BACKEND_URL}/auth/oidc/callback`,
            // OIDC requires the 'openid' scope; ensure it's always present
            // even if an operator's OIDC_SCOPE override omits it.
            scope: [...new Set(['openid', ...requestedScopes])],
        });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    authenticate(request: e.Request, options?: any) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        options.state = request.query.state;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
        super.authenticate(request, options);
    }

    async validate(
        _issuer: string,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        profile: any,
        callback: VerifyCallback,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ): Promise<any> {
        const user =
            await this.authService.validateAndCreateUserByOidc(profile);

        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (user) {
            logger.debug(`Login successful for ${user.uuid}`);
            callback(null, user);
            return;
        }

        callback(null);
        return;
    }
}
