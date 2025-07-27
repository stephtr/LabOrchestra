public class CameraState
{
	public bool Running { get; set; }
}

public class CameraStreamData
{
	public byte _Padding { get; set; }
	public required byte[] Image { get; set; }
	public required int ImageWidth { get; set; }
	public required int ImageHeight { get; set; }
	public required int ImageChannels { get; set; }
}

public abstract class Camera : DeviceHandlerBase<CameraState>
{
	abstract protected void OnStart(CancellationToken token);

	protected short MaxVal = 1 << 12 - 1;
	protected short[] Buffer = Array.Empty<short>();
	public int ImageWidth = 0;
	public int ImageHeight = 0;
	public int ImageChannels = 0;

	private void ConvertToRGBAArray(ReadOnlySpan<short> source, int sourceChannels, Span<byte> destination)
	{
		if (sourceChannels == 1)
		{
			for (int i = 0; i < source.Length; i++)
			{
				var j = i * 4;
				var val = (byte)(source[i] / (float)MaxVal * 256);
				destination[j + 0] = val;
				destination[j + 1] = val;
				destination[j + 2] = val;
				destination[j + 3] = 255; // Alpha channel
			}
		}
		else if (sourceChannels == 3)
		{
			for (int i = 0; i < source.Length / 3; i++)
			{
				var j = i * 4;
				destination[j + 0] = (byte)(source[i * 3 + 0] / (float)MaxVal * 256);
				destination[j + 1] = (byte)(source[i * 3 + 1] / (float)MaxVal * 256);
				destination[j + 2] = (byte)(source[i * 3 + 2] / (float)MaxVal * 256);
				destination[j + 3] = 255; // Alpha channel
			}
		}
	}

	private CancellationTokenSource? runCancellationTokenSource = null;
	public void Start()
	{
		if (State.Running) return;
		runCancellationTokenSource = new();

		State.Running = true;

		OnStart(runCancellationTokenSource.Token);

		Task.Run(() =>
		{
			var token = runCancellationTokenSource.Token;
			var lastTransmission = DateTime.MinValue;
			var buffer = new byte[ImageWidth * ImageHeight * 4];
			while (true)
			{
				if (token.IsCancellationRequested) return;
				if (DateTime.UtcNow - lastTransmission < TimeSpan.FromSeconds(1.0 / 30))
				{
					Thread.Sleep(5);
					continue;
				}
				lastTransmission = DateTime.UtcNow;
				ConvertToRGBAArray(new ReadOnlySpan<short>(Buffer), ImageChannels, new Span<byte>(buffer));
				DeviceManager?.SendStreamData(DeviceManager.GetDeviceId(this), new CameraStreamData
				{
					_Padding = 0,
					Image = buffer,
					ImageWidth = ImageWidth,
					ImageHeight = ImageHeight,
					ImageChannels = ImageChannels,
				});
			}
		});
	}

	public void Stop()
	{
		State.Running = false;
		runCancellationTokenSource?.Cancel();
	}

	public override void Dispose()
	{
		State.Running = false;
		runCancellationTokenSource?.Dispose();
	}
}
