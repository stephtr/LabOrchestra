namespace LabOrchestra.Server.Devices;

/// <summary>Applies a state patch ({"set": {"channels.1.pressure": 3e-7}, "del": ["name"]}) to a state made of
/// Dictionary&lt;string, object?&gt; and List&lt;object?&gt; (see <see cref="Plain"/>).</summary>
public static class StatePatch
{
	public static void Apply(Dictionary<string, object?> state, Dictionary<string, object?> patch)
	{
		if (patch.TryGetValue("del", out var deletions) && deletions is List<object?> paths)
		{
			foreach (var path in paths.Select(p => p?.ToString() ?? ""))
			{
				var (parent, key) = Resolve(state, path);
				if (parent is not Dictionary<string, object?> map || !map.Remove(key))
					throw new InvalidOperationException($"Nothing to delete at '{path}'");
			}
		}
		if (patch.TryGetValue("set", out var assignments) && assignments is Dictionary<string, object?> sets)
		{
			foreach (var (path, value) in sets)
			{
				var (parent, key) = Resolve(state, path);
				switch (parent)
				{
					case Dictionary<string, object?> map:
						map[key] = value;
						break;
					case List<object?> list when int.TryParse(key, out var index) && index >= 0 && index < list.Count:
						list[index] = value;
						break;
					default:
						throw new InvalidOperationException($"Cannot set '{path}'");
				}
			}
		}
	}

	private static (object? Parent, string Key) Resolve(object? root, string path)
	{
		var parts = path.Split('.');
		var node = root;
		foreach (var part in parts[..^1])
		{
			node = node switch
			{
				Dictionary<string, object?> map when map.TryGetValue(part, out var child) => child,
				List<object?> list when int.TryParse(part, out var i) && i >= 0 && i < list.Count => list[i],
				_ => throw new InvalidOperationException($"Path '{path}' does not exist"),
			};
		}
		return (node, parts[^1]);
	}
}
