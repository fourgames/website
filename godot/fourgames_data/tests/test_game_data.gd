extends "res://tests/tools/game_data_suite.gd"

## GameData end to end, with no network and no Steam: a fake transport answers
## as the server in SPEC.md would and a fake Steam hands out tickets, so every
## step -- the session, batching, the queue, retries, opting out, the quit and
## the crash report a later launch sends -- is driven by advance() and read off
## the requests it made.

#region Off
func test_it_is_off_in_a_debug_run_unless_asked() -> void:
	var gd := _launch()
	gd.force_enabled = false
	if OS.get_environment(GameDataScript.DEV_ENV) == "1":
		assert_true(gd.is_enabled(), "%s=1 turns it on" % GameDataScript.DEV_ENV)
		return
	assert_false(gd.is_enabled(), "a test run is a debug build")
	gd.start(APP_ID, {})
	gd.action("plant", {"x": 1})
	gd.advance(120.0)
	assert_eq(gd.status(), "off")
	assert_eq(gd.steam.asked.size(), 0, "Steam is never asked")
	assert_eq(gd.transport.requests.size(), 0)
	assert_false(DirAccess.dir_exists_absolute(_file("")), "nothing is written")


func test_without_steam_it_is_off() -> void:
	var gd := _launch()
	# No stand-in: GameData looks for the GodotSteam singleton itself. This
	# project has GodotSteam (for the test game), so where it is loaded the
	# stand-in is something that is not Steam, which GameData must not use.
	gd.steam = null if not Engine.has_singleton(&"Steam") else RefCounted.new()
	gd.start(APP_ID, {})
	gd.action("plant", {})
	gd.advance(120.0)
	assert_eq(gd.status(), "off")
	assert_eq(gd.transport.requests.size(), 0)
	assert_false(FileAccess.file_exists(_file("running.json")))
#endregion


#region The session
func test_the_session_starts_with_a_web_api_ticket_and_the_machine() -> void:
	var gd := _launch()
	gd.start(APP_ID, {"volume": 0.5, "language": &"sv", "fullscreen": true})
	gd.advance(0.0)
	assert_eq(gd.steam.asked, PackedStringArray(["fourgames-gamedata"]))
	assert_eq(gd.transport.requests.size(), 0, "nothing goes before the ticket")
	gd.steam.answer()
	assert_eq(gd.transport.paths(), PackedStringArray(["/session/start"]))
	var request: Dictionary = gd.transport.requests[0]
	var body: Dictionary = request.json
	assert_eq(body.ticket, "deadbeef", "the ticket's own bytes, in hex")
	assert_true(request.text.contains("\"app_id\":5207970,") or request.text.contains("\"app_id\":5207970}"),
			"app_id goes as a whole number: " + request.text.left(200))
	assert_eq(body.consent, {"gameplay": true, "hardware": true})
	assert_eq(body.build_id, "26413834")
	assert_eq(body.game_version, "1.0.0", "application/config/version")
	assert_eq(body.platform, OS.get_name().to_lower())
	assert_eq(body.previous_crash, null)
	var keys: Array = body.hardware.keys()
	keys.sort()
	var expected := Hardware.KEYS.duplicate()
	expected.sort()
	assert_eq(keys, expected, "exactly the SPEC's hardware fields")
	assert_eq(body.settings, {"volume": 0.5, "language": "sv", "fullscreen": true})
	assert_eq(gd.status(), "live")
	assert_eq(gd.steam.cancelled, [101], "the ticket is let go once the server has checked it")
	var marker: Variant = JSON.parse_string(FileAccess.get_file_as_string(_file("running.json")))
	assert_eq(marker.session_id, "S1")


func test_without_hardware_consent_the_machine_and_settings_stay_home() -> void:
	var gd := _live(_launch(false))
	var body: Dictionary = gd.transport.requests[0].json
	assert_eq(body.consent, {"gameplay": true, "hardware": false})
	assert_eq(body.hardware, null)
	assert_eq(body.settings, null)
	gd.set_setting("volume", 0.2)
	gd.advance(60.0)
	_drain(gd)
	assert_eq(_sent_of(gd, "setting_changed").size(), 0, "a setting change is no event either")


