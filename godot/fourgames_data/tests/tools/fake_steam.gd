extends RefCounted

## Stands in for the GodotSteam singleton: the four calls and the one signal the
## plugin uses, with the ticket answered when the test says so (answer()), or a
## frame later on its own (`auto_answer`) for a run with real frames.

signal get_ticket_for_web_api(auth_ticket: int, result: int, ticket_size: int, ticket_buffer: PackedByteArray)

## What a ticket comes back as: four bytes of ticket in a longer buffer, as Steam's is.
const TICKET := [0xde, 0xad, 0xbe, 0xef, 0, 0, 0, 0]

var auto_answer := false
var deck := false
## The game's DLC, app id -> owned.
var dlc := {}
## Every identity a ticket was asked for, and every handle cancelled.
var asked: PackedStringArray = []
var cancelled: Array[int] = []
## The handle of the last ticket asked for and not answered yet; 0 for none.
var pending := 0
var _next := 100


func getAuthTicketForWebApi(identity: String) -> int:
	asked.append(identity)
	_next += 1
	pending = _next
	if auto_answer:
		answer.call_deferred()
	return _next


## Steam's callback for the pending ticket: OK (1) or another result.
func answer(result := 1) -> void:
	var handle := pending
	pending = 0
	get_ticket_for_web_api.emit(handle, result, 4, PackedByteArray(TICKET))


func cancelAuthTicket(handle: int) -> void:
	cancelled.append(handle)


func getAppBuildId() -> int:
	return 26413834


func isSteamRunningOnSteamDeck() -> bool:
	return deck


func getDLCCount() -> int:
	return dlc.size()


func getDLCDataByIndex(index: int) -> Dictionary:
	return {"id": dlc.keys()[index], "available": true, "name": "DLC %d" % index}


func isSubscribedApp(app_id: int) -> bool:
	return bool(dlc.get(app_id, false))
