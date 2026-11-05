extends SceneTree

## The replay viewer's "Copy for Claude" text, printed, for a download on disk:
##
##   Godot --headless --path . --script res://tests/tools/summarise.gd -- <fourgames-data.zip> [<n>]
##
## <n> picks the session (0, the default, is the newest; the list is printed
## first). Exits 1 when the file can't be read.

const ExportReader := preload("res://game/replay/export_reader.gd")
const Summary := preload("res://game/replay/summary.gd")


func _init() -> void:
	var args := OS.get_cmdline_user_args()
	if args.is_empty():
		print("usage: ... --script res://tests/tools/summarise.gd -- <download.zip> [<session>]")
		quit(1)
		return
	var result := ExportReader.open(args[0])
	if not result.ok:
		print("SUMMARY: ", result.error)
		quit(1)
		return
	for i in result.sessions.size():
		print("SESSION %d: %s" % [i, ExportReader.label(result.sessions[i])])
	var pick := int(args[1]) if args.size() > 1 else 0
	if pick < 0 or pick >= result.sessions.size():
		print("SUMMARY: no session %d" % pick)
		quit(1)
		return
	print(Summary.build(result.sessions[pick]))
	quit(0)
