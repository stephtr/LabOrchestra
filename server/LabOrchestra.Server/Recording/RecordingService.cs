using System.Globalization;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using System.Threading.Channels;
using LabOrchestra.Server.Devices;
using LabOrchestra.Server.Events;
using LabOrchestra.Server.Hubs;
using Microsoft.AspNetCore.SignalR;
using YamlDotNet.Core;
using YamlDotNet.Core.Events;
using YamlDotNet.Serialization;

namespace LabOrchestra.Server.Recording;

/// <summary>
/// Recordings and snapshots in one directory:
/// <code>
/// name.yaml           header: format version, start/end, tags, the state of all devices at the start (and the end)
/// name/events.json    JSON array, one event per line: every change of any device with its time and its cause
/// name/device_C1.npy  data streams of devices (written by the devices that have them)
/// </code>
/// The events file is written so that a crash loses at most the last line and the file can be repaired by closing the array.
/// </summary>
public sealed partial class RecordingService(string directory, DeviceRegistry registry, IHubContext<ControlHub> control, ILogger<RecordingService> log)
{
	public const int FormatVersion = 1;
	private static readonly JsonSerializerOptions Json = new() { NumberHandling = JsonNumberHandling.AllowNamedFloatingPointLiterals };
	private static readonly ISerializer Yaml = new SerializerBuilder().DisableAliases().WithTypeConverter(new FloatConverter()).Build();
	private static readonly string ServerVersion = Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "0";

	private sealed class Active
	{
		public required string Name { get; init; }
		public required string Base { get; init; }
		public required DateTimeOffset Start { get; init; }
		public required string By { get; init; }
		public required Dictionary<string, object?> Tags { get; init; }
		public Dictionary<string, Dictionary<string, object?>> Initial { get; set; } = new();
		public Channel<DeviceEvent> Queue { get; } = Channel.CreateUnbounded<DeviceEvent>(new UnboundedChannelOptions { SingleReader = true });
		public Action<DeviceEvent> Listener { get; set; } = _ => { };
		public Session Files { get; set; } = null!;
		public List<LabOrchestra.Sdk.Device> Devices { get; } = [];
		public StreamWriter Events { get; set; } = null!;
		public Task Writer { get; set; } = Task.CompletedTask;
		public long Count;
	}

	/// <summary>The folder of a recording, for devices that write data of their own (an oscilloscope's channels).</summary>
	public sealed class Session(string name, string folder) : LabOrchestra.Sdk.IRecordingSession
	{
		public string Name => name;

		public Stream CreateFile(string fileName)
		{
			if (fileName != Path.GetFileName(fileName) || fileName.StartsWith('.')) throw new ArgumentException($"'{fileName}' is not a file name");
			return new FileStream(Path.Combine(folder, fileName), FileMode.CreateNew, FileAccess.ReadWrite, FileShare.Read);
		}
	}

	private readonly object _gate = new();
	private Active? _active;

	[GeneratedRegex(@"^[A-Za-z0-9][A-Za-z0-9 _.+\-]{0,100}$")]
	private static partial Regex ValidName();

	public Dictionary<string, object?> Status()
	{
		lock (_gate)
			return _active is null
				? new() { ["active"] = false }
				: new() { ["active"] = true, ["name"] = _active.Name, ["start_time"] = Iso(_active.Start), ["elapsed_s"] = Math.Round((DateTimeOffset.UtcNow - _active.Start).TotalSeconds, 1), ["events"] = Interlocked.Read(ref _active.Count), ["tags"] = _active.Tags };
	}

	public Dictionary<string, object?> Start(string name, Dictionary<string, object?>? tags, string by)
	{
		CheckName(name);
		lock (_gate)
		{
			if (_active is not null) throw new InvalidOperationException($"Already recording '{_active.Name}'");
			var basePath = Path.Combine(directory, name);
			if (File.Exists(basePath + ".yaml") || Directory.Exists(basePath)) throw new InvalidOperationException($"'{name}' already exists");
			Directory.CreateDirectory(basePath);
			var active = new Active { Name = name, Base = basePath, Start = DateTimeOffset.UtcNow, By = by, Tags = tags ?? new() };
			active.Events = new StreamWriter(new FileStream(Path.Combine(basePath, "events.json"), FileMode.CreateNew, FileAccess.Write, FileShare.Read), new UTF8Encoding(false)) { NewLine = "\n" };
			active.Events.Write("[\n");
			active.Events.Flush();
			active.Listener = e => active.Queue.Writer.TryWrite(e);
			active.Initial = registry.SnapshotAndSubscribe(active.Listener); // states and events join up without a gap
			WriteHeader(active, null);
			active.Writer = Task.Run(() => WriteEvents(active));
			active.Files = new Session(name, basePath);
			foreach (var (deviceId, device) in registry.LocalDevices())
			{
				try
				{
					device.OnRecordingStartAsync(active.Files).GetAwaiter().GetResult();
					active.Devices.Add(device);
				}
				catch (Exception e) { log.LogError(e, "The device {Device} could not join the recording '{Name}'", deviceId, name); }
			}
			_active = active;
			log.LogInformation("Recording '{Name}' started", name);
		}
		Notify();
		return Status();
	}

