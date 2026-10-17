#pragma once
#include <array>
#include <atomic>
#include <cmath>
#include <complex>
#include <nlohmann/json.hpp>
namespace bb {
class PlaybackEq {
  struct Filter { double b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0; };
  struct Config { std::array<Filter, 10> bands{}; unsigned count = 0; double gain = 1; };
 public:
  void configure(const nlohmann::json& eq, unsigned rate) {
    Config config; std::array<double, 10> centers{};
    if (eq.value("enabled", false)) {
      const auto add = [&](double hz, double gain, double q) {
        if (config.count >= 10) return;
        hz = std::clamp(hz, 20., rate * .49); q = std::clamp(q, .2, 12.); gain = std::clamp(gain, -12., 12.);
        centers[config.count] = hz;
        const double w = 2 * pi * hz / rate, a = std::pow(10., gain / 40), alpha = std::sin(w) / (2 * q), a0 = 1 + alpha / a;
        config.bands[config.count++] = {(1 + alpha * a) / a0, -2 * std::cos(w) / a0, (1 - alpha * a) / a0, -2 * std::cos(w) / a0, (1 - alpha / a) / a0};
      };
      if (eq.value("mode", "graphic") == "graphic") {
        constexpr double frequencies[]{31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000};
        const auto gains = eq.value("graphicGains", std::vector<double>(10, 0));
        for (unsigned i = 0; i < std::min<std::size_t>(10, gains.size()); ++i) add(frequencies[i], gains[i], std::sqrt(2.));
      } else for (const auto& node : eq.value("nodes", nlohmann::json::array())) add(node.value("frequency", 1000.), node.value("gainDb", 0.), node.value("q", 1.));
      double maximum = 1;
      for (unsigned i = 0; i < 512 + config.count; ++i) {
        const auto hz = i < 512 ? std::min(rate * .49, 20 * std::pow(1000., i / 511.)) : centers[i - 512];
        const auto z = std::polar(1., -2 * pi * hz / rate); double magnitude = 1;
        for (unsigned f = 0; f < config.count; ++f) { const auto& b = config.bands[f]; magnitude *= std::abs((b.b0 + b.b1 * z + b.b2 * z * z) / (1. + b.a1 * z + b.a2 * z * z)); }
        maximum = std::max(maximum, magnitude);
      }
      config.gain = 1 / maximum;
    }
    const auto w = write_.load(); if (w - read_.load(std::memory_order_acquire) >= queue_.size()) throw std::runtime_error("EQ_UPDATE_BUSY");
    queue_[w % queue_.size()] = config; write_.store(w + 1, std::memory_order_release);
  }
  void beginBlock() noexcept {
    const auto w = write_.load(std::memory_order_acquire), r = read_.load();
    if (r != w) { previous_ = current_; previousMemory_ = memory_; current_ = queue_[(w - 1) % queue_.size()]; read_.store(w, std::memory_order_release); fade_ = 0; }
  }
  void sample(float& left, float& right) noexcept {
    const float input[]{left, right}; float output[2]{};
    for (unsigned c = 0; c < 2; ++c) {
      const auto filtered = run(input[c], current_, memory_[c]);
      output[c] = float(fade_ < 1 ? filtered * fade_ + run(input[c], previous_, previousMemory_[c]) * (1 - fade_) : filtered);
    }
    fade_ = std::min(1., fade_ + 1. / 1024); left = output[0]; right = output[1];
  }
 private:
  using Memory = std::array<std::array<double, 2>, 10>;
  static double run(double value, const Config& config, Memory& memory) noexcept {
    for (unsigned i = 0; i < config.count; ++i) { const auto& b = config.bands[i]; auto& s = memory[i]; const auto output = value * b.b0 + s[0]; s[0] = value * b.b1 - output * b.a1 + s[1]; s[1] = value * b.b2 - output * b.a2; value = output; }
    return value * config.gain;
  }
  static constexpr double pi = 3.14159265358979323846;
  Config current_, previous_; std::array<Memory, 2> memory_{}, previousMemory_{}; double fade_ = 1;
  std::array<Config, 32> queue_; std::atomic<unsigned> read_{0}, write_{0};
};
}
