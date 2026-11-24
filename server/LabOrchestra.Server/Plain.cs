namespace LabOrchestra.Server;

/// <summary>Turns what MessagePack delivers for "object" (Dictionary&lt;object, object&gt;, object[]) into plain, mutable
/// dictionaries with string keys and lists, which can be changed in place, saved as JSON and sent on.</summary>
public static class Plain
{
	/// <summary>A deep copy of a plain tree (events must not change when the state is changed later).</summary>
	public static object? Clone(object? value) => value switch
	{
		Dictionary<string, object?> map => map.ToDictionary(kv => kv.Key, kv => Clone(kv.Value)),
		List<object?> list => list.Select(Clone).ToList(),
		_ => value,
	};

	public static object? From(object? value) => value switch
	{
		IDictionary<object, object?> map => map.ToDictionary(kv => kv.Key.ToString()!, kv => From(kv.Value)),
		IDictionary<string, object?> map => map.ToDictionary(kv => kv.Key, kv => From(kv.Value)),
		string => value,
		System.Collections.IEnumerable items => items.Cast<object?>().Select(From).ToList(),
		_ => value,
	};
}
