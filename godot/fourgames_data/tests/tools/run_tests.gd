extends Node

## Every suite in res://tests (test_*.gd), run in the project with its
## autoloads up. Headless:
##
##   Godot --headless --path <project> res://tests/tools/run_tests.tscn [-- <suite> [<test>]]
##
## Prints one line per failure and "TESTS: N passed, M failed", and exits 0 when
## nothing failed, 1 otherwise.


func _ready() -> void:
	await get_tree().process_frame
	var args := OS.get_cmdline_user_args()
	var only_suite := args[0] if args.size() > 0 else ""
	var only_test := args[1] if args.size() > 1 else ""
	var passed := 0
	var failed := 0
	var ran: PackedStringArray = []
	for file in DirAccess.get_files_at("res://tests"):
		if not (file.begins_with("test_") and file.ends_with(".gd")):
			continue
		var script := load("res://tests/" + file) as GDScript
		if script == null or not script.can_instantiate():
			print("TESTS: could not load ", file)
			failed += 1
			continue
		var suite: RefCounted = script.new()
		if not only_suite.is_empty() and suite.suite_name() != only_suite:
			continue
		var results: Dictionary = suite.run(only_test)
		passed += int(results.passed)
		failed += int(results.failed)
		ran.append(suite.suite_name())
		for failure: String in results.failures:
			print("  FAIL %s :: %s" % [suite.suite_name(), failure.substr(0, 600)])
	print("TESTS: %d passed, %d failed (%s)" % [passed, failed, ", ".join(ran)])
	get_tree().quit(0 if failed == 0 else 1)
