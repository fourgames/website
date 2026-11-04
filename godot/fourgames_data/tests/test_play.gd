extends "res://tests/tools/game_data_suite.gd"

## The rest of what the plugin records by itself: where the player is for the
## heatmaps and where they die, the Steam overlay, Steam's side of the session,
## achievements, and the time spent on each screen and the interface events.


#region Positions and deaths
func test_the_player_s_position_is_sampled_when_they_move() -> void:
	var gd := _live(_launch())
	var player := _stage(Node2D.new()) as Node2D
	player.position = Vector2(10, 20)
	gd.scene_changed("res://farm.tscn", 0.0)
	gd.track_player(player)
	gd.advance(3.0)
	player.position += Vector2(0.5, 0.0)
	gd.advance(3.0)
	player.position = Vector2(40, 25)
	player.rotation = 0.5
	gd.advance(3.0)
	gd.advance(60.0)
	_drain(gd)
	var positions := _sent_of(gd, "position")
	assert_eq(positions.size(), 2, "standing still, or a nudge under a pixel, sends nothing")
	assert_eq(positions[0].data, {"scene": "res://farm.tscn", "x": 10.0, "y": 20.0, "rot": 0.0})
	assert_eq(positions[1].data, {"scene": "res://farm.tscn", "x": 40.0, "y": 25.0, "rot": 0.5})


func test_how_often_is_the_game_s_and_idle_players_are_not_followed() -> void:
	var gd := _live(_launch())
	gd.position_every_s = 1.0
	var player := _stage(Node2D.new()) as Node2D
	gd.track_player(player)
	for i in 5:
		player.position.x += 10.0
		gd.advance(1.0)
	assert_eq(gd._last_position.x, 50.0, "once a second")
	gd.advance(61.0)
	player.position.x += 10.0
	gd.advance(1.0)
	assert_eq(gd._last_position.x, 50.0, "not while idle")
	gd.note_input(GameDataScript.KEYBOARD_MOUSE, 0)
	gd.advance(1.0)
	assert_eq(gd._last_position.x, 60.0, "again once they are back")


func test_in_3d_a_position_has_its_height_and_its_turn() -> void:
	var gd := _live(_launch())
	var player := _stage(Node3D.new()) as Node3D
	player.position = Vector3(1.5, 0.25, -3.0)
	player.rotation.y = 1.25
	gd.track_player(player)
	player.position.z += 0.01
	gd.advance(3.0)
	gd.advance(60.0)
	_drain(gd)
	var positions := _sent_of(gd, "position")
	assert_eq(positions.size(), 1, "a centimetre is no move")
	assert_eq(positions[0].data, {"scene": "", "x": 1.5, "y": 0.25, "z": -3.0, "yaw": 1.25})


func test_a_death_says_where() -> void:
	var gd := _live(_launch())
	var player := _stage(Node2D.new()) as Node2D
	player.position = Vector2(64, 32)
	gd.scene_changed("res://cave.tscn", 0.0)
	gd.track_player(player)
	gd.death("fell", {"height": 12, "cause": "not this one"})
	gd.track_player(null)
	gd.death()
	gd.advance(60.0)
	_drain(gd)
	var deaths := _sent_of(gd, "death")
	assert_eq(deaths[0].data, {"height": 12.0, "cause": "fell", "scene": "res://cave.tscn", "x": 64.0, "y": 32.0, "rot": 0.0})
	assert_eq(deaths[1].data, {"cause": "", "scene": "res://cave.tscn"}, "untracked, it still counts")


func test_a_freed_player_is_no_trouble() -> void:
	var gd := _live(_launch())
	var player := Node2D.new()
	_stage(player)
	gd.track_player(player)
	player.free()
	gd.advance(3.0)
	gd.death("gone")
	gd.advance(60.0)
	_drain(gd)
	assert_eq(_sent_of(gd, "position").size(), 1, "only the one from before")
	assert_false(_sent_of(gd, "death")[0].data.has("x"))


