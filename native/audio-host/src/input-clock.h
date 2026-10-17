#pragma once
#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <vector>

namespace bb {
// Separate endpoint clocks are bridged even when both report the same rate.
// Producer: capture callback. Consumer: output callback. Indices are monotonic;
// only the consumer advances read_. A full FIFO never overwrites unread audio.
class InputClockBridge {
 public:
  InputClockBridge(unsigned inputRate, unsigned outputRate, unsigned channels, unsigned quantum)
      : samples_(capacity * channels), channels_(channels), nominal_(double(inputRate) / outputRate),
        target_(std::min<unsigned>(capacity / 4, std::max(quantum * 4, inputRate / 50))) {
    ratio.store(nominal_);
    // Windowed-sinc polyphase coefficients, calculated off the audio thread.
    const double cutoff = std::min(1., 1. / nominal_) * .94;
    for (unsigned p = 0; p < phases; ++p) {
      double sum = 0;
      for (unsigned t = 0; t < taps; ++t) {
        const double x = double(t) - (taps / 2 - 1) - double(p) / phases;
        const double sinc = std::abs(x) < 1e-9 ? cutoff : std::sin(pi * cutoff * x) / (pi * x);
        const double window = .5 + .5 * std::cos(pi * x / (taps / 2));
        coefficients_[p][t] = float(sinc * window); sum += coefficients_[p][t];
      }
      for (auto& c : coefficients_[p]) c = float(c / sum);
    }
  }
  void push(const float* input, unsigned frames, double adcSeconds = 0) noexcept {
    if (!input) return;
    const auto w = write_.load(std::memory_order_relaxed), r = read_.load(std::memory_order_acquire);
    if (frames > capacity - (w - r)) { overflows.fetch_add(1); return; }
    for (unsigned f = 0; f < frames; ++f)
      for (unsigned c = 0; c < channels_; ++c) samples_[((w + f) % capacity) * channels_ + c] = input[f * channels_ + c];
    lastAdcSeconds.store(adcSeconds, std::memory_order_relaxed);
    write_.store(w + frames, std::memory_order_release);
  }
  bool pull(float* output, unsigned frames) noexcept {
    std::fill(output, output + frames * channels_, 0.f);
    const auto w = write_.load(std::memory_order_acquire);
    const double available = double(w) - cursor_;
    levelFrames.store(unsigned(std::max(0., available)));
    if (!started_) {
      if (available < target_ + taps) return false;
      cursor_ = taps / 2; started_ = true;
    }
    // PI water-level servo. Low-pass scheduling jitter and slew at <= 2 ppm
    // per block. Rate correction is bounded; no periodic dropped/duplicated blocks.
    filteredError_ += .002 * ((available - target_) / target_ - filteredError_);
    integral_ = std::clamp(integral_ + filteredError_ * .0000002, -.003, .003);
    const double wanted = std::clamp(filteredError_ * .001 + integral_, -.005, .005);
    correction_ += std::clamp(wanted - correction_, -.000002, .000002);
    ratio.store(nominal_ * (1 + correction_));
    const double step = ratio.load();
    if (cursor_ + frames * step + taps / 2 >= w) { underruns.fetch_add(1); return false; }
    for (unsigned f = 0; f < frames; ++f) {
      const auto center = static_cast<std::uint64_t>(cursor_);
      const auto phase = std::min(phases - 1, unsigned((cursor_ - center) * phases));
      for (unsigned c = 0; c < channels_; ++c) {
        float value = 0;
        for (unsigned t = 0; t < taps; ++t) value += samples_[((center + t - (taps / 2 - 1)) % capacity) * channels_ + c] * coefficients_[phase][t];
        output[f * channels_ + c] = value;
      }
      cursor_ += step;
    }
    read_.store(static_cast<std::uint64_t>(cursor_) - taps / 2, std::memory_order_release);
    return true;
  }
  unsigned latencyFrames() const { return unsigned(std::ceil((target_ + taps / 2) / nominal_)); }
  std::atomic<std::uint64_t> overflows{0}, underruns{0};
  std::atomic<unsigned> levelFrames{0};
  std::atomic<double> ratio{1}, lastAdcSeconds{0};
 private:
  static constexpr unsigned capacity = 65536, taps = 32, phases = 1024;
  static constexpr double pi = 3.14159265358979323846;
  std::vector<float> samples_;
  std::array<std::array<float, taps>, phases> coefficients_{};
  unsigned channels_;
  double nominal_, cursor_ = 0, filteredError_ = 0, integral_ = 0, correction_ = 0;
  unsigned target_;
  bool started_ = false;
  alignas(64) std::atomic<std::uint64_t> write_{0};
  alignas(64) std::atomic<std::uint64_t> read_{0};
};
}
