extends "res://tests/tools/suite.gd"

## The disk queue (queue.gd): items come back as they went in, oldest first,
## the cap lets the oldest go, and the sessions survive a new launch.

const Queue := preload("res://addons/fourgames_data/queue.gd")


func _gz(text: String) -> PackedByteArray:
	return text.to_utf8_buffer().compress(FileAccess.COMPRESSION_GZIP)


func test_an_item_comes_back_as_it_went_in() -> void:
	var queue := Queue.new(scratch)
	var item := queue.add("events", "abc-1", 7, _gz("\"seq\":7,\"events\":[]"))
	assert_false(item.is_empty())
	assert_eq(queue.read(item), "\"seq\":7,\"events\":[]")
	assert_eq(Queue.parse(item), {"kind": "events", "local": "abc-1", "seq": 7})
	assert_eq(queue.bytes(), FileAccess.get_file_as_bytes(scratch.path_join("queue").path_join(item)).size())


func test_items_are_listed_oldest_first() -> void:
	var queue := Queue.new(scratch)
	var first := queue.add("events", "a", 0, _gz("1"))
	var second := queue.add("crash", "b", 0, _gz("2"))
	var third := queue.add("end", "a", 1, _gz("3"))
	assert_eq(queue.items(), PackedStringArray([first, second, third]))
	queue.remove(second)
	assert_eq(queue.items(), PackedStringArray([first, third]))
	assert_eq(queue.count_for("a"), 2)


func test_a_name_that_is_no_item_is_not_read_as_one() -> void:
	assert_eq(Queue.parse("notes.txt"), {})
	assert_eq(Queue.parse("0000000000000001_a_events.gz"), {})
	assert_eq(Queue.parse("0000000000000001_a_other_000001.gz"), {})
	assert_eq(Queue.parse("x000000000000001_a_events_000001.gz"), {})


func test_past_the_cap_the_oldest_goes_first() -> void:
	var queue := Queue.new(scratch, 1000)
	var made: PackedStringArray = []
	var noise := Crypto.new()
	for i in 10:
		# Random bytes do not compress, so each item is about 300 bytes on disk.
		made.append(queue.add("events", "a", i, noise.generate_random_bytes(300)))
	assert_true(queue.bytes() <= 1000, "queue is %d bytes" % queue.bytes())
	assert_eq(queue.items().size(), 3)
	assert_eq(queue.items()[-1], made[-1], "the newest stays")
	assert_false(FileAccess.file_exists(scratch.path_join("queue").path_join(made[0])), "the oldest is gone from disk")


func test_a_new_launch_finds_the_queue_and_the_sessions() -> void:
	var queue := Queue.new(scratch)
	queue.put_session("a", {"start": "\"app_id\":1", "sid": "S1", "token": "T1", "token_at": 5, "seq": 2, "created": 4})
	var item := queue.add("events", "a", 1, _gz("x"))
	var again := Queue.new(scratch)
	assert_eq(again.items(), PackedStringArray([item]))
	assert_eq(again.bytes(), queue.bytes())
	assert_eq(str(again.session("a").sid), "S1")
	assert_eq(int(again.session("a").seq), 2)
	# A new item still sorts after what is already there.
	var later := again.add("end", "a", 2, _gz("y"))
	assert_eq(again.items(), PackedStringArray([item, later]))


func test_dropping_a_session_takes_its_items_with_it() -> void:
	var queue := Queue.new(scratch)
	queue.put_session("a", {"sid": ""})
	queue.put_session("b", {"sid": ""})
	queue.add("events", "a", 0, _gz("1"))
	var kept := queue.add("events", "b", 0, _gz("2"))
	queue.drop_session("a")
	assert_eq(queue.items(), PackedStringArray([kept]))
	assert_eq(queue.sessions(), PackedStringArray(["b"]))
	assert_eq(Queue.new(scratch).sessions(), PackedStringArray(["b"]))


func test_prune_lets_go_of_what_can_never_be_sent() -> void:
	var queue := Queue.new(scratch)
	var now := 1_000_000.0
	queue.put_session("empty", {"sid": "S1", "token_at": now})
	queue.put_session("stale", {"sid": "", "created": now - 100.0})
	queue.put_session("expired", {"sid": "S2", "token_at": now - 50.0})
	queue.put_session("fine", {"sid": "S3", "token_at": now - 1.0})
	queue.put_session("mine", {"sid": ""})
	for local in ["stale", "expired", "fine"]:
		queue.add("events", local, 0, _gz(local))
	var orphan := queue.add("events", "nobody", 0, _gz("?"))
	queue.prune(now, "mine", 60.0, 10.0)
	var left := Array(queue.sessions())
	left.sort()
	assert_eq(left, ["fine", "mine"])
	assert_eq(queue.count_for("fine"), 1)
	assert_false(orphan in queue.items())


func test_clear_leaves_nothing() -> void:
	var queue := Queue.new(scratch)
	queue.put_session("a", {"sid": ""})
	queue.add("events", "a", 0, _gz("1"))
	queue.clear()
	assert_eq(queue.items().size(), 0)
	assert_eq(queue.bytes(), 0)
	assert_eq(Queue.new(scratch).sessions().size(), 0)
	assert_eq(DirAccess.get_files_at(scratch.path_join("queue")).size(), 0)
