import asyncio

from app.popularity import sync_popularity


if __name__ == "__main__":
    count = asyncio.run(sync_popularity())
    print(f"同期したスポット数: {count}")
