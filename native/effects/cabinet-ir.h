#pragma once
#include <algorithm>
#include <array>
#include <cmath>
#include <complex>
#include <stdexcept>
#include <vector>

namespace bb::cabinet {
// Real-input, half-spectrum partitioned convolution. All storage and FFT plans
// are built off the audio thread. process() neither allocates nor evaluates trig.
template<size_t Block> class Partitioned {
  static constexpr size_t F = Block * 2;
  using C = std::complex<float>;
  using Spectrum = std::array<C, Block + 1>;
  std::vector<Spectrum> kernels, history;
  std::array<C, F> scratch{}, sum{}, roots{};
  std::array<size_t, F> reversed{};
  std::array<float, Block> overlap{};
  size_t cursor = 0;
  void fft(std::array<C, F>& data, bool inverse) {
    for (size_t i = 0; i < F; ++i) if (i < reversed[i]) std::swap(data[i], data[reversed[i]]);
    for (size_t n = 2; n <= F; n *= 2) for (size_t i = 0; i < F; i += n)
      for (size_t j = 0; j < n / 2; ++j) {
        const auto w = inverse ? std::conj(roots[j * F / n]) : roots[j * F / n];
        const auto a = data[i + j], b = data[i + j + n / 2] * w;
        data[i + j] = a + b; data[i + j + n / 2] = a - b;
      }
    if (inverse) for (auto& v : data) v /= float(F);
  }
public:
  void init(const float* ir, size_t length) {
    cursor = 0; overlap.fill(0);
    kernels.assign((length + Block - 1) / Block, {}); history.assign(kernels.size(), {});
    for (size_t i = 0; i < F; ++i) {
      roots[i] = std::polar(1.f, float(-6.283185307179586 * i / F));
      size_t value = i, reverse = 0;
      for (size_t n = F; n > 1; n /= 2) { reverse = reverse * 2 + (value & 1); value >>= 1; }
      reversed[i] = reverse;
    }
    for (size_t p = 0; p < kernels.size(); ++p) {
      scratch.fill(0);
      for (size_t i = 0; i < Block && p * Block + i < length; ++i) scratch[i] = ir[p * Block + i];
      fft(scratch, false); std::copy_n(scratch.begin(), Block + 1, kernels[p].begin());
    }
  }
  void process(const float* input, float* output) {
    if (kernels.empty()) { std::fill_n(output, Block, 0); return; }
    scratch.fill(0); for (size_t i = 0; i < Block; ++i) scratch[i] = input[i];
    fft(scratch, false); std::copy_n(scratch.begin(), Block + 1, history[cursor].begin());
    sum.fill(0); size_t at = cursor;
    for (size_t p = 0; p < kernels.size(); ++p) {
      for (size_t k = 0; k <= Block; ++k) sum[k] += kernels[p][k] * history[at][k];
      at = at ? at - 1 : history.size() - 1;
    }
    for (size_t k = 1; k < Block; ++k) sum[F - k] = std::conj(sum[k]);
    fft(sum, true);
    for (size_t i = 0; i < Block; ++i) { output[i] = sum[i].real() + overlap[i]; overlap[i] = sum[Block + i].real(); }
    cursor = (cursor + 1) % history.size();
  }
};

class Convolver {
  Partitioned<128> early;
  Partitioned<1024> late;
  std::array<float, 1024> tailInput{}, tailOutput{};
  size_t offset = 0;
  bool hasTail = false, active = false;
public:
  void init(const std::vector<float>& ir) {
    if (ir.empty() || ir.size() > 384000 || std::any_of(ir.begin(), ir.end(), [](float v) { return !std::isfinite(v); }))
      throw std::runtime_error("INVALID_CABINET_IR");
    early.init(ir.data(), std::min<size_t>(1024, ir.size()));
    hasTail = ir.size() > 1024; active = true; offset = 0; tailInput.fill(0); tailOutput.fill(0);
    if (hasTail) late.init(ir.data() + 1024, ir.size() - 1024);
  }
  void process(float* data) {
    if (!active) return;
    if (hasTail) std::copy_n(data, 128, tailInput.begin() + offset);
    early.process(data, data);
    if (hasTail) {
      for (size_t i = 0; i < 128; ++i) data[i] += tailOutput[offset + i];
      offset += 128;
      // The tail's natural 1024-sample buffering equals its kernel offset.
      // No extra delay, discarded tail, worker deadline or callback allocation.
      if (offset == 1024) { late.process(tailInput.data(), tailOutput.data()); offset = 0; }
    }
  }
};

// Offline FIR resampling: preserve tap time, polarity and DC transfer gain.
// This is a filter, not program audio: the interpolation kernel includes fsIn/fsOut.
inline std::vector<float> resampleIr(const std::vector<float>& input, double inRate, double outRate) {
  if (!std::isfinite(inRate) || !std::isfinite(outRate) || inRate < 8000 || inRate > 192000 || outRate < 8000 || outRate > 192000 || input.empty() || input.size() > inRate * 2)
    throw std::runtime_error("INVALID_CABINET_IR_RATE_OR_LENGTH");
  if (inRate == outRate) return input;
  const double ratio = outRate / inRate, cutoff = std::min(1., ratio), radius = 24 / cutoff;
  std::vector<double> result(size_t(std::ceil(input.size() * ratio)), 0.);
  // Normalize each source tap's windowed-sinc weights, including edge taps.
  // This conserves signed tap sums even for zero-DC / phase-cancelling IRs;
  // never peak-normalize separate channels or remove leading silence.
  for (size_t i = 0; i < input.size(); ++i) {
    if (!std::isfinite(input[i])) throw std::runtime_error("INVALID_CABINET_IR");
    if (input[i] == 0) continue;
    const auto first = std::max<long long>(0, (long long)std::ceil((double(i) - radius) * ratio));
    const auto last = std::min<long long>(result.size() - 1, (long long)std::floor((double(i) + radius) * ratio));
    auto weight = [&](long long j) {
      const double d = (j / ratio - i) * cutoff, a = 3.14159265358979323846 * d;
      return (std::abs(a) < 1e-12 ? 1. : std::sin(a) / a) * (.5 + .5 * std::cos(a / 24));
    };
    double norm = 0; for (auto j = first; j <= last; ++j) norm += weight(j);
    for (auto j = first; j <= last; ++j) result[size_t(j)] += input[i] * weight(j) / norm;
  }
  return {result.begin(), result.end()};
}
}