func test_what_happens_before_the_server_answers_is_kept() -> void:
	var gd := _launch()
	gd.start(APP_ID, {})
	gd.action("plant", {"crop": "carrot", "at": Vector2i(3, 7)})
	gd.advance(1.5)
	gd.action("water", {})
	gd.steam.answer()
	gd.advance(60.0)
	_drain(gd)
	var sent: Array[Dictionary] = gd.transport.to("/events")
	assert_eq(sent.size(), 1)
	var batch: Dictionary = sent[0].json
	assert_eq(batch.session_id, "S1")
	assert_eq(batch.seq, 0.0)
	var actions := _sent_of(gd, "action")
	assert_eq(actions.size(), 2)
	assert_eq(actions[0], {"t": 0.0, "type": "action", "name": "plant", "data": {"crop": "carrot", "at": [3.0, 7.0]}})
	assert_eq(actions[1].t, 1.5)
	assert_true("Content-Encoding: gzip" in sent[0].headers)
	assert_true("Authorization: Bearer T1" in sent[0].headers)
	assert_eq(sent[0].raw.slice(0, 2), PackedByteArray([0x1f, 0x8b]), "the body is gzip")
	assert_eq(_queue_files().size(), 0, "sent and gone")


func test_a_batch_goes_every_upload_interval_and_its_seq_climbs() -> void:
	var gd := _live(_launch())
	gd.action("a", {})
	gd.advance(59.0)
	_drain(gd)
	assert_eq(gd.transport.to("/events").size(), 0, "not before the minute")
	gd.advance(1.0)
	_drain(gd)
	gd.progress({"day": 2, "coins": 10})
	gd.snapshot({"scene": "farm"})
	gd.advance(60.0)
	_drain(gd)
	var sent: Array[Dictionary] = gd.transport.to("/events")
	assert_eq(sent.size(), 2)
	assert_eq(sent[0].json.seq, 0.0)
	assert_eq(sent[1].json.seq, 1.0)
	var later: Array = sent[1].json.events.filter(func(event: Dictionary) -> bool: return event.type in ["progress", "snapshot"])
	assert_eq(later[0], {"t": 60.0, "type": "progress", "data": {"day": 2.0, "coins": 10.0}})
	assert_eq(later[1].type, "snapshot")
	assert_true(sent[1].text.contains("\"seq\":1,"), "seq goes as a whole number")


func test_the_server_sets_the_upload_interval() -> void:
	var gd := _launch()
	gd.transport.replies["/session/start"] = [200, {"ok": true, "session_id": "S9", "token": "T9",
			"opted_out": false, "upload_every_s": 20, "max_batch_kb": 256}]
	_live(gd)
	gd.action("a", {})
	gd.advance(20.0)
	_drain(gd)
	assert_eq(gd.transport.to("/events").size(), 1)


func test_no_batch_holds_more_than_2000_events() -> void:
	var gd := _live(_launch())
	for i in 4500:
		gd.action("step", {"i": i})
	gd.advance(60.0)
	_drain(gd)
	var sizes := []
	var seqs := []
	for request in gd.transport.to("/events"):
		sizes.append(request.json.events.size())
		seqs.append(int(request.json.seq))
	assert_eq(sizes.slice(0, 2), [2000, 2000], "a full batch is cut at 2000")
	assert_true(sizes.size() == 3 and sizes[2] < 2000, "and the rest goes in a third: %s" % [sizes])
	assert_eq(seqs, [0, 1, 2])
	var actions := _sent_of(gd, "action")
	assert_eq(actions.size(), 4500)
	assert_eq(actions[-1].data.i, 4499.0)


func test_values_are_sent_as_the_game_meant_them() -> void:
	var gd := _live(_launch())
	gd.action("odd", {"cell": Vector2i(-1, 4), "where": Vector2(1.23456, 2.0), "name": &"carrot",
			"node": gd, "nan": NAN, "list": [1, "two", Vector2i(3, 3)], "deep": {"a": {"b": 1}}})
	gd.rng("weather", 42)
	gd.advance(60.0)
	_drain(gd)
	assert_eq(_sent_of(gd, "action")[0].data, {"cell": [-1.0, 4.0], "where": [1.23, 2.0], "name": "carrot", "node": null,
			"nan": null, "list": [1.0, "two", [3.0, 3.0]], "deep": {"a": {"b": 1.0}}})
	assert_eq(_sent_of(gd, "rng")[0], {"t": 0.0, "type": "rng", "name": "weather", "data": {"seed": 42.0}})


