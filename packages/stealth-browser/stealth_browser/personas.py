"""Persistent browser personas -- the "lived-in" profile pool.

A fresh, empty Chrome profile every session is a bot tell: no cookies, no
history, no cache, landing directly on a deep URL. Real users have profiles
that accumulate state over weeks. DataDome and similar vendors tie their
clearance token to a profile's *behavior history*.

This module manages a pool of persistent `user_data_dir`s on disk. Each
persona is a long-lived Chrome profile that keeps its cookies/history/cache
across sessions, so it looks progressively more "lived-in" the more it is used.

Concurrency rule: Chrome exclusively locks a profile directory, so a persona
can back only ONE live session at a time. The pool hands out a free persona
and reclaims it on release; if all are busy a fresh ephemeral profile is used
(Chrome's default) rather than blocking.

Set APEX_PERSONA_DIR to choose where personas live (default: a dir next to the
apex package). Set APEX_PERSONA_COUNT for the pool size (default 4).
"""

from __future__ import annotations

import os
import threading
from pathlib import Path


def _persona_root() -> Path:
    env = os.environ.get("APEX_PERSONA_DIR")
    if env:
        return Path(env)
    return Path(__file__).resolve().parent.parent / "personas"


_POOL_SIZE = int(os.environ.get("APEX_PERSONA_COUNT", "4"))


class PersonaPool:
    """Hands out persistent profile dirs, one live session per persona."""

    def __init__(self, size: int = _POOL_SIZE):
        self._root = _persona_root()
        self._root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        # persona dir -> True if currently checked out
        self._busy: dict[Path, bool] = {}
        for i in range(size):
            d = self._root / f"persona-{i:02d}"
            d.mkdir(parents=True, exist_ok=True)
            self._busy[d] = False

    def acquire(self) -> Path | None:
        """Return a free persona dir, or None if all are busy.

        None means the caller should fall back to an ephemeral profile -- a
        fresh persona is better than blocking, and an occasional clean profile
        is itself unremarkable (a real user on a new device).
        """
        with self._lock:
            for d, busy in self._busy.items():
                if not busy:
                    self._busy[d] = True
                    return d
            return None

    def acquire_named(self, name: str) -> Path:
        """Acquire a SPECIFIC persona by name -- the ACCOUNT model. An account id
        maps to its own dedicated, persistent profile dir (created if new), so
        that account always reuses the same cookies/history AND (via the saved
        apex-fingerprint.json next to it) the same device fingerprint -- it looks
        like ONE fixed machine every login, distinct + unlinkable from other
        accounts. Unlike acquire() it never returns None: a named account always
        maps to its dir. Name is sanitized to a safe dir component.
        """
        safe = "".join(c if (c.isalnum() or c in "-_.") else "_"
                       for c in name)[:64] or "default"
        d = self._root / f"acct-{safe}"
        with self._lock:
            d.mkdir(parents=True, exist_ok=True)
            self._busy[d] = True
        return d

    def release(self, persona: Path | None) -> None:
        """Return a persona to the pool."""
        if persona is None:
            return
        with self._lock:
            if persona in self._busy:
                self._busy[persona] = False

    def stats(self) -> dict:
        with self._lock:
            return {
                "total": len(self._busy),
                "in_use": sum(1 for v in self._busy.values() if v),
                "root": str(self._root),
            }


# A single process-wide pool shared by all sessions.
POOL = PersonaPool()
