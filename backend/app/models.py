from typing import Literal
from urllib.parse import urlsplit

from apscheduler.triggers.cron import CronTrigger
from pydantic import BaseModel, Field, field_validator


class SearchProfile(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=3000)
    search_prompt: str = Field(min_length=1, max_length=8000)
    evaluation_prompt: str = Field(min_length=1, max_length=8000)
    sources: list[str] = Field(default_factory=list, max_length=30)
    geography: str = Field(default="Österreich", max_length=1000)
    remote_only: bool = False
    schedule: Literal["manual", "daily", "weekly", "cron"] = "manual"
    cron: str = "0 8 * * *"
    enabled: bool = True
    max_jobs: int = Field(default=10, ge=1, le=30)

    @field_validator("cron")
    @classmethod
    def cron_valid(cls, value):
        CronTrigger.from_crontab(value, timezone="Europe/Vienna")
        return value

    @field_validator("sources")
    @classmethod
    def domains_valid(cls, value):
        import re

        if any(not re.fullmatch(r"[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}", d) for d in value):
            raise ValueError("Quellen als Domains ohne https:// und Pfad eingeben.")
        return value


class Job(BaseModel):
    company: str = Field(min_length=1, max_length=300)
    title: str = Field(min_length=1, max_length=500)
    location: str = Field(max_length=500)
    remote_policy: str
    austria_remote: Literal["confirmed", "unconfirmed", "no"]
    availability: Literal["confirmed", "unconfirmed", "closed"]
    salary: str | None
    requirements: list[str]
    description: str = Field(max_length=12000)
    url: str
    source_url: str
    published_at: str | None

    @field_validator("url", "source_url")
    @classmethod
    def url_valid(cls, value):
        u = urlsplit(value)
        if u.scheme not in ("http", "https") or not u.hostname or u.username or u.password:
            raise ValueError("Ungültige Quellen-URL")
        return value


class Discoveries(BaseModel):
    jobs: list[Job] = Field(max_length=30)


class Assessment(BaseModel):
    score: int = Field(ge=0, le=100)
    reasoning: str
    matching_qualifications: list[str]
    missing_qualifications: list[str]
    role_type: Literal["realistic", "stretch"]
    decision_authority: str
    development_potential: str
    red_flags: list[str]


class MatchUpdate(BaseModel):
    status: Literal["new", "interesting", "rejected", "applied", "archived"]
    favorite: bool = False
    reason: str = Field(default="", max_length=2000)