func test_t_counts_the_seconds_since_start() -> void:
	var gd := _live(_launch())
	gd.advance(12.3456)
	gd.action("a", {})
	gd.advance(60.0)
	_drain(gd)
	assert_eq(_sent_of(gd, "action")[0].t, 12.346)
#endregion


#region When the server is away
func test_offline_it_backs_off_and_keeps_the_batch() -> void:
	var gd := _live(_launch())
	gd.transport.replies["/events"] = 0
	gd.action("a", {})
	gd.advance(60.0)
	_drain(gd)
	assert_eq(gd.transport.to("/events").size(), 1, "tried once")
	assert_eq(_queue_files().size(), 1, "and kept")
	_drain(gd)
	gd.advance(1.0)
	_drain(gd)
	assert_eq(gd.transport.to("/events").size(), 1, "not again at once")
	gd.transport.replies.erase("/events")
	gd.advance(GameDataScript.BACKOFF_FIRST_S * 1.3)
	_drain(gd)
	assert_eq(gd.transport.to("/events").size(), 2, "again once the wait is over")
	assert_eq(_queue_files().size(), 0)


func test_a_refused_batch_is_dropped_and_the_rest_goes_on() -> void:
	var gd := _live(_launch())
	gd.transport.replies["/events"] = 422
	gd.action("a", {})
	gd.advance(60.0)
	_drain(gd)
	assert_eq(_queue_files().size(), 0)
	gd.transport.replies.erase("/events")
	gd.action("b", {})
	gd.advance(60.0)
	_drain(gd)
	assert_eq(gd.transport.to("/events").size(), 2, "no wait after a refusal")


func test_a_token_turned_down_opens_a_new_session() -> void:
	var gd := _live(_launch())
	gd.transport.replies["/events"] = 401
	gd.action("a", {})
	gd.advance(60.0)
	_drain(gd)
	assert_eq(gd.status(), "starting")
	assert_eq(gd.steam.asked.size(), 2, "a fresh ticket for a fresh session")
	gd.transport.replies.erase("/events")
	gd.steam.answer()
	gd.action("b", {})
	gd.advance(60.0)
	_drain(gd)
	var last: Dictionary = gd.transport.to("/events")[-1].json
	assert_eq(last.session_id, "S2")
	assert_eq(last.seq, 0.0, "a new session counts from 0")


func test_a_session_turned_down_stops_the_run() -> void:
	var gd := _launch()
	gd.transport.replies["/session/start"] = [403, {"ok": false, "error": "not_owned"}]
	_live(gd)
	gd.action("a", {})
	gd.advance(60.0)
	_drain(gd)
	assert_eq(gd.status(), "off")
	assert_eq(gd.transport.paths(), PackedStringArray(["/session/start"]))
	assert_false(FileAccess.file_exists(_file("running.json")))
	assert_eq(_queue_files().size(), 0)


func test_a_ticket_steam_never_answers_is_asked_again() -> void:
	var gd := _launch()
	gd.start(APP_ID, {})
	gd.advance(0.0)
	gd.advance(GameDataScript.TICKET_TIMEOUT_S + 0.1)
	gd.advance(GameDataScript.BACKOFF_FIRST_S * 1.3)
	assert_eq(gd.steam.asked.size(), 2)
	gd.steam.answer()
	assert_eq(gd.status(), "live")


func test_a_session_an_offline_run_never_started_goes_on_a_later_launch() -> void:
	var first := _launch()
	first.start(APP_ID, {"volume": 0.25})
	first.advance(0.0)
	first.action("offline", {"n": 1})
	first.advance(60.0)
	first.shutdown()
	assert_eq(first.transport.requests.size(), 0, "the ticket never came")
	var later := _live(_launch(), {"volume": 0.75})
	_drain(later)
	assert_eq(later.steam.asked.size(), 2, "one ticket for this run, one for the last")
	later.steam.answer()
	_drain(later)
	var starts: Array[Dictionary] = later.transport.to("/session/start")
	assert_eq(starts.size(), 2)
	assert_eq(starts[1].json.settings, {"volume": 0.25}, "the old session starts as it was")
	var sent: Array[Dictionary] = later.transport.to("/events")
	assert_true(sent.size() >= 1)
	for request in sent:
		assert_eq(request.json.session_id, "S2", "every batch of the old session goes under its late id")
	assert_eq(_sent_of(later, "action")[0].name, "offline")
	assert_eq(later.transport.to("/session/end")[0].json.session_id, "S2")


