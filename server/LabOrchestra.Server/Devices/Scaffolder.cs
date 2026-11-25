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

	/// <summary>The templates of a kind: "device" (*.py.tmpl) or "widget" (*.tsx.tmpl).</summary>
	private IEnumerable<Template> Templates(string kind = "device")
	{
		var extension = kind == "widget" ? ".tsx.tmpl" : ".py.tmpl";
		var found = new Dictionary<string, Template>();
		foreach (var (folder, source) in new[] { (Path.Combine(AppContext.BaseDirectory, "templates", kind), "built-in"), (Path.Combine(workspace.Path, "templates", kind), "workspace") })
		{
			if (!Directory.Exists(folder)) continue;
			foreach (var file in Directory.EnumerateFiles(folder, "*" + extension).Order())
			{
				var id = Path.GetFileName(file)[..^extension.Length];
				if (!SnakeCase().IsMatch(id)) continue;
				var meta = Header(file);
				found[id] = new Template(id, meta.GetValueOrDefault("title") ?? id, meta.GetValueOrDefault("description") ?? "", meta.GetValueOrDefault("profile"), source, file);
			}
		}
		return found.Values.OrderBy(t => t.Id == "blank" ? 0 : 1).ThenBy(t => t.Title);
	}

	/// <summary>The first line of a template: <c># template {"title": "...", "description": "...", "profile": "..."}</c> (<c>//</c> in TypeScript).</summary>
	private static Dictionary<string, string> Header(string file)
	{
		var first = File.ReadLines(file).FirstOrDefault() ?? "";
		var start = first.StartsWith("# template ") || first.StartsWith("// template ") ? first.IndexOf('{') : -1;
		if (start < 0) return [];
		try { return JsonSerializer.Deserialize<Dictionary<string, string>>(first[start..]) ?? []; }
		catch (JsonException) { return []; }
	}

	public List<Dictionary<string, object?>> List(string kind = "device") => Templates(kind)
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

	/// <summary>Creates <c>widgets/&lt;name&gt;.tsx</c> from a template (never overwrites), and puts the type file for the SDK next to it so that
	/// editors know what <c>@laborchestra/widget</c> offers. The server builds the widget as soon as it appears.</summary>
	public Task<Dictionary<string, object?>> CreateWidgetAsync(string templateId, string name)
	{
		if (!SnakeCase().IsMatch(name)) throw new ArgumentException($"The name '{name}' must be snake_case: lowercase letters, digits and underscores, starting with a letter (e.g. big_pressure)");
		var template = Templates("widget").FirstOrDefault(t => t.Id == templateId) ?? throw new ArgumentException($"There is no widget template '{templateId}' (templates: {string.Join(", ", Templates("widget").Select(t => t.Id))})");
		var folder = Path.Combine(workspace.Path, "widgets");
		var full = Path.Combine(folder, name + ".tsx");
		if (File.Exists(full) || Directory.Exists(Path.Combine(folder, name))) throw new ArgumentException($"widgets/{name}.tsx exists already; it is never overwritten. Choose another name");

		var text = File.ReadAllText(template.Path);
		text = text[(text.IndexOf('\n') + 1)..];
		var title = char.ToUpper(name[0]) + name[1..].Replace('_', ' ');
		text = text.Replace("{{class_name}}", ClassName(name)).Replace("{{title}}", title).Replace("{{name}}", name).Replace("\r\n", "\n");
		Directory.CreateDirectory(folder);
		using (var stream = new FileStream(full, FileMode.CreateNew, FileAccess.Write))
			stream.Write(new UTF8Encoding(false).GetBytes(text));
		var types = Path.Combine(AppContext.BaseDirectory, "templates", "widget", "laborchestra-widget.d.ts");
		var typesTarget = Path.Combine(folder, "laborchestra-widget.d.ts");
		if (File.Exists(types) && !File.Exists(typesTarget)) File.Copy(types, typesTarget);
		log.LogInformation("Widget {Widget} created from the template {Template}", name, templateId);
		return Task.FromResult<Dictionary<string, object?>>(new() { ["widget"] = $"ws:{name}", ["name"] = name, ["file"] = $"widgets/{name}.tsx", ["path"] = full, ["template"] = templateId });
	}

	private static string ClassName(string id) => string.Concat(id.Split('_').Select(w => char.ToUpper(w[0]) + w[1..]));
}
