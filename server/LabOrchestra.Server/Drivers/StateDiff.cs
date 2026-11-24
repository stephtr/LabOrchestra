namespace LabOrchestra.Server.Drivers;

/// <summary>The patch that turns one state into another ({"set": {"channels.1.pressure": 3e-7}, "del": [...]}), the same rules as the
/// Python side: lists whose length changed are replaced as a whole, a number that changes its type counts as changed.</summary>
public static class StateDiff
{
	public static Dictionary<string, object?>? Diff(Dictionary<string, object?> old, Dictionary<string, object?> now)
	{
		var sets = new Dictionary<string, object?>();
		var dels = new List<object?>();
		Walk(old, now, "");
		if (sets.Count == 0 && dels.Count == 0) return null;
		var patch = new Dictionary<string, object?>();
		if (sets.Count > 0) patch["set"] = sets;
		if (dels.Count > 0) patch["del"] = dels.OrderBy(d => (string)d!, StringComparer.Ordinal).ToList();
		return patch;

		void Walk(object? a, object? b, string path)
		{
			if (a is Dictionary<string, object?> da && b is Dictionary<string, object?> db)
			{
				foreach (var key in da.Keys.Where(k => !db.ContainsKey(k))) dels.Add(path.Length == 0 ? key : $"{path}.{key}");
				foreach (var (key, value) in db)
				{
					var child = path.Length == 0 ? key : $"{path}.{key}";
					if (!da.TryGetValue(key, out var before)) sets[child] = value;
					else Walk(before, value, child);
				}
			}
			else if (a is List<object?> la && b is List<object?> lb && la.Count == lb.Count)
			{
				for (var i = 0; i < la.Count; i++) Walk(la[i], lb[i], $"{path}.{i}");
			}
			else if (!Same(a, b)) sets[path] = b;
		}
	}

	private static bool Same(object? a, object? b)
	{
		if (a is null || b is null) return a is null && b is null;
		if (a is double x && b is double y) return x.Equals(y); // NaN equals NaN here
		if (a is List<object?> or Dictionary<string, object?> || b is List<object?> or Dictionary<string, object?>) return false;
		return a.GetType() == b.GetType() && a.Equals(b);
	}
}
