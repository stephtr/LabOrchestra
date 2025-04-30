using System.Text.Json;
using Python.Runtime;

public class PythonAddon : IAddon
{
	private string Filename;
	private object? Arguments;
	public PythonAddon(string filename, object? arguments = null)
	{
		Filename = filename;
		Arguments = arguments;
	}

	public void DoWork(DeviceManager deviceManager, CancellationToken cancellationToken)
	{
		Task.Run(() =>
		{
			using (Py.GIL())
			{
				var module = Py.CreateScope();
				module.Import("json", "_json");
				module.Set("_get_device_state", (string deviceName) =>
				{
					var device = deviceManager.Devices[deviceName];
					if (device == null) throw new ArgumentException($"Device {deviceName} doesn't exist.");
					return JsonSerializer.Serialize(device.GetState());
				});
				module.Exec("def get_device_state(device_name): return _json.loads(_get_device_state(device_name))");
				module.Set("action", (string deviceId, string? channelId, string actionName, object[]? parameters) => deviceManager.Action(new DeviceAction(deviceId, channelId, actionName, parameters)));
				module.Set("_request", (string deviceId, string? channelId, string actionName, object[]? parameters) => JsonSerializer.Serialize(deviceManager.Request(new DeviceAction(deviceId, channelId, actionName, parameters))));
				module.Exec("def request(device_id, channel_id, action_name, parameters): return _json.loads(_request(device_id, channel_id, action_name, parameters))");
				module.Set("print", (string text) => Console.WriteLine(text));

				if (Arguments != null)
				{
					module.Set("argv", Arguments.ToPython());
				}

				var script = File.ReadAllText(Filename);
				try
				{
					module.Exec(script);
				}
				catch (PythonException e)
				{
					Console.WriteLine($"PythonAddon error: {e.Message}\n{e.StackTrace}");
					throw;
				}
			}
		}, cancellationToken);
	}
}
