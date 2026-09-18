"""Validate local preview origins without trusting arbitrary hostnames."""
import re


def preview_origin_allowed(origin, config, defaults=()):
    explicit = ('null', f"http://127.0.0.1:{config['port']}", *defaults, *config.get('allowedOrigins', []))
    if origin in explicit:
        return True
    if not config.get('allowLoopbackOrigins', False):
        return False
    match = re.fullmatch(r'http://(?:127\.0\.0\.1|localhost|\[::1\])(?::([0-9]{1,5}))?', origin)
    return bool(match and (match[1] is None or 1 <= int(match[1]) <= 65535))
