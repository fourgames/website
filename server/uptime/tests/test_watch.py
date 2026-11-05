"""server_stats' traffic watch: Caddy's metrics, TCP states, request rates, the rings and medians, the
judgement and the Discord alerts."""

from uptime import server_stats as ss
from uptime.server_stats import (
    ATTACK, BUSY, OK, count_tcp_states, judge, median, parse_metrics, push, request_counters,
    request_rates, update_rings, watch_step,
)

METRICS = """\
# HELP caddy_http_requests_total Counter of HTTP(S) requests made.
# TYPE caddy_http_requests_total counter
caddy_http_requests_total{handler="reverse_proxy",server="srv0"} 120
caddy_http_requests_total{handler="file_server",server="srv0"} 30
caddy_http_requests_in_flight{handler="file_server",server="srv0"} 2
caddy_http_requests_in_flight{handler="reverse_proxy",server="srv0"} 1
caddy_http_request_duration_seconds_bucket{code="200",handler="file_server",method="GET",server="srv0",le="0.005"} 10
caddy_http_request_duration_seconds_count{code="200",handler="file_server",method="GET",server="srv0"} 25
caddy_http_request_duration_seconds_count{code="404",handler="file_server",method="GET",server="srv0"} 4
caddy_http_request_duration_seconds_count{code="502",handler="reverse_proxy",method="POST",server="srv0"} 1
go_goroutines 42
broken line without value
caddy_http_requests_total{handler="x",server="a\\"b"} 5 1700000000000
"""


def test_metrics_parsing():
    samples = parse_metrics(METRICS)
    names = [s[0] for s in samples]
    assert "go_goroutines" in names and len([n for n in names if n == "caddy_http_requests_total"]) == 3
    escaped = [l for n, l, _ in samples if l.get("handler") == "x"][0]
    assert escaped["server"] == 'a"b'
    # requests summed over every series; no code label on requests_total: no error counts
    assert request_counters(samples) == {"total": 155, "coded": None, "errors": None, "hosts": {}}
    assert ss.requests_in_flight(samples) == 3


def test_metrics_with_code_and_host_labels():
    text = ('caddy_http_requests_total{code="200",handler="h",host="api.fourgames.se",server="s"} 90\n'
            'caddy_http_requests_total{code="429",handler="h",host="api.fourgames.se",server="s"} 6\n'
            'caddy_http_requests_total{code="503",handler="h",host="status.fourgames.se",server="s"} 4\n')
    assert request_counters(parse_metrics(text)) == {
        "total": 100, "coded": 100, "errors": 10,
        "hosts": {"api.fourgames.se": 96, "status.fourgames.se": 4},
    }


def test_no_request_metrics():
    assert request_counters(parse_metrics("go_goroutines 3\n")) is None
    assert request_counters([]) is None


TCP = """\
  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1 1 0000000000000000 100 0 0 10 0
   1: 0100007F:1F90 0100007F:D2A4 01 00000000:00000000 00:00000000 00000000  1000        0 2 1 0000000000000000 20 4 30 10 -1
   2: 0A00020F:01BB 5DB8D822:C350 01 00000000:00000000 00:00000000 00000000    33        0 3 1 0000000000000000 20 4 30 10 -1
   3: 0A00020F:01BB 5DB8D823:C351 03 00000000:00000000 02:00000064 00000002     0        0 0 0 0000000000000000
"""


def test_tcp_states():
    counts = count_tcp_states(TCP)
    assert counts == {"0A": 1, "01": 2, "03": 1}
    assert count_tcp_states(TCP.splitlines()[0]) == {}


def counters(total, coded=None, errors=None, hosts=None):
    return {"total": total, "coded": coded, "errors": errors, "hosts": hosts or {}}


def test_request_rates_from_the_change():
    prev = {"at": 1000.0, "c": counters(100, 100, 0, {"api.fourgames.se": 90, "status.fourgames.se": 10})}
    rates = request_rates(prev, counters(400, 300, 20, {"api.fourgames.se": 360, "status.fourgames.se": 40}), 1030.0)
    # 300 in 30 s; 20 of 200 coded were errors; api got 270 of 300
    assert rates == {"requestsPerMin": 600, "errorPct": 10.0, "mostlyHost": "api.fourgames.se"}


