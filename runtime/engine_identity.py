"""Private instance identity for recovering a guarded worker after a crash."""
import hmac
import os
import re


def identity(token, supplied, engine):
    """Prove possession of the supervisor token before exposing a nonce or PID.

    The process nonce is supplied at startup and is never an authorization
    credential by itself. Older or externally started workers have no nonce and
    cannot be adopted by a new supervisor.
    """
    if not isinstance(token,str) or not token or not token.isascii() or not isinstance(supplied,str) or not supplied.isascii() or not hmac.compare_digest(token, supplied):
        raise PermissionError('Forbidden.')
    nonce=os.environ.get('FORGE_ENGINE_INSTANCE_NONCE','')
    if not re.fullmatch(r'[0-9a-f]{64}',nonce):
        raise LookupError('Recovery identity is unavailable.')
    return {'engine':engine,'pid':os.getpid(),'nonce':nonce}


def install_identity_endpoint(app, token, engine):
    from fastapi import Header, HTTPException

    @app.get('/api/forge/identity')
    def recover_identity(x_forge_engine_token: str = Header(default='')):
        try:
            return identity(token, x_forge_engine_token, engine)
        except PermissionError as error:
            raise HTTPException(403, str(error)) from error
        except LookupError as error:
            raise HTTPException(404, str(error)) from error
