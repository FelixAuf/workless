"""uv run python -m app.backup /backups/career-radar.sqlite3 (PYTHONPATH=backend)."""

import sqlite3
import sys
from pathlib import Path

from .config import settings


def main():
    destination = Path(sys.argv[1])
    if destination.resolve() == Path(settings.database_path).resolve() or destination.exists():
        raise SystemExit("Backup-Ziel muss neu sein und darf nicht die laufende Datenbank sein.")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(settings.database_path) as source, sqlite3.connect(destination) as target:
        source.backup(target)
    destination.chmod(0o600)
    print("SQLite-Backup erstellt.")


if __name__ == "__main__":
    main()