def test_request_rates_no_host_with_most():
    prev = {"at": 1000.0, "c": counters(0, hosts={"a": 0, "b": 0})}
    assert request_rates(prev, counters(100, hosts={"a": 55, "b": 45}), 1060.0)["mostlyHost"] is None


def test_request_rates_first_run_reset_and_no_metrics():
    assert request_rates(None, counters(1), 1000.0)["requestsPerMin"] is None
    assert request_rates({"at": 1000.0, "c": counters(500)}, counters(10), 1060.0)["requestsPerMin"] is None  # Caddy restarted
    assert request_rates({"at": 1000.0, "c": counters(5)}, None, 1060.0)["requestsPerMin"] is None
    assert request_rates({"at": 1000.0, "c": [5, 5, 0]}, counters(9), 1060.0)["requestsPerMin"] is None  # old format
    rates = request_rates({"at": 1000.0, "c": counters(5)}, counters(65), 1060.0)
    assert rates == {"requestsPerMin": 60, "errorPct": None, "mostlyHost": None}  # no code label: no share


def test_push_and_gaps():
    assert push([], 1, 1, 3) == [1]
    assert push([1, 2, 3], 4, 1, 3) == [2, 3, 4]
    assert push([1], 5, 3, 5) == [1, None, None, 5]          # two minutes missed
    assert push([1, 2], 9, 0, 5) == [1, 9]                    # second run in the same minute
    assert push([1, 2], 9, 10_000, 3) == [None, None, 9]      # off for a week


def test_update_rings_keeps_minutes_aligned():
    rings = update_rings({}, 100, {"req": 5, "inMbit": 0.5}, ("req", "inMbit"), 60)
    rings = update_rings(rings, 101, {"req": 6, "inMbit": None}, ("req", "inMbit"), 60)
    rings = update_rings(rings, 104, {"req": 7, "inMbit": 1.0}, ("req", "inMbit"), 60)
    assert rings == {"minute": 104, "req": [5, 6, None, None, 7], "inMbit": [0.5, None, None, None, 1.0]}


def test_median_needs_enough_minutes():
    assert median([1, 2, 3], minimum=3) == 2
    assert median([1, None, 2], minimum=3) is None
    assert median([1, 2, 3, 4], minimum=1) in (2, 3)           # ints stay ints
    assert median([0.1, 0.25, 0.3], minimum=1) == 0.25
    assert median([None] * 1440 + [12] * 60) == 12


def recent(**rows):
    return {k: list(v) for k, v in rows.items()}


def test_judge_ok():
    assert judge(recent(req=[10] * 60, inMbit=[0.5] * 60, cpuPct=[20] * 60, syn=[1] * 60), 12) == (OK, [])
    assert judge({}, None) == (OK, [])


def test_a_surge_that_gets_answered_is_busy_not_an_attack():
    # a game going viral: 100 × normal, nearly everything answered
    state, reasons = judge(recent(req=[10, 1240, 1240, 1240], errPct=[0, 0.4, 0.2, 0.3]), 12, "api.fourgames.se")
    assert state == BUSY
    assert reasons == ["Lots of traffic: 1,240 requests a minute (normally 12), mostly to the API "
                       "(game data, key bot, contact form), and it's all being answered"]
    state, reasons = judge(recent(req=[5000] * 3, errPct=[12] * 3), 12)
    assert state == BUSY and reasons == ["Lots of traffic: 5,000 requests a minute (normally 12), and 88% of it is being answered"]


def test_without_a_code_label_a_surge_is_only_busy():
    assert judge(recent(req=[50_000] * 3, errPct=[None] * 3), 12) == (
        BUSY, ["Lots of traffic: 50,000 requests a minute (normally 12)"])


def test_a_surge_of_mostly_errors_is_an_attack():
    state, reasons = judge(recent(req=[1240] * 3, errPct=[70, 85, 85]), 12)
    assert state == ATTACK and reasons == ["1,240 requests a minute (normally 12), 85% of them errors"]
    # errors for only two of the three minutes: busy, worded with the errors
    state, reasons = judge(recent(req=[1240] * 3, errPct=[10, 85, 85]), 12)
    assert state == BUSY and reasons == ["Lots of traffic: 1,240 requests a minute (normally 12), 85% of it errors"]
    # mostly errors but under the flood level (10 × normal, at least 600): busy
    assert judge(recent(req=[500] * 3, errPct=[90] * 3), 12)[0] == BUSY


