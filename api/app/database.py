from collections.abc import AsyncIterator

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.config import settings


class Base(DeclarativeBase):
    pass


def normalize_database_url(database_url: str) -> str:
    if database_url.startswith("postgresql+asyncpg://"):
        return database_url
    if database_url.startswith("postgresql://"):
        return database_url.replace("postgresql://", "postgresql+asyncpg://", 1)
    if database_url.startswith("postgres://"):
        return database_url.replace("postgres://", "postgresql+asyncpg://", 1)
    return database_url


engine = create_async_engine(normalize_database_url(settings.database_url), future=True)
AsyncSessionLocal = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


async def get_db() -> AsyncIterator[AsyncSession]:
    async with AsyncSessionLocal() as session:
        yield session


async def init_db() -> None:
    from app import models  # noqa: F401
    from sqlalchemy import text as sql_text

    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
        # Idempotent column adds for tables that pre-existed before new fields were introduced.
        # metadata.create_all only creates new tables; it does not ALTER existing ones.
        await connection.execute(
            sql_text("ALTER TABLE projects ADD COLUMN IF NOT EXISTS template_id VARCHAR(32) REFERENCES templates(id) ON DELETE SET NULL")
        )
        await connection.execute(
            sql_text("CREATE INDEX IF NOT EXISTS ix_projects_template_id ON projects (template_id)")
        )
        # stop_after_node_id added later — used to pause a run mid-pipeline for debugging.
        await connection.execute(
            sql_text("ALTER TABLE runs ADD COLUMN IF NOT EXISTS stop_after_node_id VARCHAR(64)")
        )
        # order_index lets the API return node executions in template order
        # rather than alphabetic node_id order.
        await connection.execute(
            sql_text(
                "ALTER TABLE node_executions ADD COLUMN IF NOT EXISTS order_index INTEGER NOT NULL DEFAULT 0"
            )
        )
