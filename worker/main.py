import asyncio
import sys
from pathlib import Path

sys.path.append(str(Path(__file__).resolve().parents[1] / "api"))

from app.database import init_db
from app.services import run_worker_loop


async def main() -> None:
    await init_db()
    await run_worker_loop()


if __name__ == "__main__":
    asyncio.run(main())