func test_the_quit_point_has_the_last_position() -> void:
	var gd := _live(_launch())
	var player := _stage(Node2D.new()) as Node2D
	player.position = Vector2(5, 6)
	gd.track_player(player)
	player.position = Vector2(7, 8)
	gd.shutdown()
	assert_eq(gd.transport.to("/session/end")[0].json.summary.last_position,
			{"scene": "", "x": 7.0, "y": 8.0, "rot": 0.0}, "where they stood as the game quit")
	var crashed := _live(_launch())
	crashed.track_player(player)
	player.position = Vector2(90, 91)
	crashed.advance(3.0)
	var later := _live(_launch())
	_drain(later)
	assert_eq(later.transport.to("/crash")[0].json.quit_point.last_position,
			{"scene": "", "x": 90.0, "y": 91.0, "rot": 0.0}, "the ring's last position")
#endregion


#region Steam
func test_the_overlay_says_only_that_it_opened_and_where() -> void:
	var gd := _live(_launch())
	gd.scene_changed("res://shop.tscn", 0.0)
	gd.screen("shop")
	gd.steam.overlay_toggled.emit(true, true, APP_ID)
	gd.steam.overlay_toggled.emit(false, true, APP_ID)
	gd.advance(60.0)
	_drain(gd)
	var overlay := _sent_of(gd, "overlay")
	assert_eq(overlay[0].data, {"open": true, "scene": "res://shop.tscn", "screen": "shop"})
	assert_eq(overlay[1].data.open, false)


func test_steam_s_side_of_the_session_goes_once() -> void:
	var gd := _launch()
	gd.steam.big_picture = true
	_live(gd)
	gd.advance(60.0)
	_drain(gd)
	var expected := {"ui_language": "swedish", "game_language": "english", "locale": TranslationServer.get_locale(),
			"family_shared": false, "remote_play": false, "big_picture": true}
	assert_eq(gd.transport.to("/session/start")[0].json.steam, expected)
	var steam := _sent_of(gd, "steam")
	assert_eq(steam.size(), 1)
	assert_eq(steam[0].data, expected)
	gd.steam.remote_sessions = 1
	gd.steam.remote_play_session_connected.emit(7)
	gd.advance(60.0)
	_drain(gd)
	assert_eq(_sent_of(gd, "steam")[-1].data, {"remote_play": true})


func test_family_sharing_is_a_yes_and_never_whose() -> void:
	var gd := _launch()
	gd.steam.owner_id = 76561198000000999
	_live(gd)
	var start: Dictionary = gd.transport.to("/session/start")[0]
	assert_eq(start.json.steam.family_shared, true)
	gd.shutdown()
	for request in gd.transport.requests:
		assert_false(request.text.contains("76561198000000999"), "the owner's id goes nowhere")
		assert_false(request.text.contains("76561198000000001"), "nor the player's")


func test_achievements_steam_stored_and_the_game_s_own_count_once() -> void:
	var gd := _live(_launch())
	gd.scene_changed("res://level2.tscn", 0.0)
	gd.advance(42.0)
	gd.steam.user_achievement_stored.emit(APP_ID, false, "FIRST_HARVEST", 0, 0)
	gd.steam.user_achievement_stored.emit(APP_ID, false, "HARVEST_100", 30, 100)
	gd.achievement("FIRST_HARVEST")
	gd.achievement("ALL_FIELDS")
	gd.advance(60.0)
	_drain(gd)
	var achieved := _sent_of(gd, "achievement")
	assert_eq(achieved.size(), 2, "progress is no unlock, and a repeat is no second one")
	assert_eq(achieved[0].data, {"name": "FIRST_HARVEST", "scene": "res://level2.tscn", "playtime_s": 42.0})
	assert_eq(achieved[1].data.name, "ALL_FIELDS")
#endregion


#region The interface
func test_each_screen_s_time_is_kept() -> void:
	var gd := _live(_launch())
	gd.screen("main_menu")
	gd.advance(12.5)
	gd.screen("options")
	gd.advance(3.0)
	gd.ui("tutorial_skipped", {"step": 2})
	gd.shutdown()
	var ui: Array = []
	for request in gd.transport.requests:
		if request.path == "/events":
			ui.append_array(request.json.events.filter(func(event: Dictionary) -> bool: return event.type == "ui"))
	assert_eq(ui[0], {"t": 12.5, "type": "ui", "name": "screen", "data": {"screen": "main_menu", "seconds": 12.5}})
	assert_eq(ui[1].name, "tutorial_skipped")
	assert_eq(ui[1].data, {"step": 2.0, "screen": "options"})
	assert_eq(ui[2].data, {"screen": "options", "seconds": 3.0}, "the last screen's time goes at quit")
#endregion
