extends RefCounted

## What a session says about the machine it runs on, when the player lets it
## (consent.hardware): enough to tell which machines a bug or a slow frame lives
## on, and nothing that tells one machine -- or one person -- from another. No
## serial number, MAC address, device id or OS.get_unique_id(), on purpose, and
## `KEYS` is the whole list (a test holds collect() to it).

## Exactly the fields of session/start's "hardware" (SPEC.md).
const KEYS: Array[String] = ["os", "cpu", "cpu_cores", "ram_mb", "gpu", "gpu_driver",
		"renderer", "screen", "refresh_hz", "steam_deck"]
const MB := 1024 * 1024


## The machine, for session/start. `steam` is the GodotSteam singleton or null.
static func collect(steam: Object) -> Dictionary:
	var screen := DisplayServer.window_get_current_screen()
	var size := DisplayServer.screen_get_size(screen)
	var ram := int(OS.get_memory_info().get("physical", -1))
	var driver := OS.get_video_adapter_driver_info()
	@warning_ignore("integer_division")
	return {
		"os": os_name(),
		"cpu": OS.get_processor_name(),
		"cpu_cores": OS.get_processor_count(),
		"ram_mb": ram / MB if ram > 0 else 0,
		"gpu": RenderingServer.get_video_adapter_name(),
		"gpu_driver": " ".join(driver).strip_edges(),
		"renderer": RenderingServer.get_current_rendering_method(),
		"screen": [size.x, size.y],
		"refresh_hz": maxi(roundi(DisplayServer.screen_get_refresh_rate(screen)), 0),
		"steam_deck": is_steam_deck(steam),
	}


## "Windows 11 (24H2)", "macOS Tahoe (26.6.2)", "SteamOS 3.7.13": the system and
## the release it calls itself, with the distribution's own name on Linux.
static func os_name() -> String:
	var system := OS.get_name()
	if system == "Linux" or system == "FreeBSD":
		var distribution := OS.get_distribution_name()
		if not distribution.is_empty():
			system = distribution
	var release := OS.get_version_alias()
	if release.is_empty():
		release = OS.get_version()
	return ("%s %s" % [system, release]).strip_edges()


## session/start's "platform": windows, macos, linux.
static func platform() -> String:
	return OS.get_name().to_lower()


## Steam's own answer where GodotSteam has it, else what Steam sets for every
## game it launches on a Deck (SteamDeck=1, in Game and Desktop mode alike).
## GodotSteam 4.22 has no isSteamRunningOnSteamDeck(), and its
## isRunningOnSteamHardware() is true on any Steam hardware, not the Deck alone.
static func is_steam_deck(steam: Object) -> bool:
	if steam != null and steam.has_method(&"isSteamRunningOnSteamDeck"):
		return bool(steam.call(&"isSteamRunningOnSteamDeck"))
	return OS.get_environment("SteamDeck") == "1"
