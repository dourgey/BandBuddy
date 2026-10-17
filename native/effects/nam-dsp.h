#pragma once
#include <algorithm>
#include <array>
#include <cmath>
#include <memory>
#include <vector>

// AudioDSPTools' iPlug compatibility constants. Keep the upstream headers
// intact; this is the same Lanczos boundary used by TONE3000 v0.0.12.
#ifndef DEFAULT_BLOCK_SIZE
#define DEFAULT_BLOCK_SIZE 1024
#endif
namespace iplug { inline constexpr double PI = 3.14159265358979323846; }
#include <dsp/ResamplingContainer/ResamplingContainer.h>

namespace bb {
using NamBoundary = dsp::ResamplingContainer<float, 2, 12>;

inline unsigned namBoundaryLatency(double hostRate, double modelRate, int blockSize) {
  // GetLatency() reports the prefill, excluding residual Lanczos group delay.
  // Measure the complete round trip, just as the reference plugin does.
  NamBoundary probe(modelRate);
  probe.Reset(hostRate, std::max(4096, blockSize));
  const int total = ((probe.GetLatency() + 2 * blockSize) / blockSize + 1) * blockSize;
  std::vector<float> input(total, 0.f), output(total, 0.f);
  input[0] = 1.f;
  auto identity = [](float** in, float** out, int frames) {
    for (int c = 0; c < 2; ++c) std::copy_n(in[c], frames, out[c]);
  };
  // Independent channel storage is required by the stereo resampler.
  auto rightInput = input, rightOutput = output;
  for (int p = 0; p < total; p += blockSize) {
    float* in[] = {input.data() + p, rightInput.data() + p};
    float* out[] = {output.data() + p, rightOutput.data() + p};
    probe.ProcessBlock(in, out, blockSize, identity);
  }
  return unsigned(std::max_element(output.begin(), output.end(),
    [](float a, float b) { return std::abs(a) < std::abs(b); }) - output.begin());
}

struct NamDcBlocker {
  float b = 1.f, a = 0.f;
  std::array<float, 2> state{};
  explicit NamDcBlocker(unsigned rate) {
    // First-order bilinear high-pass, matching JUCE's float coefficients and
    // transposed direct form II at the reference plugin's 5 Hz cutoff.
    const float n = std::tan(float(iplug::PI * 5. / rate));
    b = 1.f / (1.f + n);
    a = b * (n - 1.f);
  }
  float tick(float x, int channel) {
    const float y = b * x + state[channel];
    state[channel] = -b * x - a * y;
    return y;
  }
};
}
