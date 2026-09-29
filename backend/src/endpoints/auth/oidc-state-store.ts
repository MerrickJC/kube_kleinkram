import { Request } from 'express';
import { SessionStoreContext } from 'passport-openidconnect';

/**
 * passport-openidconnect always routes its `state` parameter (and any nonce)
 * through a "state store". OIDC support has no unauthenticated/stateless
 * mode built in.
 *
 * To get around this, this store instead echoes the app-level `state` value
 * (stashed onto `options.state` by OidcStrategy#authenticate from
 * `request.query.state`) straight through as the literal OAuth wire-level
 * `state` value. This matches the security posture already established by
 * the OAuth providers in this codebase.
 */
export class StatelessOidcStateStore {
    store(
        _request: Request,
        _ctx: SessionStoreContext,
        appState: object | undefined,
        _meta: object | undefined,
        callback: (error: Error | null, handle?: string) => void,
    ): void {
        callback(null, typeof appState === 'string' ? appState : '');
    }

    verify(
        _request: Request,
        handle: string,
        callback: (
            error: Error | null,
            ctx?: false | SessionStoreContext,
            state?: unknown,
        ) => void,
    ): void {
        // A truthy (even empty) ctx is required here since passport-openidconnect
        // treats a falsy ctx as a failed/forged state and rejects the login.
        callback(null, {}, handle);
    }
}