func test_a_batch_whose_token_has_expired_is_let_go() -> void:
	var first := _live(_launch())
	first.transport.replies["/events"] = 0
	first.action("a", {})
	first.advance(60.0)
	_drain(first)
	first.shutdown()
	assert_true(_queue_files().size() >= 2, "the batches and the end wait for the next launch")
	now += GameDataScript.TOKEN_LIFE_S + 60.0
	var later := _live(_launch())
	_drain(later)
	assert_eq(later.transport.to("/events").size(), 0)
	assert_eq(_queue_files().size(), 0)


func test_the_queue_never_passes_its_cap() -> void:
	var gd := _launch()
	gd.queue_cap = 4000
	_live(gd)
	gd.transport.replies["/events"] = 0
	var noise := Crypto.new()
	for minute in 12:
		for i in 10:
			gd.action("noise", {"bytes": noise.generate_random_bytes(40).hex_encode()})
		gd.advance(60.0)
	var queue := Queue.new(_file(""))
	assert_true(queue.bytes() <= 4000, "the queue is %d bytes" % queue.bytes())
	assert_true(queue.items().size() < 12, "the oldest went")
	assert_eq(Queue.parse(queue.items()[-1]).seq, 11, "the newest stayed")
#endregion


#region Opting out
func test_a_player_opted_out_on_the_server_leaves_nothing_behind() -> void:
	var gd := _launch()
	gd.transport.replies["/session/start"] = [200, {"ok": true, "opted_out": true}]
	gd.start(APP_ID, {})
	gd.action("before", {})
	gd.advance(0.0)
	gd.steam.answer()
	gd.action("after", {})
	gd.advance(120.0)
	_drain(gd)
	assert_eq(gd.status(), "opted out")
	assert_true(gd.opted_out())
	assert_eq(gd.transport.paths(), PackedStringArray(["/session/start"]))
	assert_eq(_queue_files().size(), 0)
	assert_false(FileAccess.file_exists(_file("running.json")))
	assert_false(FileAccess.file_exists(_file("ring.jsonl")))
	assert_false(FileAccess.file_exists(_file("sessions.json")))


func test_after_an_opt_out_nothing_touches_the_disk_until_the_server_says_in() -> void:
	var first := _launch()
	first.transport.replies["/session/start"] = [200, {"ok": true, "opted_out": true}]
	_live(first)
	var later := _launch()
	later.start(APP_ID, {})
	later.advance(0.0)
	later.action("held", {})
	later.advance(10.0)
	# A minute's cut before the server answers, as a slow answer would see.
	later._cut_batch()
	assert_false(FileAccess.file_exists(_file("running.json")), "no marker yet")
	assert_false(FileAccess.file_exists(_file("ring.jsonl")), "no ring yet")
	assert_false(FileAccess.file_exists(_file("sessions.json")), "no session record yet")
	assert_eq(_queue_files().size(), 0, "no batch yet")
	later.steam.answer()
	assert_eq(later.status(), "live")
	assert_true(FileAccess.file_exists(_file("running.json")))
	later.advance(60.0)
	_drain(later)
	assert_eq(_sent_of(later, "action")[0].name, "held", "what was held goes like the rest")


