using System.Numerics;
using NumSharp.Utilities;

public static class SignalUtils
{
	public static (T[] signal, float xMin, float xMax) DecimateSignal<T>(T[] signal, float xMin, float xMax, float xStart, float xEnd, int maxSamples) where T : INumber<T>
	{
		if (xMax == xMin || signal.Length < 2) return (Array.Empty<T>(), xMin, xMin);
		if (xStart < xMin) xStart = xMin;
		if (xEnd > xMax) xEnd = xMax;
		var dx = (xMax - xMin) / (signal.Length - 1);
		var iStart = (int)Math.Floor((xStart - xMin) / dx);
		var count = (int)Math.Ceiling((xEnd - xStart) / dx);

		var decimation = (int)(2 * count / maxSamples);
		if (decimation <= 2)
		{
			return (signal.Slice(iStart, iStart + count), xMin + iStart * dx, xMin + (iStart + count - 1) * dx);
		}
		iStart = Math.Max(0, iStart - decimation / 2);
		count = Math.Min(signal.Length - iStart, count + decimation);
		var decimatedSignal = new T[2 * count / decimation];
		T minVal = signal[iStart];
		T maxVal = signal[iStart];
		for (var i = 1; i < count; i++)
		{
			var val = signal[i + iStart];
			if (val < minVal) minVal = val;
			if (val > maxVal) maxVal = val;
			if ((i % decimation) == decimation - 1)
			{
				decimatedSignal[2 * (i / decimation)] = minVal;
				decimatedSignal[2 * (i / decimation) + 1] = maxVal;
				if (i + iStart + 1 < signal.Length)
				{
					val = signal[i + iStart + 1];
					minVal = val;
					maxVal = val;
					i++;
				}
			}
		}
		return (decimatedSignal, xMin + (iStart + (decimation - 1) / 2f) * dx, xMin + (iStart + count - 1 - (decimation - 1) / 2f) * dx);
	}
}
