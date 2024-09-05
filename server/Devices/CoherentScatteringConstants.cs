using System.Reflection;
using System.Text.Json;

public class CoherentScatteringConstantsState
{
	public double CavityDetuningGeneratorOffset { get; set; } = 0;
	public float TweezerQWPOffset { get; set; } = 0;
	public float TweezerHWPOffset { get; set; } = 0;
}

public class CoherentScatteringConstantsDevice : DeviceHandlerBase<CoherentScatteringConstantsState>
{
	private Dictionary<string, PropertyInfo> StateProperties = typeof(CoherentScatteringConstantsState).GetProperties().ToDictionary(p => p.Name.ToLowerInvariant());

	public void Set(string variableName, object value)
	{
		var property = StateProperties[variableName.ToLowerInvariant()];
		if (property == null)
			throw new ArgumentException($"Variable {variableName} not found");
		property.SetValue(State, value);
	}

	public override object? GetSettings()
	{
		return State;
	}

	public override void LoadSettings(JsonElement settings)
	{
		var newState = JsonSerializer.Deserialize<CoherentScatteringConstantsState>(settings.GetRawText());
		if (newState != null)
		{
			State = newState;
		}
	}
}