func test_set_opt_out_deletes_what_is_unsent_and_tells_the_server() -> void:
	var gd := _live(_launch())
	gd.transport.replies["/events"] = 0
	gd.action("a", {})
	gd.advance(60.0)
	_drain(gd)
	assert_eq(_queue_files().size(), 1)
	gd.transport.replies.erase("/events")
	gd.set_opt_out(true)
	assert_true(gd.opted_out())
	assert_eq(gd.status(), "opted out")
	assert_eq(_queue_files().size(), 0)
	assert_false(FileAccess.file_exists(_file("running.json")))
	gd.advance(GameDataScript.BACKOFF_MAX_S)
	gd.steam.answer()
	var told: Dictionary = gd.transport.to("/session/start")[-1].json
	assert_eq(told.consent, {"gameplay": false, "hardware": false})
	assert_eq(told.hardware, null)
	assert_eq(told.settings, null)
	gd.action("b", {})
	gd.advance(120.0)
	_drain(gd)
	assert_eq(gd.transport.to("/events").size(), 1, "only the one tried before")
	# The next launch stays out without asking Steam, since the server has heard.
	var later := _launch()
	later.start(APP_ID, {})
	later.advance(1.0)
	assert_true(later.opted_out())
	assert_eq(later.steam.asked.size(), 0)
	later.set_opt_out(false)
	later.advance(0.0)
	later.steam.answer()
	assert_eq(later.status(), "live")
	assert_eq(later.transport.requests[-1].json.consent, {"gameplay": true, "hardware": true})
#endregion


#region Quitting and crashing
func test_a_clean_quit_sends_the_end_and_leaves_no_marker() -> void:
	var gd := _live(_launch())
	gd.action("a", {})
	gd.advance(30.0)
	gd.action("b", {})
	gd.shutdown()
	assert_false(FileAccess.file_exists(_file("running.json")))
	var paths := []
	for request in gd.transport.quit_requests:
		paths.append(request.path)
	assert_eq(paths, ["/events", "/session/end"])
	var end: Dictionary = gd.transport.quit_requests[1].json
	assert_eq(end.session_id, "S1")
	assert_eq(end.seq, 1.0, "one batch went before it")
	assert_eq(end.playtime_s, 30.0)
	assert_eq(end.summary.actions, 2.0)
	assert_eq(_queue_files().size(), 0)
	gd.shutdown()
	assert_eq(gd.transport.quit_requests.size(), 2, "a second shutdown does nothing")


func test_the_quit_waits_no_longer_than_its_budget() -> void:
	var gd := _live(_launch())
	gd.transport.replies["/events"] = 0
	for minute in 3:
		gd.action("a", {})
		gd.advance(60.0)
	gd.transport.replies.erase("/events")
	# The server answers again: the backoff is over by the quit.
	gd.advance(GameDataScript.BACKOFF_MAX_S)
	gd._clear_backoff()
	gd.transport.quit_cost_ms = 700
	var started: int = gd.transport.ticks
	gd.shutdown()
	var deadlines := []
	for request in gd.transport.quit_requests:
		deadlines.append(request.deadline)
	assert_true(deadlines.size() >= 1 and deadlines.size() <= 3, "%d sent" % deadlines.size())
	for deadline in deadlines:
		assert_eq(deadline, started + GameDataScript.QUIT_BUDGET_MS, "one deadline for the whole quit")
	assert_true(_queue_files().size() >= 1, "what did not make it waits for the next launch")


func test_an_offline_quit_does_not_wait_at_all() -> void:
	var gd := _live(_launch())
	gd.transport.replies["/events"] = 0
	gd.action("a", {})
	gd.advance(60.0)
	_drain(gd)
	gd.shutdown()
	assert_eq(gd.transport.quit_requests.size(), 0)
	var kinds := []
	for item in _queue_files():
		kinds.append(Queue.parse(item).kind)
	assert_true(kinds.count("events") >= 1 and kinds.count("end") == 1, "the batches and the end: %s" % [kinds])


