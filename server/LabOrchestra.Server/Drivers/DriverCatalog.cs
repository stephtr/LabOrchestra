using System.Reflection;
using System.Runtime.Loader;
using LabOrchestra.Sdk;

namespace LabOrchestra.Server.Drivers;

/// <summary>Loads a plugin assembly in its own context (its own dependencies stay its own), but shares the SDK and the logging
/// abstractions with the server, so that a Device of the plugin is a Device for the server.</summary>
public sealed class PluginLoadContext(string path) : AssemblyLoadContext(Path.GetFileNameWithoutExtension(path))
{
	private readonly AssemblyDependencyResolver _resolver = new(path);

	protected override Assembly? Load(AssemblyName name)
	{
		if (name.Name == "LabOrchestra.Sdk" || name.Name!.StartsWith("Microsoft.Extensions.")) return null; // from the server
		return _resolver.ResolveAssemblyToPath(name) is { } found ? LoadFromAssemblyPath(found) : null;
	}
}

/// <summary>The drivers (C# device classes marked with [Driver]) of the server and of the plugin folders.</summary>
public sealed class DriverCatalog
{
	private readonly Dictionary<string, Type> _drivers = new();

	public DriverCatalog(IEnumerable<string> pluginFolders, ILogger<DriverCatalog> log)
	{
		foreach (var folder in pluginFolders.Where(Directory.Exists))
			foreach (var dll in Directory.GetFiles(folder, "*.dll"))
			{
				try { Add(new PluginLoadContext(dll).LoadFromAssemblyPath(Path.GetFullPath(dll)), log); }
				catch (Exception e) when (e is BadImageFormatException or FileLoadException or ReflectionTypeLoadException)
				{
					log.LogWarning("The plugin {Plugin} could not be loaded: {Message}", Path.GetFileName(dll), e.Message);
				}
			}
		log.LogInformation("{Count} driver(s): {Names}", _drivers.Count, string.Join(", ", _drivers.Keys.Order()));
	}

	private void Add(Assembly assembly, ILogger log)
	{
		foreach (var type in assembly.GetTypes().Where(t => !t.IsAbstract && typeof(Device).IsAssignableFrom(t)))
		{
			if (type.GetCustomAttribute<DriverAttribute>() is not { } attribute) continue;
			if (!_drivers.TryAdd(attribute.Name, type)) log.LogError("Two drivers are called '{Name}' ({First}, {Second}); the second is ignored", attribute.Name, _drivers[attribute.Name].FullName, type.FullName);
		}
	}

	public Type? Find(string name) => _drivers.GetValueOrDefault(name);

	public IReadOnlyList<string> Names => _drivers.Keys.Order().ToList();

	public List<Dictionary<string, object?>> List() => Names.Select(n => new Dictionary<string, object?>
	{
		["driver"] = n,
		["class"] = _drivers[n].Name,
		["doc"] = _drivers[n].GetCustomAttribute<DriverAttribute>()?.Description,
	}).ToList();
}