def test_surges_need_three_minutes():
    assert judge(recent(req=[10, 10, 700, 700]), None)[0] == OK
    # a missed minute (None) inside the last three breaks the run; one before them doesn't
    assert judge(recent(req=[700, 700, None, 700]), None)[0] == OK
    assert judge(recent(req=[None, 700, 700, 700]), None)[0] == BUSY


def test_surge_level_scales_with_normal():
    assert judge(recent(req=[399] * 3), 100)[0] == OK                 # under 4 × normal
    assert judge(recent(req=[400] * 3), 100)[0] == BUSY
    assert judge(recent(req=[199] * 3), None)[0] == OK                # no normal yet: the floor alone
    assert judge(recent(req=[200] * 3), None) == (BUSY, ["Lots of traffic: 200 requests a minute"])
    assert judge(recent(req=[999] * 3, errPct=[90] * 3), 100)[0] == BUSY    # flood level 1,000
    assert judge(recent(req=[1000] * 3, errPct=[90] * 3), 100)[0] == ATTACK


def test_raw_inbound_traffic_without_requests_is_an_attack():
    assert judge(recent(inMbit=[60, 60]), None)[0] == OK              # two minutes only
    state, reasons = judge(recent(req=[12] * 3, inMbit=[55, 60, 63.2]), 12)
    assert state == ATTACK and reasons == ["63 Mbit/s coming in, far more than the requests explain"]
    assert judge(recent(inMbit=[55, 60, 63.2]), None)[0] == ATTACK   # no request counts at all
    # the same traffic with a surge of answered requests: real visitors, busy
    assert judge(recent(req=[3000] * 3, errPct=[0] * 3, inMbit=[63] * 3), 12)[0] == BUSY


def test_half_open_connections_are_an_attack():
    assert judge(recent(syn=[0, 250]), None) == (ATTACK, ["250 half-open connections piling up (a SYN flood)"])
    assert judge(recent(syn=[250, None]), None)[0] == OK
    assert judge(recent(syn=[199]), None)[0] == OK


def test_cpu_needs_five_minutes_and_is_busy():
    assert judge(recent(cpuPct=[95] * 4), None)[0] == OK
    assert judge(recent(cpuPct=[50, 95, 96, 91, 90, 97]), None) == (BUSY, ["Working hard: CPU at 97% for 5 min"])


def test_attack_wins_and_lists_every_reason():
    state, reasons = judge(recent(req=[5000] * 3, errPct=[95] * 3, cpuPct=[99] * 5, syn=[400]), 12)
    assert state == ATTACK
    assert reasons == ["400 half-open connections piling up (a SYN flood)",
                       "5,000 requests a minute (normally 12), 95% of them errors"]


def test_host_names():
    assert ss.host_name("press.fourgames.se") == "the short links"
    assert ss.host_name("_other").startswith("addresses we don't serve")
    assert ss.host_name(None) is None


def test_messages():
    assert ss.alert_text(BUSY, ["Lots of traffic: 1,240 requests a minute (normally 12), and it's all being answered"]) == (
        "📈 Lots of traffic: 1,240 requests a minute (normally 12), and it's all being answered. status.fourgames.se")
    assert ss.alert_text(ATTACK, ["a", "b"]) == "⚠️ Unusual traffic on the server: a; b. status.fourgames.se"


class Sender:
    def __init__(self, ok=True):
        self.ok, self.sent = ok, []

    def __call__(self, text):
        self.sent.append(text)
        return self.ok


def run(sequence, sender, start=0.0, ws=None):
    """Feeds (minutes after start, state) pairs through watch_step; returns the last ws and report."""
    ws = ws or {}
    report = None
    for minute, state in sequence:
        ws, report = watch_step(ws, state, ["x"] if state != OK else [], start + minute * 60, sender)
    return ws, report