func test_a_crash_is_reported_on_the_next_launch() -> void:
	var first := _live(_launch())
	for i in 700:
		first.action("step", {"i": i})
	first.advance(0.5)  # flushes the ring, as a frame would
	# The crash: no shutdown, the marker stays. Its log is the one Godot set aside.
	DirAccess.make_dir_recursive_absolute(scratch.path_join("logs"))
	var log := FileAccess.open(scratch.path_join("logs/godot2026-11-04T10.00.00.log"), FileAccess.WRITE)
	log.store_string("Godot Engine v4.7\nloading\n" + OS.get_environment("HOME") + "/game/save.json\nhandle_crash: Program crashed with signal 11\n")
	log.close()
	var current := FileAccess.open(scratch.path_join("logs/godot.log"), FileAccess.WRITE)
	current.store_string("this run's own log\n")
	current.close()
	assert_true(FileAccess.file_exists(_file("running.json")))
	var later := _live(_launch())
	var start: Dictionary = later.transport.to("/session/start")[0].json
	assert_eq(start.previous_crash, {"crashed_session_id": "S1", "signal": "SIGSEGV"})
	_drain(later)
	var crashes: Array[Dictionary] = later.transport.to("/crash")
	assert_eq(crashes.size(), 1)
	var crash: Dictionary = crashes[0].json
	assert_true("Authorization: Bearer T2" in crashes[0].headers, "under the new session's token")
	assert_eq(crash.crashed_session_id, "S1")
	assert_eq(crash.signal, "SIGSEGV")
	assert_eq(crash.game_version, "1.0.0")
	assert_eq(crash.last_events.size(), 500)
	assert_eq(crash.last_events[-1].data.i, 699.0)
	assert_true(crash.log_tail.contains("Program crashed with signal 11"))
	assert_false(crash.log_tail.contains("this run's own log"), "the crashed run's log, not this one's")
	if OS.get_environment("HOME").length() >= 3:
		assert_false(crash.log_tail.contains(OS.get_environment("HOME")), "the home folder is scrubbed")
	assert_true(crash.os == Hardware.os_name())
	# The new run has a marker of its own, and the old ring is gone with the report.
	assert_eq(JSON.parse_string(FileAccess.get_file_as_string(_file("running.json"))).session_id, "S2")


func test_a_run_killed_from_outside_is_an_unclean_exit() -> void:
	_live(_launch())
	var later := _live(_launch())
	_drain(later)
	assert_eq(later.transport.to("/crash")[0].json.signal, "unclean exit")
	assert_eq(later.transport.to("/session/start")[0].json.previous_crash.signal, "unclean exit")


func test_a_clean_run_reports_no_crash() -> void:
	_live(_launch()).shutdown()
	var later := _live(_launch())
	_drain(later)
	assert_eq(later.transport.to("/crash").size(), 0)
	assert_eq(later.transport.to("/session/start")[0].json.previous_crash, null)


func test_crash_signals_are_read_off_the_log() -> void:
	assert_eq(GameDataScript.crash_signal("handle_crash: Program crashed with signal 11"), "SIGSEGV")
	assert_eq(GameDataScript.crash_signal("handle_crash: Program crashed with signal 6"), "SIGABRT")
	assert_eq(GameDataScript.crash_signal("crashed with signal 99"), "signal 99")
	assert_eq(GameDataScript.crash_signal("CrashHandlerException: Program crashed"), "crash")
	assert_eq(GameDataScript.crash_signal("all quiet"), "unclean exit")


func test_errors_are_sent_once_and_counted() -> void:
	var gd := _launch()
	gd.catch_errors = true
	_live(gd)
	for i in 3:
		push_error("fourgames_data test error")
	gd.advance(60.0)
	_drain(gd)
	var errors := _events_sent(gd).filter(func(event: Dictionary) -> bool: return event.type == "error")
	assert_eq(errors.size(), 1)
	assert_true(errors[0].data.message.contains("fourgames_data test error"))
	gd.shutdown()
	assert_eq(gd.transport.quit_requests[-1].json.summary.errors, 3.0)
#endregion


#region Hardware
func test_hardware_is_the_listed_fields_and_nothing_that_names_a_machine() -> void:
	var found := Hardware.collect(null)
	var keys: Array = found.keys()
	keys.sort()
	var expected := Hardware.KEYS.duplicate()
	expected.sort()
	assert_eq(keys, expected)
	for key: String in keys:
		for word in ["id", "serial", "mac", "unique", "uuid", "name"]:
			assert_false(key.contains(word), "%s looks like an identifier" % key)
	assert_true(found.cpu_cores is int and found.ram_mb is int and found.refresh_hz is int)
	assert_true(found.screen is Array and found.screen.size() == 2)
	assert_false(found.steam_deck)
	var deck := FakeSteam.new()
	deck.deck = true
	assert_true(Hardware.collect(deck).steam_deck)
#endregion
