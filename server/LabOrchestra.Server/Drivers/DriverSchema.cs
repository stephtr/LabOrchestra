using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text.Json;
using LabOrchestra.Sdk;

namespace LabOrchestra.Server.Drivers;

public sealed record ActionInfo(string Name, MethodInfo Method, ParameterInfo[] Parameters);

/// <summary>Options, actions and documentation of a driver class, from its properties and methods (the same description a Python
/// device gives: name, type, default, required).</summary>
public static class DriverSchema
{
	public static (Type Options, Type State) TypesOf(Type driver)
	{
		for (var t = driver; t is not null; t = t.BaseType)
			if (t.IsGenericType && t.GetGenericTypeDefinition() == typeof(Device<,>))
				return (t.GetGenericArguments()[0], t.GetGenericArguments()[1]);
		throw new InvalidOperationException($"{driver.Name} must derive from Device<TOptions, TState>");
	}

	public static string TypeName(Type type)
	{
		type = Nullable.GetUnderlyingType(type) ?? type;
		if (type == typeof(bool)) return "bool";
		if (type == typeof(string) || type.IsEnum) return "str";
		if (type == typeof(float) || type == typeof(double) || type == typeof(decimal)) return "float";
		if (type.IsPrimitive && type != typeof(char)) return "int";
		return "json";
	}

	public static IReadOnlyDictionary<string, ActionInfo> Actions(Type driver) =>
		driver.GetMethods(BindingFlags.Public | BindingFlags.Instance)
			.Where(m => m.GetCustomAttribute<ActionAttribute>() is not null)
			.ToDictionary(m => Wire.Name(m.Name), m => new ActionInfo(Wire.Name(m.Name), m, m.GetParameters().Where(p => p.ParameterType != typeof(CancellationToken)).ToArray()));

	public static Dictionary<string, object?> Build(string id, Type driver)
	{
		var (optionsType, _) = TypesOf(driver);
		var defaults = Activator.CreateInstance(optionsType)!;
		var config = optionsType.GetProperties(BindingFlags.Public | BindingFlags.Instance).Where(p => p.CanWrite).Select(p =>
		{
			var required = p.GetCustomAttribute<RequiredMemberAttribute>() is not null;
			return (object?)new Dictionary<string, object?>
			{
				["name"] = Wire.Name(p.Name),
				["type"] = TypeName(p.PropertyType),
				["default"] = required ? null : Plain.FromJson(JsonSerializer.SerializeToElement(p.GetValue(defaults), Wire.Json)),
				["required"] = required,
			};
		}).ToList();
		var actions = Actions(driver).Values.OrderBy(a => a.Name).Select(a => (object?)new Dictionary<string, object?>
		{
			["name"] = a.Name,
			["doc"] = null,
			["params"] = a.Parameters.Select(p => (object?)new Dictionary<string, object?>
			{
				["name"] = Wire.Name(p.Name!),
				["type"] = TypeName(p.ParameterType),
				["default"] = p.HasDefaultValue && p.DefaultValue is not null ? Plain.FromJson(JsonSerializer.SerializeToElement(p.DefaultValue, Wire.Json)) : null,
				["required"] = !p.HasDefaultValue,
			}).ToList(),
		}).ToList();
		return new()
		{
			["id"] = id,
			["class"] = driver.Name,
			["doc"] = driver.GetCustomAttribute<DriverAttribute>()?.Description,
			["laborchestra_version"] = typeof(Device).Assembly.GetName().Version?.ToString(3),
			["config"] = config,
			["actions"] = actions,
			["persist"] = new List<object?>(),
			["streams"] = new List<object?>(),
		};
	}
}
