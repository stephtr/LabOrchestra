namespace LabOrchestra.Sdk;

/// <summary>One frame of a stream: a small description and the data (float32 samples or bytes). <c>Sequence</c> grows with every new
/// frame; the server asks for a frame only when it can send one.</summary>
public sealed record StreamFrame(long Sequence, Dictionary<string, object?> Meta, byte[] Data);

/// <summary>
/// A stream a device offers to displays. The server asks for a frame <b>per client, when that client can take one</b>
/// (it has acknowledged the previous ones), so a slow client gets fewer frames of the same freshness instead of a growing queue.
/// </summary>
public interface IStreamSource
{
	/// <param name="parameters">What this client asked for (e.g. the range of the x axis); an empty dictionary for the defaults.</param>
	/// <param name="afterSequence">The sequence number of the last frame this client got; return null if there is nothing newer.</param>
	StreamFrame? Render(IReadOnlyDictionary<string, object?> parameters, long afterSequence);
}

public sealed class StreamRegistry
{
	private readonly Dictionary<string, IStreamSource> _sources = new();

	public void Register(string name, IStreamSource source)
	{
		lock (_sources) _sources[name] = source;
	}

	public IStreamSource? Find(string name)
	{
		lock (_sources) return _sources.GetValueOrDefault(name);
	}

	public IReadOnlyList<string> Names()
	{
		lock (_sources) return _sources.Keys.Order().ToList();
	}
}

/// <summary>What a device needs from a recording that is running: a place for its own data files (next to events.json).</summary>
public interface IRecordingSession
{
	string Name { get; }
	/// <summary>Opens a new file inside the recording, e.g. "het_C1.npy".</summary>
	Stream CreateFile(string fileName);
}
