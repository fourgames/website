"""Starts the push alerts: python -m alerts (from the server/ folder)."""

from __future__ import annotations

import asyncio
import logging
import signal
import sys
from functools import partial
from pathlib import Path

import aiohttp
from aiohttp import web

from .checks import Checks, run_announce
from .config import Config, ConfigError
from .twitch import Twitch
from .web import build_app
from .youtube import YouTube

log = logging.getLogger("alerts")

USER_AGENT = "fourgames-alerts/1.0 (+https://fourgames.se)"
# A stop waits this long for a running check (alerts.service gives it TimeoutStopSec=120).
STOP_GRACE = 100


async def serve(config: Config) -> None:
    session = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=30), headers={"User-Agent": USER_AGENT})
    checks = Checks(partial(run_announce, config.feedback_python, config.feedback_dir, config.check_timeout),
                    config.check_delays)
    youtube = YouTube(config, session, checks) if config.youtube_enabled else None
    twitch = Twitch(config, session, checks) if config.twitch_enabled else None
    # No access log: the handlers log what matters.
    runner = web.AppRunner(build_app(checks, youtube, twitch), access_log=None)
    await runner.setup()
    await web.TCPSite(runner, config.host, config.port).start()
    log.info("listening on %s:%d (YouTube %s, Twitch %s)", config.host, config.port,
             "on" if youtube else "off", "on" if twitch else "off")

    # Subscribing only once the callbacks answer: both platforms check them straight away.
    tasks = [asyncio.create_task(checks.run_forever())]
    if youtube:
        tasks.append(asyncio.create_task(youtube.keep_subscribed()))
    if twitch:
        tasks.append(asyncio.create_task(twitch.keep_subscribed()))

    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)
    await stop.wait()

    log.info("stopping")
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    await checks.close(STOP_GRACE)
    await runner.cleanup()
    await session.close()


def main() -> None:
    # journald adds its own timestamps, so the format leaves them out.
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    try:
        config = Config.from_env()
        script = Path(config.feedback_dir) / "announce.py"
        if not script.is_file():
            raise ConfigError(f"no {script} (FEEDBACK_DIR)")
        if not Path(config.feedback_python).is_file():
            raise ConfigError(f"no {config.feedback_python} (FEEDBACK_PYTHON)")
    except ConfigError as error:
        print(f"alerts: {error}", file=sys.stderr)
        sys.exit(2)
    asyncio.run(serve(config))


main()