	public Dictionary<string, object?> Stop() => Finish(discard: false);

	public Dictionary<string, object?> Abort(bool discard) => Finish(discard);

	private Dictionary<string, object?> Finish(bool discard)
	{
		Active active;
		lock (_gate)
		{
			active = _active ?? throw new InvalidOperationException("Nothing is being recorded");
			_active = null;
		}
		foreach (var device in active.Devices)
		{
			try { device.OnRecordingStopAsync(active.Files).GetAwaiter().GetResult(); }
			catch (Exception e) { log.LogError(e, "The device {Device} could not finish its data of the recording '{Name}'", device.Id, active.Name); }
		}
		registry.Unsubscribe(active.Listener);
		active.Queue.Writer.Complete();
		active.Writer.Wait();
		active.Events.Write("]\n");
		active.Events.Dispose();
		if (discard)
		{
			Directory.Delete(active.Base, recursive: true);
			File.Delete(active.Base + ".yaml");
			log.LogInformation("Recording '{Name}' discarded", active.Name);
		}
		else
		{
			WriteHeader(active, DateTimeOffset.UtcNow);
			log.LogInformation("Recording '{Name}' finished ({Count} events)", active.Name, active.Count);
		}
		Notify();
		return new() { ["name"] = active.Name, ["events"] = active.Count, ["discarded"] = discard };
	}

	/// <summary>A snapshot: the state of all devices now, in one file.</summary>
	public Dictionary<string, object?> Snapshot(string name, Dictionary<string, object?>? tags, string by)
	{
		CheckName(name);
		lock (_gate)
		{
			var file = Path.Combine(directory, name + ".yaml");
			if (File.Exists(file) || Directory.Exists(Path.Combine(directory, name))) throw new InvalidOperationException($"'{name}' already exists");
			Directory.CreateDirectory(directory);
			var now = DateTimeOffset.UtcNow;
			var header = new Dictionary<string, object?>
			{
				["format"] = FormatVersion,
				["kind"] = "snapshot",
				["name"] = name,
				["time"] = Iso(now),
				["taken_by"] = by,
				["tags"] = tags ?? new(),
				["software"] = new Dictionary<string, object?> { ["server"] = ServerVersion },
				["devices"] = Describe(registry.All()),
			};
			WriteYaml(file, header);
		}
		log.LogInformation("Snapshot '{Name}' saved", name);
		return new() { ["name"] = name };
	}

	public List<Dictionary<string, object?>> List(int limit)
	{
		if (!Directory.Exists(directory)) return [];
		var result = new List<Dictionary<string, object?>>();
		foreach (var file in new DirectoryInfo(directory).GetFiles("*.yaml").OrderByDescending(f => f.LastWriteTimeUtc).Take(limit))
		{
			var text = File.ReadAllText(file.FullName);
			string? Field(string key) => Regex.Match(text, $@"^{key}: *(.*)$", RegexOptions.Multiline) is { Success: true } m ? m.Groups[1].Value.Trim().Trim('\'', '"') : null;
			result.Add(new()
			{
				["name"] = Path.GetFileNameWithoutExtension(file.Name),
				["kind"] = Field("kind"),
				["start_time"] = Field("start_time") ?? Field("time"),
				["end_time"] = Field("end_time"),
				["interrupted"] = Field("interrupted") == "true",
			});
		}
		return result;
	}

