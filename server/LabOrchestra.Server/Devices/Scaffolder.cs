using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace LabOrchestra.Server.Devices;

/// <summary>"New device": makes a device file from a template, registers it in devices.json and starts it (simulated, see the templates).
/// Templates are <c>templates/device/&lt;id&gt;.py.tmpl</c> next to the server and in the workspace (the workspace's win by id). One
/// implementation for the UI, scripts and later the CLI and MCP. It never overwrites a file.</summary>
public sealed partial class Scaffolder(Workspace workspace, DeviceCatalog catalog, ILogger<Scaffolder> log)
{
	public static readonly string[] Connections = ["none", "serial", "tcp", "visa"];

	private static readonly Dictionary<string, string> ConnectionOptions = new()
	{
		["none"] = "",
		["serial"] = "    port: str = \"\"  # serial port, e.g. \"COM3\" or \"/dev/ttyUSB0\"\n    baudrate: int = 9600\n",
		["tcp"] = "    host: str = \"\"  # address of the instrument\n    tcp_port: int = 5025\n",
		["visa"] = "    resource: str = \"\"  # VISA resource name, e.g. \"TCPIP0::192.168.0.10::INSTR\"\n",
	};

	[GeneratedRegex("^[a-z][a-z0-9]*(_[a-z0-9]+)*$")]
	private static partial Regex SnakeCase();

	private sealed record Template(string Id, string Title, string Description, string? Profile, string Source, string Path);

	private IEnumerable<Template> Templates()
	{
		var found = new Dictionary<string, Template>();
		foreach (var (folder, source) in new[] { (Path.Combine(AppContext.BaseDirectory, "templates", "device"), "built-in"), (Path.Combine(workspace.Path, "templates", "device"), "workspace") })
		{
			if (!Directory.Exists(folder)) continue;
			foreach (var file in Directory.EnumerateFiles(folder, "*.py.tmpl").Order())
			{
				var id = Path.GetFileName(file)[..^".py.tmpl".Length];
				if (!SnakeCase().IsMatch(id)) continue;
				var meta = Header(file);
				found[id] = new Template(id, meta.GetValueOrDefault("title") ?? id, meta.GetValueOrDefault("description") ?? "", meta.GetValueOrDefault("profile"), source, file);
			}
		}
		return found.Values.OrderBy(t => t.Id == "blank" ? 0 : 1).ThenBy(t => t.Title);
	}

	/// <summary>The first line of a template: <c># template {"title": "...", "description": "...", "profile": "..."}</c>.</summary>
	private static Dictionary<string, string> Header(string file)
	{
		var first = File.ReadLines(file).FirstOrDefault() ?? "";
		if (!first.StartsWith("# template ")) return [];
		try { return JsonSerializer.Deserialize<Dictionary<string, string>>(first["# template ".Length..]) ?? []; }
		catch (JsonException) { return []; }
	}

	public List<Dictionary<string, object?>> List() => Templates()
		.Select(t => new Dictionary<string, object?> { ["id"] = t.Id, ["title"] = t.Title, ["description"] = t.Description, ["profile"] = t.Profile, ["source"] = t.Source })
		.ToList();

	/// <summary>Creates <c>devices/&lt;id&gt;.py</c> and the entry in devices.json; the device starts at once. Returns what was made.</summary>
	public async Task<Dictionary<string, object?>> CreateAsync(string templateId, string id, string connection, string? python)
	{
		if (!SnakeCase().IsMatch(id)) throw new ArgumentException($"The name '{id}' must be snake_case: lowercase letters, digits and underscores, starting with a letter (e.g. vacuum_pump)");
		if (!ConnectionOptions.TryGetValue(connection, out var options)) throw new ArgumentException($"Unknown connection '{connection}' (one of {string.Join(", ", Connections)})");
		var template = Templates().FirstOrDefault(t => t.Id == templateId) ?? throw new ArgumentException($"There is no template '{templateId}' (templates: {string.Join(", ", Templates().Select(t => t.Id))})");
		if (workspace.Devices.ContainsKey(id)) throw new ArgumentException($"There is already a device '{id}'");

		var relative = $"devices/{id}.py";
		var full = Path.Combine(workspace.Path, "devices", id + ".py");
		if (File.Exists(full)) throw new ArgumentException($"{relative} exists already; it is never overwritten. Choose another name, or add it as a device on the Devices page");

		var title = char.ToUpper(id[0]) + id[1..].Replace('_', ' ');
		var text = File.ReadAllText(template.Path);
		text = text[(text.IndexOf('\n') + 1)..]; // the header line is not part of the device
		text = text.Replace("{{options}}", options.TrimEnd('\n')).Replace("{{class_name}}", ClassName(id)).Replace("{{title}}", title).Replace("{{name}}", id);
		text = Regex.Replace(text, @"\n{3,}(?=    (simulate|poll_s|channel_count))", "\n\n"); // no empty option block: no blank-line gap

		Directory.CreateDirectory(Path.GetDirectoryName(full)!);
		await using (var stream = new FileStream(full, FileMode.CreateNew, FileAccess.Write)) // CreateNew: never overwrites, even in a race
			await stream.WriteAsync(new UTF8Encoding(false).GetBytes(text.Replace("\r\n", "\n")));
		try
		{
			await catalog.AddAsync(id, new DeviceConfig(File: relative, Python: string.IsNullOrWhiteSpace(python) ? null : python, Description: $"New {template.Title.ToLowerInvariant()}, running on simulated values until its code is written"));
		}
		catch
		{
			File.Delete(full); // nothing half-made is left behind
			throw;
		}
		log.LogInformation("Device {Device} created from the template {Template} ({File})", id, templateId, relative);
		return new() { ["device"] = id, ["file"] = relative, ["path"] = full, ["template"] = templateId };
	}

	private static string ClassName(string id) => string.Concat(id.Split('_').Select(w => char.ToUpper(w[0]) + w[1..]));
}