def test_alert_on_attack_and_recovery_with_duration():
    send = Sender()
    ws, report = run([(0, OK), (1, ATTACK)], send)
    assert report == {"state": ATTACK, "reasons": ["x"], "since": 60}
    assert send.sent == ["⚠️ Unusual traffic on the server: x. status.fourgames.se"]
    ws, report = run([(2, ATTACK), (10, ATTACK), (19, OK)], send, ws=ws)
    assert len(send.sent) == 2 and send.sent[1] == "✅ Traffic is back to normal after 18 min."
    assert report == {"state": OK, "reasons": [], "since": None}
    ws, _ = run([(20, OK), (21, OK)], send, ws=ws)
    assert len(send.sent) == 2


def test_alert_at_most_once_per_30_minutes_per_state():
    send = Sender()
    ws, _ = run([(0, ATTACK), (5, OK), (10, ATTACK), (15, OK)], send)
    # second attack within 30 min: not told, so no recovery either
    assert send.sent == [ss.alert_text(ATTACK, ["x"]), ss.recovery_text(ATTACK, 300)]
    ws, _ = run([(31, ATTACK), (35, OK)], send, ws=ws)
    assert len(send.sent) == 4 and send.sent[3] == "✅ Traffic is back to normal after 4 min."


def test_held_back_alert_goes_out_once_the_cooldown_has_passed():
    send = Sender()
    ws, _ = run([(0, BUSY), (2, OK), (5, BUSY)], send)
    assert len(send.sent) == 2
    ws, _ = run([(20, BUSY), (30, BUSY)], send, ws=ws)
    assert len(send.sent) == 3 and send.sent[2] == "📈 x. status.fourgames.se"
    ws, _ = run([(40, OK)], send, ws=ws)
    assert send.sent[3] == "✅ The server is back to normal after 35 min."   # since minute 5


def test_busy_then_attack_tells_both():
    send = Sender()
    ws, _ = run([(0, BUSY), (3, ATTACK), (4, ATTACK), (9, OK)], send)
    assert [m.split()[0] for m in send.sent] == ["📈", "⚠️", "✅"]
    assert send.sent[2] == "✅ Traffic is back to normal after 9 min."


def test_failed_send_is_tried_again_and_not_counted():
    failing = Sender(ok=False)
    ws, _ = run([(0, ATTACK), (1, ATTACK)], failing)
    assert len(failing.sent) == 2 and ws["announced"] is None
    working = Sender()
    ws, _ = run([(2, ATTACK), (3, ATTACK)], working, ws=ws)
    assert len(working.sent) == 1
    # the recovery fails once, then goes out
    ws, report = run([(4, OK)], failing, ws=ws)
    assert report["state"] == OK and ws["announced"] == ATTACK
    ws, _ = run([(5, OK)], working, ws=ws)
    assert working.sent[-1] == "✅ Traffic is back to normal after 5 min." and ws["announced"] is None


def test_new_episode_drops_a_waiting_recovery():
    failing = Sender(ok=False)
    working = Sender()
    ws, _ = run([(0, ATTACK)], working)
    ws, _ = run([(1, OK)], failing, ws=ws)                    # recovery not sent
    ws, report = run([(2, ATTACK)], working, ws=ws)           # still told as attack: nothing new
    assert len(working.sent) == 1 and report["since"] == 120


def test_webhook_url_never_printed(monkeypatch, capsys):
    monkeypatch.setenv("DISCORD_WEBHOOK_URL", "http://127.0.0.1:9/secret-token")
    assert ss.discord_send("hi") is False
    out = capsys.readouterr().out
    assert "secret-token" not in out and "Discord alert failed" in out


def test_webhook_url_from_env_file(monkeypatch, tmp_path):
    monkeypatch.delenv("DISCORD_WEBHOOK_URL", raising=False)
    env = tmp_path / "feedback.env"
    env.write_text("OTHER=1\nexport DISCORD_WEBHOOK_URL='https://discord.example/hook'\n")
    monkeypatch.setattr(ss, "WEBHOOK_ENV_FILE", str(env))
    assert ss.webhook_url() == "https://discord.example/hook"
    monkeypatch.setattr(ss, "WEBHOOK_ENV_FILE", str(tmp_path / "missing.env"))
    assert ss.webhook_url() is None
