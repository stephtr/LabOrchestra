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
	private TaskCompletionSource<(string command, string parameter)>? LaserResponse;
	public InnolasLaser(string host, int port)
	{
		Client = new TcpClient();
		var connectTask = Task.Run(() => Client.Connect(host, port));
		if (!connectTask.Wait(1000)) throw new Exception("Failed to connect to Innolas laser");
		var stream = Client.GetStream();
		var reader = new StreamReader(stream);
		Writer = new StreamWriter(stream);
		Task.Run(async () =>
		{
			while (true)
			{
				var response = await reader.ReadLineAsync();
				if (response == null) break;
				var splitResponse = response.Split('=');
				if (splitResponse.Length != 2) throw new Exception("Invalid response from Innolas laser");
				var command = splitResponse[0];
				var parameter = splitResponse[1];
				if (command == "ERROR" || command == "WARNING")
				{
					Console.WriteLine($"Innolas {command}: {parameter}");
				}
				else if (LaserResponse != null)
				{
					LaserResponse.SetResult((command, parameter));
				}
				else
				{
					Console.WriteLine($"Innolas unexpected message {command}: {parameter}");
				}
			}
			reader.Dispose();
		});
	}

	public async Task<string?> SendCommand(string command, string? parameter = null)
	{
		var parameterAddition = parameter != null ? $"={parameter}" : "";
		await Writer.WriteLineAsync($"{command}{parameterAddition}");
		if (!command.StartsWith("GET_") && !command.StartsWith("SET_"))
			return null;

		var valueName = Regex.Replace(command, "^(GET_|SET_)", "");
		LaserResponse = new();
		var (responseCommand, responseValue) = await LaserResponse.Task;
		if (responseCommand != valueName) throw new Exception("Failed to wait for response from Innolas laser");
		return responseValue;
	}

	public Task StartLaser() => SendCommand("STARTUP_LASER");
	public Task ShutdownLaser() => SendCommand("STARTUP_LASER");

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

	public async Task UpdateLaserState()
	{
		State.LaserState = (await SendCommand("GET_LASER_STATE"))!;
		SendStateUpdate(new { State.LaserState });
	}

	public override void Dispose()
	{
		Writer.Dispose();
		Client.Close();
		Client.Dispose();
		base.Dispose();
	}
}
