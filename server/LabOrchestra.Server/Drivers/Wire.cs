using System.Text.Json;
using System.Text.Json.Serialization;

namespace LabOrchestra.Server.Drivers;

/// <summary>How C# options, state and results look on the wire: snake_case names, like everything else.</summary>
public static class Wire
{
	public static readonly JsonSerializerOptions Json = new()
	{
		PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower,
		DictionaryKeyPolicy = JsonNamingPolicy.SnakeCaseLower,
		NumberHandling = JsonNumberHandling.AllowNamedFloatingPointLiterals,
		UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow, // an option that does not exist is an error, not ignored
		Converters = { new JsonStringEnumConverter(JsonNamingPolicy.SnakeCaseLower) },
	};

	public static string Name(string csharpName) => JsonNamingPolicy.SnakeCaseLower.ConvertName(csharpName);
}
