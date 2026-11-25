using System.Net.Sockets;
using System.Text.RegularExpressions;

public class InnolasState
{
	public string LaserState { get; set; } = "OFF";
}

public class InnolasLaser : DeviceHandlerBase<InnolasState>
{
	private TcpClient Client;
	private StreamWriter Writer;
	private (string command, TaskCompletionSource<string> result)? LaserResponse;
	public InnolasLaser(int remotePort)
	{
		Client = new TcpClient();
		var connectTask = Task.Run(() => Client.Connect("127.0.0.1", remotePort));
		if (!connectTask.Wait(1000)) throw new Exception("Failed to connect to Innolas laser");
		var stream = Client.GetStream();
		var reader = new StreamReader(stream);
		Writer = new StreamWriter(stream) { AutoFlush = true };
		Task.Run(async () =>
		{
			while (true)
			{
				var response = await reader.ReadLineAsync();
				if (response == null)
					break;
				var splitResponse = response.Split('=');
				if (splitResponse.Length != 2) throw new Exception("Invalid response from Innolas laser");
				var command = splitResponse[0];
				var parameter = splitResponse[1];
				if (command == "ERROR" || command == "WARNING")
				{
					Console.WriteLine($"Innolas {command}: {parameter}");
					continue;
				}
				if (command == "LASER_STATE")
				{
					State.LaserState = parameter;
					// SendStateUpdate(new { State.LaserState });
				}

				if (LaserResponse != null && command == LaserResponse.Value.command)
				{
					LaserResponse.Value.result.SetResult(parameter);
				}
				else if (command != "LASER_STATE")
				{
					Console.WriteLine($"Innolas unexpected message {command}: {parameter}");
				}
			}
			reader.Dispose();
		});
		var _ = SendCommand("GET_LASER_STATE");
	}

	public async Task<string?> SendCommand(string command, string? parameter = null)
	{
		var parameterAddition = parameter != null ? $"={parameter}" : "";
		await Writer.WriteLineAsync($"{command}{parameterAddition}");
		if (!command.StartsWith("GET_") && !command.StartsWith("SET_"))
			return null;

		LaserResponse = new(Regex.Replace(command, "^(GET_|SET_)", ""), new());
		return await LaserResponse.Value.result.Task;
	}

	public Task StartLaser() => SendCommand("STARTUP_LASER");
	public Task ShutdownLaser() => SendCommand("STARTUP_LASER");
	public Task SingleShot() => SendCommand("SINGLE_SHOT");

	public async Task StartShooting()
	{
		await SendCommand("FLASHLAMP_ON");
		await SendCommand("SET_SHUTTER_STATE", "OPEN");
	}

	public async Task StopShooting()
	{
		await SendCommand("SET_SHUTTER_STATE", "CLOSE");
		await SendCommand("FLASHLAMP_OFF");
	}

	public override void Dispose()
	{
		Writer.Dispose();
		Client.Close();
		Client.Dispose();
		base.Dispose();
	}
}
