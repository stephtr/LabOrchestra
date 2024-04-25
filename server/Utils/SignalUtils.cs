using System.Numerics;

public static class SignalUtils
{
	public static (T[] signal, float xMin, float xMax) DecimateSignal<T>(T[] signal, float xMin, float xMax, float xStart, float xEnd, int maxSamples) where T : INumber<T>
	{
		if (xStart < xMin) xStart = xMin;
		if (xEnd > xMax) xEnd = xMax;
		var dx = (xMax - xMin) / (signal.Length - 1);
		var iStart = (int)Math.Floor((xStart - xMin) / dx);
		var count = (int)Math.Ceiling((xEnd - xStart) / dx);

		var decimation = (int)(count / maxSamples);
		if (decimation <= 1)
		{
			return (signal.Skip(iStart).Take(count).ToArray(), xMin + iStart * dx, xMin + (iStart + count - 1) * dx);
		}
		iStart = Math.Max(0, iStart - decimation / 2);
		count = Math.Min(signal.Length - iStart, count + decimation);
		var decimatedSignal = new T[count / decimation];
		T buffer = T.Zero;
		var decimationAsT = T.CreateChecked(decimation);
		for (var i = 0; i < count; i++)
		{
			buffer += signal[i + iStart];
			if ((i % decimation) == decimation - 1)
			{
				decimatedSignal[i / decimation] = buffer / decimationAsT;
				buffer = T.Zero;
			}
		}
		return (decimatedSignal, xMin + (iStart + (decimation - 1) / 2f) * dx, xMin + (iStart + count - 1 - (decimation - 1) / 2f) * dx);
	}
}