	/// <summary>Recordings that were open when the server died: close their events file and mark them as interrupted.</summary>
	public void RepairInterrupted()
	{
		if (!Directory.Exists(directory)) return;
		foreach (var file in Directory.GetFiles(directory, "*.yaml"))
		{
			var text = File.ReadAllText(file);
			if (!text.Contains("\nkind: recording") || text.Contains("\nend_time:") || text.Contains("\ninterrupted:")) continue;
			var events = Path.Combine(Path.ChangeExtension(file, null), "events.json");
			double? last = null;
			if (File.Exists(events))
			{
				var content = File.ReadAllText(events);
				var cut = content.LastIndexOf('\n'); // everything after the last newline is an incomplete line
				content = cut >= 0 ? content[..(cut + 1)] : "[\n";
				if (!content.TrimEnd().EndsWith(']'))
				{
					File.WriteAllText(events, content + "]\n");
					content += "]\n";
				}
				var match = Regex.Matches(content, "\"t\":([0-9.eE+-]+)").LastOrDefault();
				if (match is not null) last = double.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture);
			}
			foreach (var npy in Directory.Exists(Path.ChangeExtension(file, null)) ? Directory.GetFiles(Path.ChangeExtension(file, null), "*.npy") : [])
				LabOrchestra.Sdk.NpyFile.RepairAny(npy); // the length in the header is only written when a writer finishes
			File.AppendAllText(file, (text.EndsWith('\n') ? "" : "\n") + "interrupted: true\n" + (last is { } t ? $"duration_s: {t.ToString("R", CultureInfo.InvariantCulture)}\n" : ""));
			log.LogWarning("The recording '{Name}' was interrupted (the server stopped); repaired", Path.GetFileNameWithoutExtension(file));
		}
	}

	// -------------------------------------------------------------------------------------
	private async Task WriteEvents(Active active)
	{
		var reader = active.Queue.Reader;
		try
		{
			while (await reader.WaitToReadAsync())
			{
				while (reader.TryRead(out var e))
				{
					var line = new Dictionary<string, object?>
					{
						["t"] = Math.Round((e.Time - active.Start).TotalSeconds, 6),
						["device"] = e.Device,
						["by"] = e.By,
					};
					foreach (var (key, value) in e.Data) line[key] = value;
					active.Events.Write((Interlocked.Read(ref active.Count) == 0 ? "" : ",") + JsonSerializer.Serialize(line, Json) + "\n");
					Interlocked.Increment(ref active.Count);
				}
				active.Events.Flush(); // to the operating system: survives a crash of the server
			}
		}
		catch (Exception e)
		{
			log.LogError(e, "Writing the events of '{Name}' failed", active.Name);
		}
	}

	private void WriteHeader(Active active, DateTimeOffset? end)
	{
		var header = new Dictionary<string, object?>
		{
			["format"] = FormatVersion,
			["kind"] = "recording",
			["name"] = active.Name,
			["start_time"] = Iso(active.Start),
			["started_by"] = active.By,
			["tags"] = active.Tags,
			["software"] = new Dictionary<string, object?> { ["server"] = ServerVersion },
			["devices"] = Describe(active.Initial),
			["events"] = new Dictionary<string, object?> { ["file"] = $"{active.Name}/events.json" },
		};
		if (end is { } e)
		{
			header["end_time"] = Iso(e);
			header["duration_s"] = Math.Round((e - active.Start).TotalSeconds, 3);
			header["events"] = new Dictionary<string, object?> { ["file"] = $"{active.Name}/events.json", ["count"] = active.Count };
			header["final_state"] = registry.All().ToDictionary(kv => kv.Key, kv => (object?)new Dictionary<string, object?> { ["status"] = kv.Value["status"], ["state"] = kv.Value["state"] });
		}
		WriteYaml(active.Base + ".yaml", header);
	}

	private static Dictionary<string, object?> Describe(Dictionary<string, Dictionary<string, object?>> devices) =>
		devices.ToDictionary(kv => kv.Key, kv => (object?)new Dictionary<string, object?>
		{
			["class"] = (kv.Value["schema"] as Dictionary<string, object?>)?.GetValueOrDefault("class"),
			["laborchestra_version"] = (kv.Value["schema"] as Dictionary<string, object?>)?.GetValueOrDefault("laborchestra_version"),
			["status"] = kv.Value["status"],
			["state"] = kv.Value["state"],
		});

	private static void WriteYaml(string file, Dictionary<string, object?> header)
	{
		var temporary = file + ".tmp";
		File.WriteAllText(temporary, Yaml.Serialize(header));
		File.Move(temporary, file, overwrite: true); // a crash never leaves half a header
	}

	private static string Iso(DateTimeOffset time) => time.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);

	private static void CheckName(string name)
	{
		if (!ValidName().IsMatch(name))
			throw new ArgumentException("A name consists of letters, digits, space and _ . + - (not starting with a space), at most 101 characters");
	}

	private void Notify() => _ = control.Clients.All.SendAsync("recording", Status());

	/// <summary>Writes floats with a decimal point (1.0E-08, not 1E-08) so that YAML 1.1 readers such as PyYAML see numbers.</summary>
	private sealed class FloatConverter : IYamlTypeConverter
	{
		public bool Accepts(Type type) => type == typeof(double) || type == typeof(float);

		public object? ReadYaml(IParser parser, Type type, ObjectDeserializer rootDeserializer) => throw new NotSupportedException();

		public void WriteYaml(IEmitter emitter, object? value, Type type, ObjectSerializer serializer)
		{
			var d = Convert.ToDouble(value, CultureInfo.InvariantCulture);
			string text;
			if (double.IsNaN(d)) text = ".nan";
			else if (double.IsInfinity(d)) text = d > 0 ? ".inf" : "-.inf";
			else
			{
				text = (type == typeof(float) ? ((float)d).ToString("R", CultureInfo.InvariantCulture) : d.ToString("R", CultureInfo.InvariantCulture));
				if (!text.Contains('.')) text = text.Contains('E') ? text.Replace("E", ".0E") : text + ".0";
			}
			emitter.Emit(new Scalar(null, null, text, ScalarStyle.Plain, true, false));
		}
	}
}
