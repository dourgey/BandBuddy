#pragma once
#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <string>
#include <nlohmann/json.hpp>

namespace bb::realtime {
using Json = nlohmann::json;
constexpr unsigned capacity = 96000;
struct Frame { float left = 0, right = 0; double time = 0; };
struct Ring {
  std::array<Frame, capacity> frames{};
  std::atomic<unsigned> read{0}, write{0};
  unsigned size() const {
    const auto r = read.load(std::memory_order_acquire);
    return std::min(capacity, write.load(std::memory_order_acquire) - r);
  }
  bool push(Frame frame) {
    const auto w = write.load(std::memory_order_relaxed);
    if (w - read.load(std::memory_order_acquire) >= capacity) return false;
    frames[w % capacity] = frame; write.store(w + 1, std::memory_order_release); return true;
  }
  bool pop(Frame& frame) {
    const auto r = read.load(std::memory_order_relaxed);
    if (r == write.load(std::memory_order_acquire)) return false;
    frame = frames[r % capacity]; read.store(r + 1, std::memory_order_release); return true;
  }
};
double clockSeconds();
struct Engine {
  Ring input, output;
  unsigned rate = 48000;
  std::atomic<bool> stop{false}, opened{false}, failed{false};
  std::atomic<unsigned> drops{0}, underruns{0}, overflows{0}, clockErrors{0};
  std::atomic<uint64_t> captured{0}, rendered{0}, generated{0};
  std::atomic<double> latency{0}, maxLatency{0};
  std::string error;
  bool started = false, starving = false;
  double readyAt = 0;
  float envelope = 0;
  Frame previous;
  void capture(float l, float r, double time) {
    if (!input.push({l, r, time})) ++drops;
    ++captured;
  }
  Frame render(double time) {
    // Inference publishes a whole hop at once. Merely requiring 40 ms in the
    // queue would start immediately on the first hop and provide no jitter
    // reserve. Delay presentation by 40 ms after the first published frame.
    if (!started && !readyAt && output.size()) readyAt = time + .04;
    if (!started && readyAt && time >= readyAt) started = true;
    Frame f;
    const bool valid = started && output.pop(f);
    if (started && !valid && !starving) ++underruns;
    starving = started && !valid;
    envelope += std::clamp((valid ? 1.f : 0.f) - envelope, -1.f / 128, 1.f / 128);
    if (valid) {
      previous = f; ++rendered;
      const double ms = (time - f.time) * 1000;
      if (ms >= 0 && ms < 10000) { latency.store(ms); if (ms > maxLatency.load()) maxLatency.store(ms); }
      else ++clockErrors;
    }
    f.left = std::clamp(previous.left * envelope, -1.f, 1.f);
    f.right = std::clamp(previous.right * envelope, -1.f, 1.f);
    return f;
  }
};
// Repeatable, low-level broadband probe. The same function is used in Python
// to verify that audio actually arrived through the selected capture device.
inline float probe(uint64_t frame, unsigned rate) {
  const auto n = static_cast<uint32_t>((frame % rate) * 44100 / rate);
  uint32_t x = n * 747796405u + 2891336453u;
  x = ((x >> ((x >> 28u) + 4u)) ^ x) * 277803737u;
  x = (x >> 22u) ^ x;
  return static_cast<float>((double(x) / 4294967295.0 - .5) * .035);
}
Json devices();
void run(Engine& engine, const Json& config);
}
