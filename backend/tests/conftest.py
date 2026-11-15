import pytest
from app.config import settings
from app.db import migrate


@pytest.fixture
def database(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "database_path", str(tmp_path / "test.sqlite3"))
    migrate()
    return tmp_path
