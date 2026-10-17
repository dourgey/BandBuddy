#pragma once
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <nlohmann/json.hpp>

namespace bb {
// One instance per output stream. No allocation, locks or logging in finish().
class OutputSafety {
 public:
  std::atomic<std::uint64_t> callbacks{0}, inputOverflows{0}, outputUnderflows{0};
  std::atomic<std::uint64_t> invalidSamples{0}, limitedFrames{0}, deadlineMisses{0};
  std::atomic<unsigned> actualFrames{0}, minimumFrames{0}, maximumFrames{0};
  std::atomic<double> maximumMicros{0}, peak{0}, reductionDb{0};
  std::array<std::atomic<std::uint64_t>, 32> timing{};

  void finish(float* samples, unsigned frames, unsigned channels, unsigned rate,
              std::chrono::steady_clock::time_point begin) noexcept {
    double blockPeak = 0, minGain = 1;
    std::uint64_t invalid = 0, limited = 0;
    // Stereo-linked instantaneous attack and 50 ms release; independent pairs
    // retain their hardware routing. The last clamp is a finite hard ceiling.
    const float release = 1.f - std::exp(-1.f / std::max(1.f, rate * .05f));
    if (samples) for (unsigned f = 0; f < frames; ++f) {
      for (unsigned c = 0; c < channels; c += 2) {
        const unsigned pair = std::min<unsigned>(c / 2, gains_.size() - 1);
        float p = 0;
        for (unsigned j = c; j < std::min(c + 2, channels); ++j) {
          auto& v = samples[f * channels + j];
          if (!std::isfinite(v)) { v = 0; ++invalid; }
          p = std::max(p, std::abs(v));
        }
        const float target = p > .98f ? .98f / p : 1.f;
        auto& gain = gains_[pair];
        gain = target < gain ? target : gain + release * (target - gain);
        minGain = std::min(minGain, double(gain));
        if (target < 1) ++limited;
        for (unsigned j = c; j < std::min(c + 2, channels); ++j) {
          auto& v = samples[f * channels + j];
          v = std::clamp(v * gain, -.98f, .98f);
          blockPeak = std::max(blockPeak, double(std::abs(v)));
        }
      }
    }
    invalidSamples.fetch_add(invalid, std::memory_order_relaxed);
    limitedFrames.fetch_add(limited, std::memory_order_relaxed);
    peak.store(blockPeak, std::memory_order_relaxed);
    reductionDb.store(-20 * std::log10(std::max(1e-12, minGain)), std::memory_order_relaxed);
    const double us = std::chrono::duration<double, std::micro>(std::chrono::steady_clock::now() - begin).count();
    unsigned bucket = 0; double ceiling = 1;
    while (us > ceiling && bucket < 31) { ++bucket; ceiling *= 2; }
    timing[bucket].fetch_add(1, std::memory_order_relaxed);
    callbacks.fetch_add(1, std::memory_order_relaxed);
    if (us > frames * 1e6 / std::max(1u, rate)) deadlineMisses.fetch_add(1, std::memory_order_relaxed);
    if (us > maximumMicros.load(std::memory_order_relaxed)) maximumMicros.store(us, std::memory_order_relaxed);
    actualFrames.store(frames, std::memory_order_relaxed);
    if (!minimumFrames.load() || frames < minimumFrames.load()) minimumFrames.store(frames);
    if (frames > maximumFrames.load()) maximumFrames.store(frames);
  }
  nlohmann::json snapshot() const {
    const auto n = callbacks.load();
    const auto percentile = [&](double p) {
      std::uint64_t sum = 0;
      for (unsigned i = 0; i < timing.size(); ++i) {
        sum += timing[i].load();
        if (sum >= std::max<std::uint64_t>(1, static_cast<std::uint64_t>(std::ceil(n * p)))) return std::ldexp(1., i);
      }
      return 0.;
    };
    return {{"callbacks", n}, {"callbackMaxUs", maximumMicros.load()},
      {"callbackP99UpperUs", percentile(.99)}, {"callbackP999UpperUs", percentile(.999)},
      {"callbackDeadlineMisses", deadlineMisses.load()}, {"actualBufferFrames", actualFrames.load()},
      {"minBufferFrames", minimumFrames.load()}, {"maxBufferFrames", maximumFrames.load()},
      {"inputOverflows", inputOverflows.load()}, {"outputUnderflows", outputUnderflows.load()},
      {"invalidSamples", invalidSamples.load()}, {"limitedFrames", limitedFrames.load()},
      {"finalPeak", peak.load()}, {"limiterReductionDb", reductionDb.load()}};
  }
 private:
  std::array<float, 32> gains_ = [] { std::array<float, 32> a{}; a.fill(1); return a; }();
};

struct OutputCallbackScope {
  OutputSafety& safety;
  float* output;
  unsigned frames, channels, rate;
  std::chrono::steady_clock::time_point begin = std::chrono::steady_clock::now();
  ~OutputCallbackScope() { safety.finish(output, frames, channels, rate, begin); }
};
}
