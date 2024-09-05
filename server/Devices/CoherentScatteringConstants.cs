using System.Text.Json;

public class CoherentScatteringConstantsState
{
	public double CavityDetuningGeneratorOffset { get; set; } = 0;
}

public class CoherentScatteringConstantsDevice : DeviceHandlerBase<CoherentScatteringConstantsState>
{
	public void SetCavityDetuningGeneratorOffset(double offset)
	{
		State.CavityDetuningGeneratorOffset = offset;
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
