extends "res://tests/tools/suite.gd"

## The ring file (ring.gd): the last 500 events survive any number of cuts, a
## crash's torn last line is skipped, and a new run starts with an empty ring.

const Ring := preload("res://addons/fourgames_data/ring.gd")


func _line(i: int) -> String:
	return JSON.stringify({"t": i, "type": "action", "name": "n%d" % i})


func test_it_keeps_the_last_500_through_its_cuts() -> void:
	var path := scratch.path_join("ring.jsonl")
	var ring := Ring.new(path, 500)
	ring.open()
	for i in 1234:
		ring.add(_line(i))
	ring.flush()
	var on_disk := FileAccess.get_file_as_string(path).split("\n", false).size()
	assert_true(on_disk >= 500 and on_disk < 1000, "the file holds %d lines" % on_disk)
	var last := Ring.read_last(path, 500)
	assert_eq(last.size(), 500)
	assert_eq(last[0], _line(734))
	assert_eq(last[-1], _line(1233))
	assert_eq(ring.lines(), last)
	ring.close()


func test_a_line_torn_by_the_crash_is_skipped() -> void:
	var path := scratch.path_join("ring.jsonl")
	var ring := Ring.new(path, 500)
	ring.open()
	for i in 3:
		ring.add(_line(i))
	ring.flush()
	ring.close()
	var file := FileAccess.open(path, FileAccess.READ_WRITE)
	file.seek_end()
	file.store_string("{\"t\": 3, \"type\": \"act")
	file.close()
	assert_eq(Ring.read_last(path, 500), PackedStringArray([_line(0), _line(1), _line(2)]))


func test_what_is_flushed_is_on_disk_before_the_file_closes() -> void:
	var path := scratch.path_join("ring.jsonl")
	var ring := Ring.new(path, 500)
	ring.open()
	ring.add(_line(1))
	ring.flush()
	# Still open, as at a crash: the line must already be readable.
	assert_eq(Ring.read_last(path, 500), PackedStringArray([_line(1)]))
	ring.close()


func test_a_new_run_starts_with_an_empty_ring() -> void:
	var path := scratch.path_join("ring.jsonl")
	var ring := Ring.new(path, 500)
	ring.open()
	ring.add(_line(1))
	ring.close()
	ring.open()
	ring.flush()
	assert_eq(Ring.read_last(path, 500).size(), 0)
	assert_eq(ring.lines().size(), 0)
	ring.remove()
	assert_false(FileAccess.file_exists(path))
	assert_eq(Ring.read_last(path, 500).size(), 0)
