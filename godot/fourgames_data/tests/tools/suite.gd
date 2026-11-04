extends RefCounted

## What every suite in res://tests needs, written once: the asserts, a scratch
## folder of the test's own, and running its test_* methods in order. Kept tiny
## on purpose, so the addon's tests run in any project it is copied to with
## nothing else installed. Suites extend this by path:
##
##   extends "res://tests/tools/suite.gd"

## The test running now, and where it may write: user://_test_<pid>/<test>/.
var test_name := ""
var scratch := ""

var _failures: PackedStringArray = []
var _asserts := 0


func suite_name() -> String:
	return get_script().resource_path.get_file().get_basename().trim_prefix("test_")


func setup() -> void:
	pass


func teardown() -> void:
	pass


#region Asserts
func assert_true(condition: bool, message := "") -> void:
	_asserts += 1
	if not condition:
		_failures.append("%s: expected true. %s" % [test_name, message])


func assert_false(condition: bool, message := "") -> void:
	_asserts += 1
	if condition:
		_failures.append("%s: expected false. %s" % [test_name, message])


func assert_eq(actual: Variant, expected: Variant, message := "") -> void:
	_asserts += 1
	if typeof(actual) != typeof(expected) or actual != expected:
		_failures.append("%s: expected %s (%s), got %s (%s). %s" % [test_name, var_to_str(expected),
				type_string(typeof(expected)), var_to_str(actual), type_string(typeof(actual)), message])
#endregion


#region Running
## Every test_* method, each with a fresh scratch folder. {passed, failed, failures}.
func run(only_test := "") -> Dictionary:
	var passed := 0
	var failed := 0
	var all_failures: PackedStringArray = []
	for method in get_script().get_script_method_list():
		var method_name: String = method.name
		if not method_name.begins_with("test_") or (not only_test.is_empty() and method_name != only_test):
			continue
		test_name = method_name
		scratch = "user://_test_%d/%s_%s" % [OS.get_process_id(), suite_name(), method_name]
		wipe(scratch)
		DirAccess.make_dir_recursive_absolute(scratch)
		_failures.clear()
		_asserts = 0
		setup()
		call(method_name)
		teardown()
		if _asserts == 0:
			_failures.append("%s: made no assertion" % method_name)
		if _failures.is_empty():
			passed += 1
		else:
			failed += 1
			all_failures.append_array(_failures)
		wipe(scratch)
	wipe("user://_test_%d" % OS.get_process_id())
	return {"passed": passed, "failed": failed, "failures": all_failures}


## A folder and everything in it, gone.
static func wipe(path: String) -> void:
	if not DirAccess.dir_exists_absolute(path):
		return
	for folder in DirAccess.get_directories_at(path):
		wipe(path.path_join(folder))
	for file in DirAccess.get_files_at(path):
		DirAccess.remove_absolute(path.path_join(file))
	DirAccess.remove_absolute(path)
#endregion
