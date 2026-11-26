using System.Text.Json;

namespace LabOrchestra.Server.Drivers;

/// <summary>Names for the channels of a device, filled in by the server's host for in-process devices (the Python worker does the same for its devices):
/// a driver does nothing for them. The option <c>channel_names</c> of the device in devices.json is a list for the top-level <c>channels</c>, or an
/// object from the path of a channel list to its list; then comes a name the driver set itself, else "Channel &lt;index&gt;".</summary>
public static class ChannelNames
{
	public const string Option = "channel_names";

	public static void Apply(Dictionary<string, object?> state, JsonElement? names)
	{
		var wanted = new Dictionary<string, List<string>>();
		if (names is { ValueKind: JsonValueKind.Array } list) wanted["channels"] = list.EnumerateArray().Select(e => e.ValueKind == JsonValueKind.String ? e.GetString() ?? "" : e.ToString()).ToList();
		else if (names is { ValueKind: JsonValueKind.Object } map)
			foreach (var p in map.EnumerateObject().Where(p => p.Value.ValueKind == JsonValueKind.Array))
				wanted[p.Name] = p.Value.EnumerateArray().Select(e => e.ValueKind == JsonValueKind.String ? e.GetString() ?? "" : e.ToString()).ToList();
		Walk(state, "", wanted);
	}

	private static void Walk(Dictionary<string, object?> node, string path, Dictionary<string, List<string>> wanted)
	{
		foreach (var (key, value) in node.ToList())
		{
			var here = path.Length == 0 ? key : $"{path}.{key}";
			if (key == "channels" && value is List<object?> channels && channels.Count > 0 && channels.All(c => c is Dictionary<string, object?>))
			{
				wanted.TryGetValue(here, out var given);
				for (var i = 0; i < channels.Count; i++)
				{
					var channel = (Dictionary<string, object?>)channels[i]!;
					if (given is not null && i < given.Count && given[i].Length > 0) channel["name"] = given[i];
					else if (channel.GetValueOrDefault("name") is not string { Length: > 0 }) channel["name"] = $"Channel {i}";
				}
			}
			else if (value is Dictionary<string, object?> child) Walk(child, here, wanted);
		}
	}
}
