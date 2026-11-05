"""server_stats.step: CPU and network from counter changes, the month's traffic across runs, reboots and new months."""

from uptime.server_stats import step

BOOT = "boot-a"


def first(now=1000.0, cpu=(100, 1000), net=(0, 0), month="2026-11"):
    return step({}, now, cpu, net, BOOT, month)


def test_first_run_measures_nothing():
    state, m = first()
    assert m == {"cpuPct": None, "inMbit": None, "outMbit": None}
    assert state["monthIn"] == 0 and state["monthOut"] == 0


def test_cpu_and_network_from_the_change():
    state, _ = first()
    state, m = step(state, 1060.0, (130, 1100), (60_000_000, 37_500_000), BOOT, "2026-11")
    assert m["cpuPct"] == 30.0               # 30 busy of 100
    assert m["inMbit"] == 8.0                # 60 MB in 60 s
    assert m["outMbit"] == 5.0               # 37.5 MB in 60 s
    assert state["monthIn"] == 60_000_000 and state["monthOut"] == 37_500_000


def test_month_adds_up_across_runs():
    state, _ = first()
    state, _ = step(state, 1060.0, (110, 1100), (10, 20), BOOT, "2026-11")
    state, _ = step(state, 1120.0, (120, 1200), (30, 50), BOOT, "2026-11")
    assert state["monthIn"] == 30 and state["monthOut"] == 50


def test_reboot_keeps_the_month_but_measures_nothing():
    state, _ = first()
    state, _ = step(state, 1060.0, (110, 1100), (10, 20), BOOT, "2026-11")
    state, m = step(state, 2000.0, (5, 50), (1, 2), "boot-b", "2026-11")
    assert m["outMbit"] is None and m["cpuPct"] is None
    assert state["monthIn"] == 10 and state["monthOut"] == 20     # kept, nothing added
    state, m = step(state, 2060.0, (15, 150), (11, 22), "boot-b", "2026-11")
    assert state["monthIn"] == 20 and state["monthOut"] == 40


def test_new_month_starts_at_zero():
    state, _ = first()
    state, _ = step(state, 1060.0, (110, 1100), (10, 20), BOOT, "2026-11")
    state, _ = step(state, 1120.0, (120, 1200), (30, 50), BOOT, "2026-12")
    assert state["month"] == "2026-12"
    assert state["monthIn"] == 20 and state["monthOut"] == 30     # only what came after the change


def test_counters_going_backwards_add_nothing():
    state, _ = first(net=(100, 100))
    state, m = step(state, 1060.0, (110, 1100), (50, 50), BOOT, "2026-11")
    assert m["outMbit"] is None and state["monthOut"] == 0
