"""feedback/announce.py's run(): the lock the loop and push-started checks share, and how a push's
state reaches data/announced.json. check() itself is replaced (no network, no Discord)."""

import subprocess
import sys
import textwrap
import threading
import time
from pathlib import Path

import pytest

FEEDBACK = Path(__file__).resolve().parents[3] / "feedback"
sys.path.insert(0, str(FEEDBACK))
import announce  # noqa: E402


@pytest.fixture
def files(tmp_path, monkeypatch):
    monkeypatch.setattr(announce, "LOCK", tmp_path / ".cache" / "announce.lock")
    monkeypatch.setattr(announce, "PENDING", tmp_path / ".cache" / "announced-pending.json")
    data = tmp_path / "data" / "announced.json"
    data.parent.mkdir()
    return data


class Channel:
    """A stand-in for check(): posts every video in `feed` that the state hasn't marked posted."""

    def __init__(self, feed):
        self.feed = list(feed)
        self.posts = []
        self.seen_states = []

    def __call__(self, state):
        self.seen_states.append(dict(state.get("youtube", {})))
        seen = state.setdefault("youtube", {})
        new = [v for v in self.feed if seen.get(v) != "posted"]
        for video in new:
            self.posts.append(video)
            seen[video] = "posted"
        return bool(new)


def read(path):
    import json
    return json.loads(path.read_text())


def test_the_loop_alone_works_as_before(files, monkeypatch):
    channel = Channel(["a"])
    monkeypatch.setattr(announce, "check", channel)
    assert announce.run(files) is True
    assert read(files) == {"youtube": {"a": "posted"}}
    written = files.read_text()
    assert written.endswith("\n") and '\n "youtube"' in written  # run.py's save() format
    assert announce.run(files) is False  # nothing new: nothing written
    assert channel.posts == ["a"] and not announce.PENDING.exists()


def test_a_push_saves_beside_the_data_and_the_loop_takes_it_over(files, monkeypatch):
    files.write_text('{"youtube": {"old": "old"}}\n')
    channel = Channel(["a"])
    monkeypatch.setattr(announce, "check", channel)

    assert announce.run(files, push=True) is True  # PENDING written
    assert files.read_text() == '{"youtube": {"old": "old"}}\n'  # data/ untouched between the loop's pull and run
    assert read(announce.PENDING) == {"youtube": {"old": "old", "a": "posted"}}

    assert announce.run(files) is True  # nothing new to post, but the push's state taken over
    assert read(files) == {"youtube": {"old": "old", "a": "posted"}}
    assert not announce.PENDING.exists()
    assert channel.posts == ["a"]


def test_no_video_is_posted_twice_between_pushes_and_the_loop(files, monkeypatch):
    channel = Channel(["a"])
    monkeypatch.setattr(announce, "check", channel)
    announce.run(files, push=True)          # YouTube's push: posts a
    announce.run(files)              # the loop: a is known
    channel.feed.append("b")
    announce.run(files, push=True)          # posts b
    announce.run(files, push=True)          # the retry a little later: nothing new
    announce.run(files)              # the loop again
    announce.run(files, push=True)
    assert channel.posts == ["a", "b"]
    assert read(files) == {"youtube": {"a": "posted", "b": "posted"}}
    assert not announce.PENDING.exists()
    # Each check started from everything posted before it.
    assert channel.seen_states[3] == {"a": "posted", "b": "posted"}


def test_a_push_builds_on_the_last_push(files, monkeypatch):
    channel = Channel(["a"])
    monkeypatch.setattr(announce, "check", channel)
    announce.run(files, push=True)
    channel.feed.append("b")
    announce.run(files, push=True)
    assert read(announce.PENDING) == {"youtube": {"a": "posted", "b": "posted"}}
    assert not files.exists()
    assert channel.posts == ["a", "b"]


def test_checks_in_threads_take_turns(files, monkeypatch):
    running, most = [0], [0]
    lock = threading.Lock()

    def slow_check(state):
        with lock:
            running[0] += 1
            most[0] = max(most[0], running[0])
        time.sleep(0.1)
        with lock:
            running[0] -= 1
        state["n"] = state.get("n", 0) + 1
        return True

    monkeypatch.setattr(announce, "check", slow_check)
    threads = [threading.Thread(target=announce.run, kwargs={"push": i % 2 == 0, "path": files}) for i in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert most[0] == 1
    # Every check built on the one before, whichever kind it was.
    final = read(announce.PENDING) if announce.PENDING.exists() else read(files)
    assert final["n"] == 4


def test_a_check_waits_for_another_process_holding_the_lock(files, monkeypatch):
    holder = subprocess.Popen([sys.executable, "-c", textwrap.dedent(f"""
        import sys, time
        from pathlib import Path
        sys.path.insert(0, {str(FEEDBACK)!r})
        import announce
        announce.LOCK = Path({str(announce.LOCK)!r})
        with announce.locked():
            print("held", flush=True)
            time.sleep(0.6)
        print("released", flush=True)
    """)], stdout=subprocess.PIPE, text=True)
    with holder:
        assert holder.stdout.readline().strip() == "held"
        held_at = time.monotonic()
        started = []

        def check(state):
            started.append(time.monotonic())
            return False

        monkeypatch.setattr(announce, "check", check)
        announce.run(files)
        assert started and started[0] - held_at >= 0.4  # it waited for the other process


def test_a_lock_left_by_a_killed_process_is_free(files, monkeypatch):
    holder = subprocess.Popen([sys.executable, "-c", textwrap.dedent(f"""
        import sys, time
        from pathlib import Path
        sys.path.insert(0, {str(FEEDBACK)!r})
        import announce
        announce.LOCK = Path({str(announce.LOCK)!r})
        with announce.locked():
            print("held", flush=True)
            time.sleep(60)
    """)], stdout=subprocess.PIPE, text=True)
    with holder:
        assert holder.stdout.readline().strip() == "held"
        holder.kill()
    monkeypatch.setattr(announce, "check", Channel(["a"]))
    started = time.monotonic()
    assert announce.run(files) is True
    assert time.monotonic() - started < 5


def test_push_needs_its_flag():
    result = subprocess.run([sys.executable, str(FEEDBACK / "announce.py")], capture_output=True, text=True)
    assert result.returncode != 0 and "--push" in result.stderr
