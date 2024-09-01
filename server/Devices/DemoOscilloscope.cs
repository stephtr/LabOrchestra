public class DemoOscilloscope : OscilloscopeWithStreaming
{
	override protected void OnStart(CancellationToken cancellationToken)
	{
		Dt = 1 / 2f / State.FFTFrequency;
		Df = 1 / (2 * Dt) / (State.FFTLength / 2);

		var buffer_length = 65536u;

		Task.Run(() =>
		{
			var random = new Random();
			var values = new float[buffer_length];
			while (!cancellationToken.IsCancellationRequested)
			{
				lock (this)
				{
					for (var i = 0; i < 1000; i++)
					{
						while (Buffer[0].Count > Buffer[0].Capacity / 2)
						{
							Thread.Sleep(1);
						}
						for (var ch = 0; ch < 4; ch++)
						{
							for (var j = 0; j < values.Length; j++)
							{
								values[j] = random.NextSingle();
							}
							Buffer[ch].Push(values, values.Length);
							RecordingBuffer[ch].Push(values, values.Length);
						}
						Thread.Sleep(0);
					}
				}
			}
		});
	}
}
