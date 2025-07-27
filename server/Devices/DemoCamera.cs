
public class DemoCamera : Camera
{
	public DemoCamera()
	{
		ImageWidth = 128;
		ImageHeight = 128;
		ImageChannels = 1;
		Buffer = new short[ImageHeight * ImageWidth * ImageChannels];
	}

	override protected void OnStart(CancellationToken cancellationToken)
	{
		Task.Run(() =>
		{
			var random = new Random();
			while (!cancellationToken.IsCancellationRequested)
			{
				for (var i = 0; i < Buffer.Length; i++)
				{
					Buffer[i] = (short)(random.NextDouble() * MaxVal);
				}
				Thread.Sleep(1);
			}
		});
	}
}
