extends SceneTree

## Writes what "Copy for Claude" says for each session of
## tests/fixtures/summary_sessions.json, as tests/fixtures/summary/<session_id>.txt.
## The server's port of summary.gd (server/gamedata/summary.py) is tested against
## these files, and test_summary checks that summary.gd still writes them. After
## changing summary.gd on purpose, write them again and port the change:
##
##   Godot --headless --path . --script res://tests/tools/summary_golden.gd -- [<folder>]
##
## <folder> (absolute) is where to write; by default the project's own
## tests/fixtures/summary (run from a copy, as the tests are, then copy them back).

const ExportReader := preload("res://game/replay/export_reader.gd")
const Summary := preload("res://game/replay/summary.gd")

const FIXTURE := "res://tests/fixtures/summary_sessions.json"


func _init() -> void:
	var args := OS.get_cmdline_user_args()
	var folder := args[0] if not args.is_empty() else ProjectSettings.globalize_path("res://tests/fixtures/summary")
	var result := ExportReader.open(FIXTURE)
	if not result.ok:
		print("GOLDEN: ", result.error)
		quit(1)
		return
	DirAccess.make_dir_recursive_absolute(folder)
	for session: Dictionary in result.sessions:
		var file := FileAccess.open(folder.path_join(str(session.session_id) + ".txt"), FileAccess.WRITE)
		file.store_string(Summary.build(session))
		file.close()
	print("GOLDEN: %d summaries in %s" % [result.sessions.size(), folder])
	quit(0)
